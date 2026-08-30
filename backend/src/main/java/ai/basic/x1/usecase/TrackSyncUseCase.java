package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.DatasetDAO;
import ai.basic.x1.adapter.port.dao.SceneLocationDAO;
import ai.basic.x1.adapter.port.dao.SceneLocationSampleDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocation;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocationSample;
import ai.basic.x1.entity.DataAnnotationObjectBO;
import ai.basic.x1.entity.SceneLocationBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.util.DefaultConverter;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * LiDAR Fusion "Sync Mode" propagation engine.
 *
 * When a dataset has {@code syncMode} enabled, tracked (trackId) 3D objects carry a
 * {@code motionMode} in their {@code classAttributes} JSON:
 * <ul>
 *     <li>{@code STATIC} - size + world position + rotation are identical across every frame
 *     of the Scene. Whenever such an object is saved in one frame, this engine re-projects its
 *     world pose (using each frame's stored ego pose from {@code scene_location}) into every
 *     other frame of the Scene, creating/updating a row when the object falls within its
 *     configured sync distance of that frame's ego position, and removing any previously
 *     auto-synced row once it falls out of range.</li>
 *     <li>{@code DYNAMIC_FIXED_SIZE} - by default, only {@code size3D} is kept in sync across
 *     existing rows. Optional dynamic range sync projects complete geometry into a frame window.</li>
 *     <li>{@code DYNAMIC_VARIABLE_SIZE} - by default, geometry stays independent per frame.
 *     Optional dynamic range sync projects complete geometry into a frame window.</li>
 * </ul>
 */
@Slf4j
public class TrackSyncUseCase {

    private static final double DEFAULT_STATIC_SYNC_RADIUS_M = 12.0;
    private static final double DEFAULT_GROUND_POLYLINE_SYNC_RADIUS_M = 15.0;
    private static final int DEFAULT_SYNC_MAX_DISAPPEAR_GAP = 50;
    private static final int DEFAULT_SYNC_LOCATION_GAP_MS = 200;
    private static final int DEFAULT_DYNAMIC_SYNC_PREVIOUS_FRAMES = 1;
    private static final int DEFAULT_DYNAMIC_SYNC_NEXT_FRAMES = 1;
    private static final double POLYLINE_OVERLAP_SNAP_M = 0.2;
    private static final double GEOMETRY_EPSILON = 0.000000001;
    private static final List<String> CAMERA_VIEW_KEYS = List.of("0", "1", "2", "3");

    private static final String MOTION_STATIC = "STATIC";
    private static final String MOTION_DYNAMIC_FIXED_SIZE = "DYNAMIC_FIXED_SIZE";
    private static final String MOTION_DYNAMIC_VARIABLE_SIZE = "DYNAMIC_VARIABLE_SIZE";
    private static final String GROUND_POLYGON = "GROUND_POLYGON";
    private static final String GROUND_POLYLINE = "GROUND_POLYLINE";

    @Autowired
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private SceneLocationDAO sceneLocationDAO;

    @Autowired
    private SceneLocationSampleDAO sceneLocationSampleDAO;

    @Autowired
    private DatasetDAO datasetDAO;

    /**
     * Entry point, called right after a normal save of annotation objects. Scans the just-saved
     * objects for ones that opt into cross-frame sync and, for each, propagates the change across
     * the rest of the Scene.
     */
    @Transactional(rollbackFor = Exception.class)
    public void syncAfterSave(List<DataAnnotationObjectBO> savedObjects) {
        if (CollUtil.isEmpty(savedObjects)) {
            return;
        }
        for (DataAnnotationObjectBO object : savedObjects) {
            try {
                syncOne(object);
            } catch (Exception e) {
                log.error("Sync-mode propagation failed for dataId={}, classAttributes={}",
                        object.getDataId(), object.getClassAttributes(), e);
            }
        }
    }

    /**
     * Explicit Sync Now entry point. Normal Save must stay local-only; callers use this method
     * when the user deliberately asks to propagate one tracked object across the scene.
     */
    @Transactional(rollbackFor = Exception.class)
    public SyncResult syncByDataIdAndTrackId(Long dataId, String trackId) {
        return syncByDataIdAndTrackId(dataId, trackId, null);
    }

    @Transactional(rollbackFor = Exception.class)
    public List<Long> deleteByDataIdAndTrackId(Long dataId, String trackId) {
        if (dataId == null || StrUtil.isBlank(trackId)) {
            throw new IllegalArgumentException("dataId and trackId are required");
        }
        DataInfo sourceFrame = dataInfoDAO.getById(dataId);
        if (sourceFrame == null || sourceFrame.getParentId() == null) {
            throw new IllegalArgumentException(String.format("Scene frame not found: dataId=%s", dataId));
        }
        List<Long> frameIds = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                        .eq(DataInfo::getParentId, sourceFrame.getParentId())
                        .eq(DataInfo::getIsDeleted, false))
                .stream()
                .map(DataInfo::getId)
                .collect(Collectors.toList());
        if (frameIds.isEmpty()) {
            return List.of();
        }
        List<DataAnnotationObject> matched = dataAnnotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .in(DataAnnotationObject::getDataId, frameIds))
                .stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                .collect(Collectors.toList());
        if (matched.isEmpty()) {
            return List.of();
        }
        dataAnnotationObjectDAO.removeBatchByIds(
                matched.stream().map(DataAnnotationObject::getId).collect(Collectors.toList()));
        return matched.stream()
                .map(DataAnnotationObject::getDataId)
                .distinct()
                .collect(Collectors.toList());
    }

    @Transactional(rollbackFor = Exception.class)
    public SyncResult syncByDataIdAndTrackId(Long dataId, String trackId, Long classId) {
        if (ObjectUtil.isNull(dataId) || StrUtil.isBlank(trackId)) {
            return SyncResult.empty();
        }
        var objects = dataAnnotationObjectDAO.list(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .eq(DataAnnotationObject::getDataId, dataId));
        var source = objects.stream()
                .filter(obj -> ObjectUtil.isNotNull(obj.getClassAttributes()))
                .filter(obj -> trackId.equals(obj.getClassAttributes().getStr("trackId")))
                .filter(TrackSyncUseCase::hasSyncableObject)
                .filter(obj -> classId == null || sameClassId(obj, classId))
                .findFirst();
        if (source.isEmpty()) {
            throw new IllegalArgumentException(
                    String.format("No syncable 3D object found: dataId=%s, trackId=%s", dataId, trackId));
        }
        return syncOne(DefaultConverter.convert(source.get(), DataAnnotationObjectBO.class));
    }

    public Map<Long, Integer> findPoseSegments(Long dataId, String trackId) {
        if (ObjectUtil.isNull(dataId) || StrUtil.isBlank(trackId)) {
            return Map.of();
        }
        DataInfo sourceFrame = dataInfoDAO.getById(dataId);
        if (ObjectUtil.isNull(sourceFrame) || ObjectUtil.isNull(sourceFrame.getParentId())) {
            return Map.of();
        }
        DataAnnotationObject source = dataAnnotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .eq(DataAnnotationObject::getDataId, dataId))
                .stream()
                .filter(object -> ObjectUtil.isNotNull(object.getClassAttributes()))
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(TrackSyncUseCase::hasSyncableObject)
                .findFirst()
                .orElse(null);
        if (ObjectUtil.isNull(source)) {
            return Map.of();
        }
        int locationGapMs = getPositiveInt(
                source.getClassAttributes(),
                "syncLocationGapMs",
                DEFAULT_SYNC_LOCATION_GAP_MS);
        List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sourceFrame.getParentId())
                .eq(DataInfo::getIsDeleted, false)
                .orderByAsc(DataInfo::getOrderName));
        return buildSegmentByDataId(sourceFrame.getParentId(), frames, locationGapMs);
    }

    /**
     * Persists a reviewer decision for every existing row of the same track in this scene.
     * Review status is deliberately independent from geometry synchronization.
     */
    @Transactional(rollbackFor = Exception.class)
    public void setReviewedCorrectByDataIdAndTrackId(Long dataId, String trackId, boolean reviewedCorrect) {
        if (ObjectUtil.isNull(dataId) || StrUtil.isBlank(trackId)) {
            return;
        }
        var sourceFrame = dataInfoDAO.getById(dataId);
        if (ObjectUtil.isNull(sourceFrame) || ObjectUtil.isNull(sourceFrame.getParentId())) {
            return;
        }
        var frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sourceFrame.getParentId())
                .eq(DataInfo::getIsDeleted, false));
        if (CollUtil.isEmpty(frames)) {
            return;
        }
        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        var objects = dataAnnotationObjectDAO.list(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .in(DataAnnotationObject::getDataId, frameIds));
        var toUpdate = new ArrayList<DataAnnotationObject>();
        for (var object : objects) {
            JSONObject attrs = object.getClassAttributes();
            if (attrs == null || !trackId.equals(attrs.getStr("trackId"))) {
                continue;
            }
            attrs.set("reviewedCorrect", reviewedCorrect);
            object.setClassAttributes(attrs);
            toUpdate.add(object);
        }
        if (CollUtil.isNotEmpty(toUpdate)) {
            dataAnnotationObjectDAO.getBaseMapper().mysqlInsertOrUpdateBatch(toUpdate);
        }
    }

    private SyncResult syncOne(DataAnnotationObjectBO source) {
        JSONObject attrs = source.getClassAttributes();
        if (ObjectUtil.isNull(attrs) || ObjectUtil.isNull(source.getDatasetId()) || ObjectUtil.isNull(source.getDataId())) {
            return SyncResult.empty();
        }
        String trackId = attrs.getStr("trackId");
        String motionMode = attrs.getStr("motionMode");
        if (StrUtil.isBlank(trackId) || StrUtil.isBlank(motionMode)) {
            return SyncResult.empty();
        }
        if (!MOTION_STATIC.equals(motionMode)
                && !MOTION_DYNAMIC_FIXED_SIZE.equals(motionMode)
                && !MOTION_DYNAMIC_VARIABLE_SIZE.equals(motionMode)) {
            return SyncResult.empty();
        }

        var dataset = datasetDAO.getById(source.getDatasetId());
        if (ObjectUtil.isNull(dataset) || !Boolean.TRUE.equals(dataset.getSyncMode())) {
            return SyncResult.empty();
        }

        var sourceFrame = dataInfoDAO.getById(source.getDataId());
        if (ObjectUtil.isNull(sourceFrame) || ObjectUtil.isNull(sourceFrame.getParentId())) {
            return SyncResult.empty();
        }
        Long sceneId = sourceFrame.getParentId();

        var frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sceneId)
                .eq(DataInfo::getIsDeleted, false)
                .orderByAsc(DataInfo::getOrderName));
        if (CollUtil.isEmpty(frames)) {
            return SyncResult.empty();
        }
        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        // One scene-wide annotation read is shared by every sync mode. Ground shapes used to
        // issue a second identical query after poses had already been loaded.
        var existingObjects = dataAnnotationObjectDAO.list(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .in(DataAnnotationObject::getDataId, frameIds));

        Map<Long, Pose> poseByDataId = buildPoseByDataId(sceneId, frames, frameIds);
        int locationGapMs = getPositiveInt(attrs, "syncLocationGapMs", DEFAULT_SYNC_LOCATION_GAP_MS);
        Map<Long, Integer> segmentByDataId = buildSegmentByDataId(sceneId, frames, locationGapMs);

        boolean syncWorldVertical = useWorldVerticalSync(attrs);
        if (isGroundPolygon(attrs) && MOTION_STATIC.equals(motionMode)) {
            requireScenePose(poseByDataId, source.getDataId());
            double syncRadius = getPositiveDouble(attrs, "syncDistance", DEFAULT_STATIC_SYNC_RADIUS_M);
            return syncGroundPolygon(
                    source, trackId, syncRadius, frames, poseByDataId, syncWorldVertical, existingObjects);
        }
        if (isGroundPolyline(attrs)) {
            if (MOTION_STATIC.equals(motionMode)) {
                requireScenePose(poseByDataId, source.getDataId());
                double syncRadius = getPositiveDouble(
                        attrs, "syncDistance", DEFAULT_GROUND_POLYLINE_SYNC_RADIUS_M);
                return syncGroundPolyline(
                        source, trackId, syncRadius, frames, poseByDataId, syncWorldVertical, existingObjects);
            }
            return SyncResult.empty();
        }

        // existing annotation rows across the whole scene, so we can decide insert vs update vs delete
        var existingRows = collectExistingRows(existingObjects, trackId, source);
        Map<Long, DataAnnotationObject> existingByDataId = existingRows.byDataId;
        boolean segmentsInitialized = getBoolean(attrs, "syncPoseSegmentsInitialized", false)
                || existingByDataId.values().stream()
                .map(DataAnnotationObject::getClassAttributes)
                .filter(ObjectUtil::isNotNull)
                .anyMatch(existingAttrs -> getBoolean(existingAttrs, "syncPoseSegmentsInitialized", false));
        int maxDisappearGap = getNonNegativeInt(
                attrs,
                "syncMaxDisappearGap",
                DEFAULT_SYNC_MAX_DISAPPEAR_GAP
        );
        Set<Long> reachableFrameIds =
                computeReachableFrameIds(source.getDataId(), frames, existingByDataId, maxDisappearGap);
        boolean dynamicRangeSyncEnabled = getBoolean(attrs, "dynamicRangeSyncEnabled", false);
        int dynamicSyncPreviousFrames = getNonNegativeInt(
                attrs,
                "dynamicSyncPreviousFrames",
                DEFAULT_DYNAMIC_SYNC_PREVIOUS_FRAMES);
        int dynamicSyncNextFrames = getNonNegativeInt(
                attrs,
                "dynamicSyncNextFrames",
                DEFAULT_DYNAMIC_SYNC_NEXT_FRAMES);

        if (MOTION_DYNAMIC_VARIABLE_SIZE.equals(motionMode) && !dynamicRangeSyncEnabled) {
            return syncMotionModeOnly(
                    source,
                    motionMode,
                    frames,
                    existingByDataId,
                    existingRows.duplicateObjectIds,
                    segmentByDataId,
                    locationGapMs,
                    maxDisappearGap
            );
        }

        JSONObject contour = attrs.getJSONObject("contour");
        JSONObject center3D = contour == null ? null : contour.getJSONObject("center3D");
        JSONObject size3D = contour == null ? null : contour.getJSONObject("size3D");
        if (center3D == null || size3D == null) {
            // not a 3D_BOX object (e.g. a 2D_RECT/2D_BOX projection row sharing the trackId)
            return SyncResult.empty();
        }

        if (MOTION_STATIC.equals(motionMode)) {
            requireScenePose(poseByDataId, source.getDataId());
            double syncRadius = getPositiveDouble(attrs, "syncDistance", DEFAULT_STATIC_SYNC_RADIUS_M);
            boolean syncUseZ = getBoolean(attrs, "syncUseZ", true);
            double syncYawOffset = Math.toRadians(getDouble(attrs, "syncYawOffsetDeg"));
            double syncXOffset = getDouble(attrs, "syncXOffsetM");
            double syncYOffset = getDouble(attrs, "syncYOffsetM");
            return syncStatic(source, trackId, center3D, size3D, contour.getJSONObject("rotation3D"),
                    syncRadius, syncUseZ, syncWorldVertical, syncYawOffset, syncXOffset, syncYOffset, frames,
                    poseByDataId, existingByDataId, existingRows.duplicateObjectIds, reachableFrameIds,
                    maxDisappearGap, segmentByDataId, locationGapMs, segmentsInitialized);
        } else if (dynamicRangeSyncEnabled) {
            requireScenePose(poseByDataId, source.getDataId());
            boolean syncUseZ = getBoolean(attrs, "syncUseZ", true);
            return syncDynamicRange(
                    source,
                    trackId,
                    motionMode,
                    center3D,
                    size3D,
                    contour.getJSONObject("rotation3D"),
                    frames,
                    poseByDataId,
                    existingByDataId,
                    existingRows,
                    dynamicSyncPreviousFrames,
                    dynamicSyncNextFrames,
                    maxDisappearGap,
                    segmentByDataId,
                    locationGapMs,
                    syncUseZ,
                    syncWorldVertical
            );
        } else {
            return syncFixedSize(
                    source,
                    size3D,
                    frames,
                    existingByDataId,
                    existingRows.duplicateObjectIds,
                    maxDisappearGap,
                    segmentByDataId,
                    locationGapMs
            );
        }
    }

    private SyncResult syncDynamicRange(
            DataAnnotationObjectBO source,
            String trackId,
            String motionMode,
            JSONObject center3D,
            JSONObject size3D,
            JSONObject rotation3D,
            List<DataInfo> frames,
            Map<Long, Pose> poseByDataId,
            Map<Long, DataAnnotationObject> existingByDataId,
            ExistingRows existingRows,
            int previousFrames,
            int nextFrames,
            int maxDisappearGap,
            Map<Long, Integer> segmentByDataId,
            int locationGapMs,
            boolean syncUseZ,
            boolean syncWorldVertical) {
        int sourceIndex = findFrameIndex(frames, source.getDataId());
        Pose sourcePose = poseByDataId.get(source.getDataId());
        if (sourceIndex < 0 || sourcePose == null || !sourcePose.complete) {
            throw new IllegalStateException(String.format(
                    "Dynamic range sync requires source pose: dataId=%s, trackId=%s",
                    source.getDataId(),
                    trackId));
        }

        List<Integer> windowIndexes = dynamicWindowIndexes(
                frames.size(), sourceIndex, previousFrames, nextFrames);
        Set<Long> windowFrameIds = windowIndexes.stream()
                .map(index -> frames.get(index).getId())
                .collect(Collectors.toSet());
        var toInsert = new ArrayList<DataAnnotationObject>();
        var toUpdate = new ArrayList<DataAnnotationObject>();
        var toDeleteIds = existingRows.duplicateDataIdByObjectId.entrySet().stream()
                .filter(entry -> windowFrameIds.contains(entry.getValue()))
                .map(Map.Entry::getKey)
                .collect(Collectors.toList());

        double localX = getDouble(center3D, "x");
        double localY = getDouble(center3D, "y");
        double localZ = getDouble(center3D, "z");
        double rotX = rotation3D == null ? 0 : getDouble(rotation3D, "x");
        double rotY = rotation3D == null ? 0 : getDouble(rotation3D, "y");
        double localYaw = rotation3D == null ? 0 : getDouble(rotation3D, "z");

        for (Integer frameIndex : windowIndexes) {
            DataInfo frame = frames.get(frameIndex);
            Pose targetPose = poseByDataId.get(frame.getId());
            if (targetPose == null || !targetPose.complete) {
                log.warn("Dynamic range sync skipped target without pose: sourceDataId={}, targetDataId={}, trackId={}",
                        source.getDataId(), frame.getId(), trackId);
                continue;
            }
            ProjectedPose projected = projectPose(
                    localX, localY, localZ, localYaw, sourcePose, targetPose, syncUseZ, syncWorldVertical);
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            JSONObject newAttrs = existing == null
                    ? JSONUtil.parseObj(JSONUtil.toJsonStr(source.getClassAttributes()))
                    : JSONUtil.parseObj(JSONUtil.toJsonStr(existing.getClassAttributes()));
            stripFrameLocalVisibilityAttrs(newAttrs, existing != null);
            JSONObject newContour = newAttrs.getJSONObject("contour");
            if (newContour == null) {
                newContour = new JSONObject();
                newAttrs.set("contour", newContour);
            }
            newContour.set("size3D", JSONUtil.parseObj(JSONUtil.toJsonStr(size3D)));
            newContour.set("center3D", point3D(projected.x, projected.y, projected.z));
            newContour.set("rotation3D", point3D(rotX, rotY, projected.yaw));
            newAttrs.set("trackId", trackId);
            updateDynamicMetadata(
                    newAttrs,
                    source,
                    motionMode,
                    previousFrames,
                    nextFrames,
                    maxDisappearGap,
                    segmentByDataId.get(frame.getId()),
                    locationGapMs,
                    syncUseZ,
                    syncWorldVertical);

            if (existing != null) {
                existing.setClassId(source.getClassId());
                existing.setClassAttributes(newAttrs);
                toUpdate.add(existing);
            } else {
                toInsert.add(DataAnnotationObject.builder()
                        .datasetId(source.getDatasetId())
                        .dataId(frame.getId())
                        .classId(source.getClassId())
                        .classAttributes(newAttrs)
                        .sourceId(-1L)
                        .sourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW)
                        .createdAt(OffsetDateTime.now())
                        .createdBy(source.getCreatedBy())
                        .build());
            }
        }
        return applyChanges(toInsert, toUpdate, toDeleteIds);
    }

    private static JSONObject point3D(double x, double y, double z) {
        JSONObject point = new JSONObject();
        point.set("x", x);
        point.set("y", y);
        point.set("z", z);
        return point;
    }

    private void updateDynamicMetadata(
            JSONObject attrs,
            DataAnnotationObjectBO source,
            String motionMode,
            int previousFrames,
            int nextFrames,
            int maxDisappearGap,
            Integer segmentId,
            int locationGapMs,
            boolean syncUseZ,
            boolean syncWorldVertical) {
        attrs.set("classId", source.getClassId());
        attrs.set("motionMode", motionMode);
        attrs.set("dynamicRangeSyncEnabled", true);
        attrs.set("dynamicSyncPreviousFrames", previousFrames);
        attrs.set("dynamicSyncNextFrames", nextFrames);
        attrs.set("syncUseZ", syncUseZ);
        attrs.set("syncWorldVertical", syncWorldVertical);
        updateSyncMetadata(attrs, maxDisappearGap, segmentId, locationGapMs);
    }

    /**
     * Propagate the static four-corner parking footprint to every frame that has a pose.
     * The stored contour remains in each frame's local LiDAR coordinates; world coordinates
     * are used only while transforming between source and target frames.
     */
    private SyncResult syncGroundPolygon(DataAnnotationObjectBO source, String trackId, double syncRadius, List<DataInfo> frames,
                                   Map<Long, Pose> poseByDataId, boolean syncWorldVertical,
                                   List<DataAnnotationObject> existingObjects) {
        JSONObject sourceAttrs = source.getClassAttributes();
        JSONObject sourceContour = sourceAttrs.getJSONObject("contour");
        JSONArray sourcePoints = sourceContour == null ? null : sourceContour.getJSONArray("points");
        if (sourcePoints == null || sourcePoints.size() != 4) {
            throw new IllegalArgumentException(
                    String.format("Parking slot requires exactly four points: dataId=%s, trackId=%s",
                            source.getDataId(), trackId));
        }
        Pose sourcePose = poseByDataId.get(source.getDataId());
        List<double[]> worldPoints = new ArrayList<>(4);
        for (int index = 0; index < 4; index++) {
            JSONObject point = sourcePoints.getJSONObject(index);
            if (point == null) {
                throw new IllegalArgumentException(
                        String.format("Parking slot point is invalid: dataId=%s, index=%s", source.getDataId(), index));
            }
            double localX = getDouble(point, "x");
            double localY = getDouble(point, "y");
            double localZ = getDouble(point, "z");
            double[] worldPoint = localToWorld(localX, localY, localZ, sourcePose, syncWorldVertical);
            worldPoints.add(worldPoint);
        }

        Map<Long, DataAnnotationObject> existingByDataId = existingObjects.stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> sameClass(object, source))
                .filter(object -> isGroundPolygon(object.getClassAttributes()))
                .collect(Collectors.toMap(
                        DataAnnotationObject::getDataId,
                        object -> object,
                        (first, ignored) -> first));

        List<DataAnnotationObject> inserts = new ArrayList<>();
        List<DataAnnotationObject> updates = new ArrayList<>();
        List<Long> deleteIds = new ArrayList<>();
        for (DataInfo frame : frames) {
            Pose targetPose = poseByDataId.get(frame.getId());
            if (targetPose == null || !targetPose.complete) {
                continue;
            }
            JSONObject attrs = JSONUtil.parseObj(JSONUtil.toJsonStr(
                    existingByDataId.containsKey(frame.getId())
                            ? existingByDataId.get(frame.getId()).getClassAttributes()
                            : sourceAttrs));
            JSONObject contour = attrs.getJSONObject("contour");
            if (contour == null) {
                contour = new JSONObject();
                attrs.set("contour", contour);
            }
            JSONArray targetPoints = new JSONArray();
            for (double[] worldPoint : worldPoints) {
                double[] localPoint = worldToLocal(worldPoint[0], worldPoint[1], worldPoint[2], targetPose, syncWorldVertical);
                JSONObject targetPoint = new JSONObject();
                targetPoint.set("x", localPoint[0]);
                targetPoint.set("y", localPoint[1]);
                targetPoint.set("z", localPoint[2]);
                targetPoints.add(targetPoint);
            }
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            if (distanceToGroundShapeFootprint(targetPoints) > syncRadius) {
                if (existing != null) {
                    deleteIds.add(existing.getId());
                }
                continue;
            }
            contour.set("points", targetPoints);
            attrs.set("type", "GROUND_POLYGON");
            attrs.set("trackId", trackId);
            attrs.set("motionMode", MOTION_STATIC);
            attrs.set("syncDistance", syncRadius);
            attrs.set("parkingOpeningEdge", "P3_P0");
            if (existing == null) {
                inserts.add(DataAnnotationObject.builder()
                        .datasetId(source.getDatasetId())
                        .dataId(frame.getId())
                        .classId(source.getClassId())
                        .classAttributes(attrs)
                        .sourceId(-1L)
                        .sourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW)
                        .createdAt(OffsetDateTime.now())
                        .createdBy(source.getCreatedBy())
                        .build());
            } else {
                existing.setClassId(source.getClassId());
                existing.setClassAttributes(attrs);
                updates.add(existing);
            }
        }
        return applyChanges(inserts, updates, deleteIds);
    }

    private SyncResult syncGroundPolyline(DataAnnotationObjectBO source, String trackId, double syncRadius, List<DataInfo> frames,
                                    Map<Long, Pose> poseByDataId, boolean syncWorldVertical,
                                    List<DataAnnotationObject> existingObjects) {
        JSONObject sourceAttrs = source.getClassAttributes();
        JSONObject sourceContour = sourceAttrs.getJSONObject("contour");
        JSONArray sourcePoints = sourceContour == null ? null : sourceContour.getJSONArray("points");
        if (sourcePoints == null) {
            throw new IllegalArgumentException(
                    String.format("Ground polyline points are required: dataId=%s, trackId=%s",
                            source.getDataId(), trackId));
        }
        Pose sourcePose = poseByDataId.get(source.getDataId());
        Map<Long, DataAnnotationObject> existingByDataId = existingObjects.stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> sameClass(object, source))
                .filter(object -> isGroundPolyline(object.getClassAttributes()))
                .collect(Collectors.toMap(
                        DataAnnotationObject::getDataId,
                        object -> object,
                        (first, ignored) -> first));
        int maxDisappearGap = getNonNegativeInt(
                sourceAttrs,
                "syncMaxDisappearGap",
                DEFAULT_SYNC_MAX_DISAPPEAR_GAP);
        Set<Long> reachableFrameIds = computeReachableFrameIds(
                source.getDataId(), frames, existingByDataId, maxDisappearGap);
        double wallHeight = Math.max(0D, getDouble(sourceAttrs, "wallHeight"));
        boolean showSyncLocationBoundaries = getBoolean(
                sourceAttrs, "showSyncLocationBoundaries", false);

        List<DataAnnotationObject> inserts = new ArrayList<>();
        List<DataAnnotationObject> updates = new ArrayList<>();
        List<Long> deleteIds = new ArrayList<>();
        for (DataInfo frame : frames) {
            if (!reachableFrameIds.contains(frame.getId())) {
                continue;
            }
            Pose targetPose = poseByDataId.get(frame.getId());
            if (targetPose == null || !targetPose.complete) {
                continue;
            }
            JSONObject attrs = JSONUtil.parseObj(JSONUtil.toJsonStr(
                    existingByDataId.containsKey(frame.getId())
                            ? existingByDataId.get(frame.getId()).getClassAttributes()
                            : sourceAttrs));
            JSONObject contour = attrs.getJSONObject("contour");
            if (contour == null) {
                contour = new JSONObject();
                attrs.set("contour", contour);
            }
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            JSONArray existingPoints = null;
            if (existing != null && existing.getClassAttributes() != null) {
                JSONObject existingContour = existing.getClassAttributes().getJSONObject("contour");
                existingPoints = existingContour == null ? null : existingContour.getJSONArray("points");
            }
            JSONArray projectedPoints = resolveSyncedGroundPolyline(
                    sourcePoints, sourcePose, existingPoints, targetPose, syncRadius, syncWorldVertical);
            PolylineDistanceMask distanceMask = splitGroundPolylineByRadius(
                    projectedPoints, syncRadius);
            if (isGroundPolylineFullyOutside(distanceMask.outsideSegments)) {
                if (existing != null) {
                    deleteIds.add(existing.getId());
                }
                continue;
            }
            JSONArray visibilityReferencePoints = existingPoints == null
                    ? projectedPoints
                    : existingPoints;
            contour.set("points", distanceMask.points);
            contour.set("segmentVisibilityByView", buildDistanceVisibility(
                    contour.getJSONObject("segmentVisibilityByView"),
                    visibilityReferencePoints,
                    distanceMask.points,
                    distanceMask.outsideSegments));
            attrs.set("type", GROUND_POLYLINE);
            attrs.set("trackId", trackId);
            attrs.set("motionMode", MOTION_STATIC);
            attrs.set("syncDistance", syncRadius);
            attrs.set("syncMaxDisappearGap", maxDisappearGap);
            attrs.set("wallHeight", wallHeight);
            attrs.set("showSyncLocationBoundaries", showSyncLocationBoundaries);
            if (existing == null) {
                inserts.add(DataAnnotationObject.builder()
                        .datasetId(source.getDatasetId())
                        .dataId(frame.getId())
                        .classId(source.getClassId())
                        .classAttributes(attrs)
                        .sourceId(-1L)
                        .sourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW)
                        .createdAt(OffsetDateTime.now())
                        .createdBy(source.getCreatedBy())
                        .build());
            } else {
                existing.setClassId(source.getClassId());
                existing.setClassAttributes(attrs);
                updates.add(existing);
            }
        }
        return applyChanges(inserts, updates, deleteIds);
    }

    static JSONArray projectGroundPoints(JSONArray sourcePoints, Pose sourcePose, Pose targetPose) {
        return projectGroundPoints(sourcePoints, sourcePose, targetPose, true);
    }

    static JSONArray projectGroundPoints(
            JSONArray sourcePoints, Pose sourcePose, Pose targetPose, boolean syncWorldVertical) {
        return polylineToLocal(polylineToWorld(sourcePoints, sourcePose, syncWorldVertical), targetPose, syncWorldVertical);
    }

    static JSONArray polylineToWorld(JSONArray localPoints, Pose pose) {
        return polylineToWorld(localPoints, pose, true);
    }

    static JSONArray polylineToWorld(JSONArray localPoints, Pose pose, boolean syncWorldVertical) {
        JSONArray worldPoints = new JSONArray();
        for (int index = 0; index < localPoints.size(); index++) {
            JSONObject point = requireGroundPoint(localPoints, index);
            double localX = getDouble(point, "x");
            double localY = getDouble(point, "y");
            double localZ = getDouble(point, "z");
            double[] worldPoint = localToWorld(localX, localY, localZ, pose, syncWorldVertical);
            worldPoints.add(point3D(worldPoint[0], worldPoint[1], worldPoint[2]));
        }
        return worldPoints;
    }

    static JSONArray polylineToLocal(JSONArray worldPoints, Pose pose) {
        return polylineToLocal(worldPoints, pose, true);
    }

    static JSONArray polylineToLocal(JSONArray worldPoints, Pose pose, boolean syncWorldVertical) {
        JSONArray localPoints = new JSONArray();
        for (int index = 0; index < worldPoints.size(); index++) {
            JSONObject point = requireGroundPoint(worldPoints, index);
            double[] localPoint = worldToLocal(
                    getDouble(point, "x"),
                    getDouble(point, "y"),
                    getDouble(point, "z"),
                    pose,
                    syncWorldVertical);
            localPoints.add(point3D(localPoint[0], localPoint[1], localPoint[2]));
        }
        return localPoints;
    }

    static JSONArray resolveSyncedGroundPolyline(
            JSONArray sourceLocal,
            Pose sourcePose,
            JSONArray existingTargetLocal,
            Pose targetPose,
            double radius) {
        return resolveSyncedGroundPolyline(sourceLocal, sourcePose, existingTargetLocal, targetPose, radius, false);
    }

    static JSONArray resolveSyncedGroundPolyline(
            JSONArray sourceLocal,
            Pose sourcePose,
            JSONArray existingTargetLocal,
            Pose targetPose,
            double radius,
            boolean syncWorldVertical) {
        JSONArray sourceWorld = polylineToWorld(sourceLocal, sourcePose, syncWorldVertical);
        return polylineToLocal(sourceWorld, targetPose, syncWorldVertical);
    }

    static JSONArray mergeWorldPolylinesPreferringSource(JSONArray existingWorld, JSONArray sourceWorld) {
        if (sourceWorld == null || sourceWorld.isEmpty()) {
            return copyPoints(existingWorld);
        }
        if (existingWorld == null || existingWorld.isEmpty()) {
            return copyPoints(sourceWorld);
        }
        JSONArray alignedExisting = alignPolylineDirection(existingWorld, sourceWorld);
        JSONObject sourceStart = sourceWorld.getJSONObject(0);
        JSONObject sourceEnd = sourceWorld.getJSONObject(sourceWorld.size() - 1);
        double directionX = getDouble(sourceEnd, "x") - getDouble(sourceStart, "x");
        double directionY = getDouble(sourceEnd, "y") - getDouble(sourceStart, "y");
        double lengthSquared = directionX * directionX + directionY * directionY;

        JSONArray prefix = new JSONArray();
        Double prefixJoinZ = null;
        for (int index = 0; index < alignedExisting.size(); index++) {
            JSONObject point = alignedExisting.getJSONObject(index);
            if (distanceToPolyline(point, sourceWorld) <= POLYLINE_OVERLAP_SNAP_M) {
                prefixJoinZ = getDouble(point, "z");
                break;
            }
            if (!isNearSourceAxis(point, sourceStart, directionX, directionY, lengthSquared)) {
                break;
            }
            prefix.add(copyPoint(point));
        }
        if (!prefix.isEmpty()) {
            double referenceZ = prefixJoinZ != null
                    ? prefixJoinZ
                    : getDouble(prefix.getJSONObject(prefix.size() - 1), "z");
            shiftPolylineZ(prefix, getDouble(sourceStart, "z") - referenceZ);
        }

        JSONArray suffix = new JSONArray();
        Double suffixJoinZ = null;
        for (int index = alignedExisting.size() - 1; index >= 0; index--) {
            JSONObject point = alignedExisting.getJSONObject(index);
            if (distanceToPolyline(point, sourceWorld) <= POLYLINE_OVERLAP_SNAP_M) {
                suffixJoinZ = getDouble(point, "z");
                break;
            }
            if (!isNearSourceAxis(point, sourceStart, directionX, directionY, lengthSquared)) {
                break;
            }
            suffix.add(0, copyPoint(point));
        }
        if (!suffix.isEmpty()) {
            double referenceZ = suffixJoinZ != null
                    ? suffixJoinZ
                    : getDouble(suffix.getJSONObject(0), "z");
            shiftPolylineZ(suffix, getDouble(sourceEnd, "z") - referenceZ);
        }

        JSONArray merged = new JSONArray();
        merged.addAll(prefix);
        merged.addAll(copyPoints(sourceWorld));
        merged.addAll(suffix);
        return merged;
    }

    private static void shiftPolylineZ(JSONArray points, double deltaZ) {
        for (int index = 0; index < points.size(); index++) {
            JSONObject point = points.getJSONObject(index);
            point.set("z", getDouble(point, "z") + deltaZ);
        }
    }

    private static boolean isNearSourceAxis(
            JSONObject point,
            JSONObject sourceStart,
            double directionX,
            double directionY,
            double lengthSquared) {
        if (lengthSquared <= GEOMETRY_EPSILON) {
            return squaredDistance(point, sourceStart)
                    <= POLYLINE_OVERLAP_SNAP_M * POLYLINE_OVERLAP_SNAP_M;
        }
        double deltaX = getDouble(point, "x") - getDouble(sourceStart, "x");
        double deltaY = getDouble(point, "y") - getDouble(sourceStart, "y");
        double cross = Math.abs(deltaX * directionY - deltaY * directionX);
        double perpendicularDistance = cross / Math.sqrt(lengthSquared);
        return perpendicularDistance <= POLYLINE_OVERLAP_SNAP_M;
    }

    static PolylineDistanceMask splitGroundPolylineByRadius(JSONArray points, double radius) {
        if (points == null || points.size() < 2) {
            throw new IllegalArgumentException("Ground polyline requires at least two points");
        }
        if (radius <= 0) {
            throw new IllegalArgumentException(String.format(
                    "Ground polyline sync radius must be positive: radius=%s", radius));
        }
        JSONArray splitPoints = new JSONArray();
        splitPoints.add(copyPoint(requireGroundPoint(points, 0)));
        for (int index = 1; index < points.size(); index++) {
            JSONObject start = requireGroundPoint(points, index - 1);
            JSONObject end = requireGroundPoint(points, index);
            List<Double> intersections = circleSegmentIntersections(
                    getDouble(start, "x"),
                    getDouble(start, "y"),
                    getDouble(end, "x"),
                    getDouble(end, "y"),
                    radius);
            for (double parameter : intersections) {
                splitPoints.add(interpolatePoint(start, end, parameter));
            }
            splitPoints.add(copyPoint(end));
        }

        List<Boolean> outsideSegments = new ArrayList<>();
        double radiusSquared = radius * radius;
        for (int index = 1; index < splitPoints.size(); index++) {
            JSONObject start = splitPoints.getJSONObject(index - 1);
            JSONObject end = splitPoints.getJSONObject(index);
            double middleX = (getDouble(start, "x") + getDouble(end, "x")) / 2;
            double middleY = (getDouble(start, "y") + getDouble(end, "y")) / 2;
            outsideSegments.add(
                    middleX * middleX + middleY * middleY > radiusSquared + GEOMETRY_EPSILON);
        }
        return new PolylineDistanceMask(splitPoints, outsideSegments);
    }

    static boolean isGroundPolylineFullyOutside(List<Boolean> outsideSegments) {
        return !outsideSegments.isEmpty() && outsideSegments.stream().allMatch(Boolean.TRUE::equals);
    }

    static JSONObject buildDistanceVisibility(
            JSONObject existingByView,
            JSONArray existingPoints,
            JSONArray targetPoints,
            List<Boolean> outsideSegments) {
        if (targetPoints == null || targetPoints.size() < 2) {
            throw new IllegalArgumentException("Target ground polyline requires at least two points");
        }
        if (outsideSegments == null || outsideSegments.size() != targetPoints.size() - 1) {
            throw new IllegalArgumentException(String.format(
                    "Distance visibility count does not match target segments: points=%s, flags=%s",
                    targetPoints.size(), outsideSegments == null ? null : outsideSegments.size()));
        }
        JSONObject result = new JSONObject();
        for (String viewKey : CAMERA_VIEW_KEYS) {
            boolean[] existingFlags = readSegmentVisibility(
                    existingByView == null ? null : existingByView.getJSONArray(viewKey),
                    existingPoints == null ? 0 : existingPoints.size() - 1);
            JSONArray entries = new JSONArray();
            for (int index = 1; index < targetPoints.size(); index++) {
                JSONObject start = targetPoints.getJSONObject(index - 1);
                JSONObject end = targetPoints.getJSONObject(index);
                int existingIndex = nearestSegmentIndex(
                        (getDouble(start, "x") + getDouble(end, "x")) / 2,
                        (getDouble(start, "y") + getDouble(end, "y")) / 2,
                        existingPoints);
                boolean manuallyVisible = existingIndex < 0 || existingFlags[existingIndex];
                entries.add(new JSONObject()
                        .set("index", index - 1)
                        .set("visible", manuallyVisible && !outsideSegments.get(index - 1)));
            }
            result.set(viewKey, entries);
        }
        JSONArray existingBevEntries = existingByView == null
                ? null
                : existingByView.getJSONArray("bev");
        boolean[] existingBevFlags = readSegmentVisibility(
                existingBevEntries,
                existingPoints == null ? 0 : existingPoints.size() - 1);
        JSONArray bevEntries = new JSONArray();
        for (int index = 1; index < targetPoints.size(); index++) {
            boolean visible;
            if (existingBevEntries != null) {
                JSONObject start = targetPoints.getJSONObject(index - 1);
                JSONObject end = targetPoints.getJSONObject(index);
                int existingIndex = nearestSegmentIndex(
                        (getDouble(start, "x") + getDouble(end, "x")) / 2,
                        (getDouble(start, "y") + getDouble(end, "y")) / 2,
                        existingPoints);
                visible = (existingIndex < 0 || existingBevFlags[existingIndex])
                        && !outsideSegments.get(index - 1);
            } else {
                visible = false;
                for (String viewKey : CAMERA_VIEW_KEYS) {
                    JSONObject entry = result.getJSONArray(viewKey).getJSONObject(index - 1);
                    if (Boolean.TRUE.equals(entry.getBool("visible"))) {
                        visible = true;
                        break;
                    }
                }
            }
            bevEntries.add(new JSONObject()
                    .set("index", index - 1)
                    .set("visible", visible));
        }
        result.set("bev", bevEntries);
        return result;
    }

    private static boolean[] readSegmentVisibility(JSONArray entries, int segmentCount) {
        boolean[] flags = new boolean[Math.max(0, segmentCount)];
        java.util.Arrays.fill(flags, true);
        if (entries == null) {
            return flags;
        }
        for (int index = 0; index < entries.size(); index++) {
            JSONObject entry = entries.getJSONObject(index);
            if (entry == null) {
                continue;
            }
            Integer segmentIndex = entry.getInt("index");
            if (segmentIndex != null && segmentIndex >= 0 && segmentIndex < flags.length) {
                flags[segmentIndex] = !Boolean.FALSE.equals(entry.getBool("visible"));
            }
        }
        return flags;
    }

    private static int nearestSegmentIndex(double pointX, double pointY, JSONArray points) {
        if (points == null || points.size() < 2) {
            return -1;
        }
        int nearestIndex = -1;
        double nearestDistance = Double.POSITIVE_INFINITY;
        for (int index = 1; index < points.size(); index++) {
            JSONObject start = requireGroundPoint(points, index - 1);
            JSONObject end = requireGroundPoint(points, index);
            double distance = distanceToSegment(
                    pointX,
                    pointY,
                    getDouble(start, "x"),
                    getDouble(start, "y"),
                    getDouble(end, "x"),
                    getDouble(end, "y"));
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = index - 1;
            }
        }
        return nearestIndex;
    }

    static JSONArray clipGroundPolylineToRadius(JSONArray points, double radius) {
        if (points == null || points.size() < 2 || radius <= 0) {
            return new JSONArray();
        }
        List<JSONArray> components = new ArrayList<>();
        JSONArray current = new JSONArray();
        for (int index = 1; index < points.size(); index++) {
            JSONArray piece = clipSegmentToRadius(
                    requireGroundPoint(points, index - 1),
                    requireGroundPoint(points, index),
                    radius);
            if (piece.size() < 2) {
                addComponent(components, current);
                current = new JSONArray();
                continue;
            }
            if (!current.isEmpty() && !samePoint(
                    current.getJSONObject(current.size() - 1), piece.getJSONObject(0))) {
                addComponent(components, current);
                current = new JSONArray();
            }
            if (current.isEmpty()) {
                current.addAll(piece);
            } else {
                for (int pieceIndex = 1; pieceIndex < piece.size(); pieceIndex++) {
                    current.add(piece.get(pieceIndex));
                }
            }
        }
        addComponent(components, current);
        JSONArray nearest = new JSONArray();
        double nearestDistance = Double.POSITIVE_INFINITY;
        for (JSONArray component : components) {
            double distance = distanceToGroundShapeFootprint(component);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearest = component;
            }
        }
        return nearest;
    }

    private static JSONArray clipSegmentToRadius(JSONObject start, JSONObject end, double radius) {
        double startX = getDouble(start, "x");
        double startY = getDouble(start, "y");
        double endX = getDouble(end, "x");
        double endY = getDouble(end, "y");
        List<Double> parameters = new ArrayList<>();
        parameters.add(0D);
        parameters.addAll(circleSegmentIntersections(startX, startY, endX, endY, radius));
        parameters.add(1D);
        for (int index = 1; index < parameters.size(); index++) {
            double from = parameters.get(index - 1);
            double to = parameters.get(index);
            double middle = (from + to) / 2;
            double middleX = startX + middle * (endX - startX);
            double middleY = startY + middle * (endY - startY);
            if (Math.hypot(middleX, middleY) <= radius + GEOMETRY_EPSILON) {
                JSONArray piece = new JSONArray();
                piece.add(interpolatePoint(start, end, from));
                piece.add(interpolatePoint(start, end, to));
                return piece;
            }
        }
        return new JSONArray();
    }

    private static List<Double> circleSegmentIntersections(
            double startX, double startY, double endX, double endY, double radius) {
        double deltaX = endX - startX;
        double deltaY = endY - startY;
        double a = deltaX * deltaX + deltaY * deltaY;
        List<Double> intersections = new ArrayList<>();
        if (a <= GEOMETRY_EPSILON) {
            return intersections;
        }
        double b = 2 * (startX * deltaX + startY * deltaY);
        double c = startX * startX + startY * startY - radius * radius;
        double discriminant = b * b - 4 * a * c;
        if (discriminant < 0) {
            return intersections;
        }
        double root = Math.sqrt(Math.max(0, discriminant));
        addIntersection(intersections, (-b - root) / (2 * a));
        addIntersection(intersections, (-b + root) / (2 * a));
        return intersections;
    }

    private static void addIntersection(List<Double> intersections, double parameter) {
        if (parameter <= GEOMETRY_EPSILON || parameter >= 1 - GEOMETRY_EPSILON) {
            return;
        }
        if (intersections.isEmpty()
                || Math.abs(intersections.get(intersections.size() - 1) - parameter) > GEOMETRY_EPSILON) {
            intersections.add(parameter);
        }
    }

    private static JSONObject interpolatePoint(JSONObject start, JSONObject end, double parameter) {
        return point3D(
                getDouble(start, "x") + parameter * (getDouble(end, "x") - getDouble(start, "x")),
                getDouble(start, "y") + parameter * (getDouble(end, "y") - getDouble(start, "y")),
                getDouble(start, "z") + parameter * (getDouble(end, "z") - getDouble(start, "z")));
    }

    private static void addComponent(List<JSONArray> components, JSONArray component) {
        if (component.size() >= 2) {
            components.add(component);
        }
    }

    private static boolean samePoint(JSONObject first, JSONObject second) {
        return Math.abs(getDouble(first, "x") - getDouble(second, "x")) <= GEOMETRY_EPSILON
                && Math.abs(getDouble(first, "y") - getDouble(second, "y")) <= GEOMETRY_EPSILON
                && Math.abs(getDouble(first, "z") - getDouble(second, "z")) <= GEOMETRY_EPSILON;
    }

    private static JSONArray alignPolylineDirection(JSONArray existing, JSONArray source) {
        JSONObject existingStart = existing.getJSONObject(0);
        JSONObject existingEnd = existing.getJSONObject(existing.size() - 1);
        JSONObject sourceStart = source.getJSONObject(0);
        JSONObject sourceEnd = source.getJSONObject(source.size() - 1);
        double aligned = squaredDistance(existingStart, sourceStart) + squaredDistance(existingEnd, sourceEnd);
        double reversed = squaredDistance(existingStart, sourceEnd) + squaredDistance(existingEnd, sourceStart);
        if (aligned <= reversed) {
            return copyPoints(existing);
        }
        JSONArray result = new JSONArray();
        for (int index = existing.size() - 1; index >= 0; index--) {
            result.add(copyPoint(existing.getJSONObject(index)));
        }
        return result;
    }

    private static double squaredDistance(JSONObject first, JSONObject second) {
        double deltaX = getDouble(first, "x") - getDouble(second, "x");
        double deltaY = getDouble(first, "y") - getDouble(second, "y");
        return deltaX * deltaX + deltaY * deltaY;
    }

    private static double distanceToPolyline(JSONObject point, JSONArray polyline) {
        double pointX = getDouble(point, "x");
        double pointY = getDouble(point, "y");
        double distance = Double.POSITIVE_INFINITY;
        for (int index = 0; index < polyline.size(); index++) {
            JSONObject current = polyline.getJSONObject(index);
            distance = Math.min(distance, Math.hypot(
                    pointX - getDouble(current, "x"),
                    pointY - getDouble(current, "y")));
            if (index > 0) {
                JSONObject previous = polyline.getJSONObject(index - 1);
                distance = Math.min(distance, distanceToSegment(
                        pointX, pointY,
                        getDouble(previous, "x"), getDouble(previous, "y"),
                        getDouble(current, "x"), getDouble(current, "y")));
            }
        }
        return distance;
    }

    private static JSONArray copyPoints(JSONArray points) {
        JSONArray copy = new JSONArray();
        if (points == null) {
            return copy;
        }
        for (int index = 0; index < points.size(); index++) {
            copy.add(copyPoint(requireGroundPoint(points, index)));
        }
        return copy;
    }

    private static JSONObject copyPoint(JSONObject point) {
        return point3D(getDouble(point, "x"), getDouble(point, "y"), getDouble(point, "z"));
    }

    private static JSONObject requireGroundPoint(JSONArray points, int index) {
        JSONObject point = points.getJSONObject(index);
        if (point == null) {
            throw new IllegalArgumentException(String.format("Ground shape point is invalid: index=%s", index));
        }
        return point;
    }

    static double distanceToGroundShapeFootprint(JSONArray points) {
        if (points == null || points.isEmpty()) {
            return Double.POSITIVE_INFINITY;
        }
        double distance = Double.POSITIVE_INFINITY;
        for (int index = 0; index < points.size(); index++) {
            JSONObject point = points.getJSONObject(index);
            if (point == null) {
                continue;
            }
            double x = getDouble(point, "x");
            double y = getDouble(point, "y");
            distance = Math.min(distance, Math.hypot(x, y));
            if (index == 0) {
                continue;
            }
            JSONObject previous = points.getJSONObject(index - 1);
            if (previous != null) {
                distance = Math.min(distance, distanceToSegment(
                        0, 0,
                        getDouble(previous, "x"), getDouble(previous, "y"),
                        x, y));
            }
        }
        return distance;
    }

    private static double distanceToSegment(
            double pointX,
            double pointY,
            double startX,
            double startY,
            double endX,
            double endY) {
        double deltaX = endX - startX;
        double deltaY = endY - startY;
        double lengthSquared = deltaX * deltaX + deltaY * deltaY;
        if (lengthSquared <= 0.0000001) {
            return Math.hypot(pointX - startX, pointY - startY);
        }
        double ratio = ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared;
        ratio = Math.max(0, Math.min(1, ratio));
        return Math.hypot(pointX - (startX + ratio * deltaX), pointY - (startY + ratio * deltaY));
    }

    private SyncResult syncStatic(DataAnnotationObjectBO source, String trackId, JSONObject center3D, JSONObject size3D,
                             JSONObject rotation3D, double syncRadius, boolean syncUseZ, boolean syncWorldVertical,
                             double syncYawOffset, double syncXOffset, double syncYOffset, List<DataInfo> frames,
                             Map<Long, Pose> poseByDataId, Map<Long, DataAnnotationObject> existingByDataId,
                             List<Long> duplicateObjectIds, Set<Long> reachableFrameIds, int maxDisappearGap,
                             Map<Long, Integer> segmentByDataId, int locationGapMs, boolean segmentsInitialized) {
        double localX = getDouble(center3D, "x");
        double localY = getDouble(center3D, "y");
        double localZ = getDouble(center3D, "z");
        double localYaw = rotation3D == null ? 0 : getDouble(rotation3D, "z");
        double rotX = rotation3D == null ? 0 : getDouble(rotation3D, "x");
        double rotY = rotation3D == null ? 0 : getDouble(rotation3D, "y");

        Pose srcPose = poseByDataId.get(source.getDataId());
        Pose effectiveSourcePose = withYawOffset(srcPose, syncYawOffset);
        boolean useWorldVertical = syncUseZ;
        double[] worldPoint = effectiveSourcePose == null
                ? new double[]{0, 0, localZ}
                : localToWorld(localX, localY, localZ, effectiveSourcePose, useWorldVertical);
        double worldX = worldPoint[0];
        double worldY = worldPoint[1];
        double worldZ = worldPoint[2];
        double worldYaw = effectiveSourcePose == null ? 0 : localYaw + effectiveSourcePose.yaw;
        Integer sourceSegmentId = segmentByDataId.get(source.getDataId());

        var toInsert = new ArrayList<DataAnnotationObject>();
        var toUpdate = new ArrayList<DataAnnotationObject>();
        var toDeleteIds = new ArrayList<>(duplicateObjectIds);

        for (DataInfo frame : frames) {
            Integer targetSegmentId = segmentByDataId.get(frame.getId());
            var existing = existingByDataId.get(frame.getId());
            boolean sameSegment = ObjectUtil.equal(sourceSegmentId, targetSegmentId);
            boolean canSyncPosition = srcPose != null
                    && poseByDataId.containsKey(frame.getId())
                    && reachableFrameIds.contains(frame.getId())
                    && (!segmentsInitialized || sameSegment);

            if (!canSyncPosition) {
                if (existing != null && ObjectUtil.isNotNull(existing.getClassAttributes())) {
                    JSONObject existingAttrs = existing.getClassAttributes();
                    Object existingSyncDirty = existingAttrs.get("syncDirty");
                    updateStaticMetadata(existingAttrs, source, size3D, syncRadius, syncUseZ, syncWorldVertical,
                            syncYawOffset, syncXOffset, syncYOffset, maxDisappearGap, targetSegmentId, locationGapMs);
                    if (existingSyncDirty == null) {
                        existingAttrs.remove("syncDirty");
                    } else {
                        existingAttrs.set("syncDirty", existingSyncDirty);
                    }
                    existing.setClassId(source.getClassId());
                    existing.setClassAttributes(existingAttrs);
                    toUpdate.add(existing);
                }
                continue;
            }
            if (frame.getId().equals(source.getDataId())) {
                if (existing != null) {
                    JSONObject sourceAttrs = JSONUtil.parseObj(JSONUtil.toJsonStr(source.getClassAttributes()));
                    updateStaticMetadata(sourceAttrs, source, size3D, syncRadius, syncUseZ, syncWorldVertical,
                            syncYawOffset, syncXOffset, syncYOffset, maxDisappearGap, targetSegmentId, locationGapMs);
                    existing.setClassId(source.getClassId());
                    existing.setClassAttributes(sourceAttrs);
                    toUpdate.add(existing);
                }
                continue;
            }

            Pose pose = poseByDataId.get(frame.getId());
            Pose effectiveTargetPose = withYawOffset(pose, syncYawOffset);
            double[] targetLocal = worldToLocal(worldX, worldY, worldZ, effectiveTargetPose, useWorldVertical);
            double tgtLocalX = targetLocal[0] + syncXOffset;
            double tgtLocalY = targetLocal[1] + syncYOffset;
            double tgtLocalZ = syncUseZ ? targetLocal[2] : localZ;
            double tgtLocalYaw = worldYaw - effectiveTargetPose.yaw;
            // Gate by the closest point of the oriented 3D box footprint in the XY plane, not by
            // the box center. A large static object should still be considered nearby if its
            // visible/physical edge is within the configured distance.
            double distance = distanceToBoxFootprint(tgtLocalX, tgtLocalY, tgtLocalYaw, size3D);

            if (distance > syncRadius) {
                if (existing != null && !frame.getId().equals(source.getDataId())) {
                    toDeleteIds.add(existing.getId());
                }
                continue;
            }

            JSONObject newAttrs = existing != null
                    ? JSONUtil.parseObj(JSONUtil.toJsonStr(existing.getClassAttributes()))
                    : JSONUtil.parseObj(JSONUtil.toJsonStr(source.getClassAttributes()));
            stripFrameLocalVisibilityAttrs(newAttrs, existing != null);
            JSONObject newContour = newAttrs.getJSONObject("contour");
            if (newContour == null) {
                newContour = new JSONObject();
                newAttrs.set("contour", newContour);
            }
            JSONObject newCenter = new JSONObject();
            newCenter.set("x", tgtLocalX);
            newCenter.set("y", tgtLocalY);
            newCenter.set("z", tgtLocalZ);
            newContour.set("center3D", newCenter);
            JSONObject newRotation = new JSONObject();
            newRotation.set("x", rotX);
            newRotation.set("y", rotY);
            newRotation.set("z", tgtLocalYaw);
            newContour.set("rotation3D", newRotation);
            newAttrs.set("trackId", trackId);
            updateStaticMetadata(newAttrs, source, size3D, syncRadius, syncUseZ, syncWorldVertical, syncYawOffset,
                    syncXOffset, syncYOffset, maxDisappearGap, targetSegmentId, locationGapMs);

            if (existing != null) {
                existing.setClassId(source.getClassId());
                existing.setClassAttributes(newAttrs);
                toUpdate.add(existing);
            } else {
                toInsert.add(DataAnnotationObject.builder()
                        .datasetId(source.getDatasetId())
                        .dataId(frame.getId())
                        .classId(source.getClassId())
                        .classAttributes(newAttrs)
                        .sourceId(-1L)
                        .sourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW)
                        .createdAt(OffsetDateTime.now())
                        .createdBy(source.getCreatedBy())
                        .build());
            }
        }

        return applyChanges(toInsert, toUpdate, toDeleteIds);
    }

    private void updateStaticMetadata(JSONObject attrs, DataAnnotationObjectBO source, JSONObject size3D,
                                      double syncRadius, boolean syncUseZ, boolean syncWorldVertical,
                                      double syncYawOffset, double syncXOffset, double syncYOffset,
                                      int maxDisappearGap, Integer segmentId, int locationGapMs) {
        JSONObject contour = attrs.getJSONObject("contour");
        if (contour != null) {
            contour.set("size3D", JSONUtil.parseObj(JSONUtil.toJsonStr(size3D)));
        }
        attrs.set("classId", source.getClassId());
        attrs.set("motionMode", MOTION_STATIC);
        attrs.set("syncDistance", syncRadius);
        attrs.set("syncUseZ", syncUseZ);
        attrs.set("syncWorldVertical", syncWorldVertical);
        attrs.set("syncYawOffsetDeg", Math.toDegrees(syncYawOffset));
        attrs.set("syncXOffsetM", syncXOffset);
        attrs.set("syncYOffsetM", syncYOffset);
        updateSyncMetadata(attrs, maxDisappearGap, segmentId, locationGapMs);
    }

    private void stripFrameLocalVisibilityAttrs(JSONObject attrs, boolean keepExistingAttrs) {
        if (attrs == null || keepExistingAttrs) {
            return;
        }
        // Existing rows retain their own frame-local visibility state. Only a newly created
        // synced row starts without source-frame occlusion or other local attributes.
        attrs.remove("occluded");
        JSONObject contour = attrs.getJSONObject("contour");
        if (contour != null) {
            contour.remove("segmentVisibilityByView");
        }
        // A newly auto-created synced row should not inherit source-frame attributes such as
        // Occlusion/Truncation/State. Those are per-frame labels, while Sync only propagates
        // track geometry and sync metadata.
        attrs.set("attrs", new JSONObject());
    }

    private SyncResult syncFixedSize(DataAnnotationObjectBO source, JSONObject size3D, List<DataInfo> frames,
                                Map<Long, DataAnnotationObject> existingByDataId,
                                List<Long> duplicateObjectIds, int maxDisappearGap,
                                Map<Long, Integer> segmentByDataId, int locationGapMs) {
        var toUpdate = new ArrayList<DataAnnotationObject>();
        for (DataInfo frame : frames) {
            var existing = existingByDataId.get(frame.getId());
            if (existing == null || ObjectUtil.isNull(existing.getClassAttributes())) {
                continue;
            }
            JSONObject existingAttrs = existing.getClassAttributes();
            JSONObject existingContour = existingAttrs.getJSONObject("contour");
            if (existingContour == null) {
                continue;
            }
            existingContour.set("size3D", JSONUtil.parseObj(JSONUtil.toJsonStr(size3D)));
            existingAttrs.set("classId", source.getClassId());
            existingAttrs.set("motionMode", MOTION_DYNAMIC_FIXED_SIZE);
            copyDynamicSyncConfiguration(existingAttrs, source.getClassAttributes());
            updateSyncMetadata(existingAttrs, maxDisappearGap, segmentByDataId.get(frame.getId()), locationGapMs);
            existing.setClassId(source.getClassId());
            existing.setClassAttributes(existingAttrs);
            toUpdate.add(existing);
        }
        return applyChanges(new ArrayList<>(), toUpdate, new ArrayList<>(duplicateObjectIds));
    }

    private SyncResult syncMotionModeOnly(DataAnnotationObjectBO source, String motionMode, List<DataInfo> frames,
                                    Map<Long, DataAnnotationObject> existingByDataId,
                                    List<Long> duplicateObjectIds, Map<Long, Integer> segmentByDataId,
                                    int locationGapMs, int maxDisappearGap) {
        var toUpdate = new ArrayList<DataAnnotationObject>();
        for (DataInfo frame : frames) {
            var existing = existingByDataId.get(frame.getId());
            if (existing == null || ObjectUtil.isNull(existing.getClassAttributes())) {
                continue;
            }
            JSONObject existingAttrs = existing.getClassAttributes();
            existingAttrs.set("classId", source.getClassId());
            existingAttrs.set("motionMode", motionMode);
            copyDynamicSyncConfiguration(existingAttrs, source.getClassAttributes());
            updateSyncMetadata(existingAttrs, maxDisappearGap, segmentByDataId.get(frame.getId()), locationGapMs);
            existing.setClassId(source.getClassId());
            existing.setClassAttributes(existingAttrs);
            toUpdate.add(existing);
        }
        return applyChanges(new ArrayList<>(), toUpdate, new ArrayList<>(duplicateObjectIds));
    }

    private static void copyDynamicSyncConfiguration(JSONObject targetAttrs, JSONObject sourceAttrs) {
        targetAttrs.set("dynamicRangeSyncEnabled",
                getBoolean(sourceAttrs, "dynamicRangeSyncEnabled", false));
        targetAttrs.set("dynamicSyncPreviousFrames",
                getNonNegativeInt(sourceAttrs, "dynamicSyncPreviousFrames", DEFAULT_DYNAMIC_SYNC_PREVIOUS_FRAMES));
        targetAttrs.set("dynamicSyncNextFrames",
                getNonNegativeInt(sourceAttrs, "dynamicSyncNextFrames", DEFAULT_DYNAMIC_SYNC_NEXT_FRAMES));
    }

    private void updateSyncMetadata(JSONObject attrs, int maxDisappearGap, Integer segmentId, int locationGapMs) {
        attrs.set("syncPoseSegmentId", segmentId);
        attrs.set("syncPoseSegmentsInitialized", true);
        attrs.set("syncLocationGapMs", locationGapMs);
        attrs.set("syncMaxDisappearGap", maxDisappearGap);
        attrs.set("syncDirty", false);
    }

    private ExistingRows collectExistingRows(List<DataAnnotationObject> existingObjects, String trackId,
                                             DataAnnotationObjectBO source) {
        Long sourceObjectId = source.getId();
        Map<Long, DataAnnotationObject> byDataId = new HashMap<>();
        var duplicateObjectIds = new ArrayList<Long>();
        Map<Long, Long> duplicateDataIdByObjectId = new HashMap<>();
        for (var obj : existingObjects) {
            if (ObjectUtil.isNull(obj.getClassAttributes())) continue;
            if (!sameTrackId(obj.getClassAttributes(), trackId)) continue;
            if (!hasSyncableBox(obj)) continue;
            var current = byDataId.get(obj.getDataId());
            if (current == null) {
                byDataId.put(obj.getDataId(), obj);
                continue;
            }
            var preferred = preferExistingRow(current, obj, sourceObjectId);
            var duplicate = preferred == current ? obj : current;
            if (duplicate.getId() != null && !duplicate.getId().equals(sourceObjectId)) {
                duplicateObjectIds.add(duplicate.getId());
                duplicateDataIdByObjectId.put(duplicate.getId(), duplicate.getDataId());
            }
            byDataId.put(obj.getDataId(), preferred);
        }
        return new ExistingRows(byDataId, duplicateObjectIds, duplicateDataIdByObjectId);
    }

    static boolean sameTrackId(JSONObject attributes, String trackId) {
        return attributes != null
                && StrUtil.isNotBlank(trackId)
                && trackId.equals(attributes.getStr("trackId"));
    }

    private static void requireScenePose(Map<Long, Pose> poseByDataId, Long sourceDataId) {
        if (CollUtil.isEmpty(poseByDataId) || !poseByDataId.containsKey(sourceDataId)) {
            throw new IllegalStateException(
                    "Sync requires scene location data. Upload location/location.txt or re-upload the scene zip.");
        }
    }

    private Map<Long, Pose> buildPoseByDataId(Long sceneId, List<DataInfo> frames, List<Long> frameIds) {
        Map<Long, Pose> poseByDataId = new HashMap<>();
        var samples = sceneLocationSampleDAO.list(Wrappers.lambdaQuery(SceneLocationSample.class)
                .eq(SceneLocationSample::getSceneId, sceneId)
                .orderByAsc(SceneLocationSample::getTimestampNs));

        if (CollUtil.isNotEmpty(samples)) {
            List<LocationPoseInterpolator.TimestampedPoseSample> sortedSamples =
                    LocationPoseInterpolator.toSortedSamples(samples);
            int interpolatedCount = 0;
            int missingTimestampCount = 0;
            List<Map<String, Object>> samplePoses = new ArrayList<>();
            for (DataInfo frame : frames) {
                Long timestampNs = SceneLocationImportService.parseTimestampNs(frame.getName());
                if (timestampNs == null) {
                    missingTimestampCount++;
                    continue;
                }
                double[] pose = LocationPoseInterpolator.interpolatePose(timestampNs, sortedSamples);
                if (pose == null) {
                    continue;
                }
                poseByDataId.put(frame.getId(), poseFromLocationValues(pose));
                interpolatedCount++;
                if (samplePoses.size() < 3) {
                    Map<String, Object> entry = new HashMap<>();
                    entry.put("dataId", frame.getId());
                    entry.put("frameName", frame.getName());
                    entry.put("timestampNs", timestampNs);
                    entry.put("x", pose[0]);
                    entry.put("y", pose[1]);
                    entry.put("z", pose[2]);
                    entry.put("yaw", pose[3]);
                    samplePoses.add(entry);
                }
            }
            // #region agent log
            Map<String, Object> logData = new HashMap<>();
            logData.put("sceneId", sceneId);
            logData.put("poseSource", "sample_interpolation");
            logData.put("sampleCount", samples.size());
            logData.put("interpolatedCount", interpolatedCount);
            logData.put("missingTimestampCount", missingTimestampCount);
            logData.put("samplePoses", samplePoses);
            SyncPoseDebugLog.log("H1", "buildPoseByDataId from samples", logData);
            // #endregion
            return poseByDataId;
        }

        var locations = sceneLocationDAO.list(Wrappers.lambdaQuery(SceneLocation.class)
                .in(SceneLocation::getDataId, frameIds));
        Map<Long, Pose> tablePoseByDataId = new HashMap<>();
        locations.forEach(location -> tablePoseByDataId.put(
                location.getDataId(),
                new Pose(
                        location.getPosX(),
                        location.getPosY(),
                        location.getPosZ(),
                        location.getYaw(),
                        location.getRoll(),
                        location.getPitch())));
        poseByDataId.putAll(tablePoseByDataId);
        // #region agent log
        Map<String, Object> logData = new HashMap<>();
        logData.put("sceneId", sceneId);
        logData.put("poseSource", "scene_location_table");
        logData.put("tableCount", locations.size());
        SyncPoseDebugLog.log("H2", "buildPoseByDataId fallback to table", logData);
        // #endregion
        return poseByDataId;
    }

    private static Double toOptionalAngle(double value) {
        return Double.isNaN(value) ? null : value;
    }

    static Pose poseFromLocationValues(double[] values) {
        return new Pose(
                values[0],
                values[1],
                values[2],
                values[3],
                toOptionalAngle(values[4]),
                toOptionalAngle(values[5]));
    }

    private Map<Long, Integer> buildSegmentByDataId(Long sceneId, List<DataInfo> frames, int locationGapMs) {
        var samples = sceneLocationSampleDAO.list(Wrappers.lambdaQuery(SceneLocationSample.class)
                .eq(SceneLocationSample::getSceneId, sceneId)
                .orderByAsc(SceneLocationSample::getTimestampNs));
        List<Long> sampleTimestamps = samples.stream()
                .map(SceneLocationSample::getTimestampNs)
                .collect(Collectors.toList());
        List<DataInfo> timestampedFrames = new ArrayList<>();
        List<Long> frameTimestamps = new ArrayList<>();
        for (DataInfo frame : frames) {
            Long timestampNs = SceneLocationImportService.parseTimestampNs(frame.getName());
            if (timestampNs == null) {
                continue;
            }
            timestampedFrames.add(frame);
            frameTimestamps.add(timestampNs);
        }
        List<Integer> segmentIds = LocationSegmenter.segmentFrames(
                frameTimestamps,
                sampleTimestamps,
                locationGapMs);
        Map<Long, Integer> segmentByDataId = new HashMap<>();
        for (int index = 0; index < timestampedFrames.size(); index++) {
            segmentByDataId.put(timestampedFrames.get(index).getId(), segmentIds.get(index));
        }
        return segmentByDataId;
    }

    /**
     * Keep propagation within the contiguous track segment around the source frame. A track may
     * disappear while the ego vehicle turns around and later return to a similar pose; continuing
     * the static projection through that gap accumulates pose error and creates false boxes.
     */
    static Set<Long> computeReachableFrameIds(
            Long sourceDataId,
            List<DataInfo> frames,
            Map<Long, DataAnnotationObject> existingByDataId,
            int maxDisappearGap) {
        Set<Long> reachable = new HashSet<>();
        int sourceIndex = -1;
        for (int index = 0; index < frames.size(); index++) {
            if (frames.get(index).getId().equals(sourceDataId)) {
                sourceIndex = index;
                reachable.add(sourceDataId);
                break;
            }
        }
        if (sourceIndex < 0) {
            return reachable;
        }
        addReachableFrames(frames, sourceIndex, -1, existingByDataId, maxDisappearGap, reachable);
        addReachableFrames(frames, sourceIndex, 1, existingByDataId, maxDisappearGap, reachable);
        return reachable;
    }

    private static int findFrameIndex(List<DataInfo> frames, Long dataId) {
        for (int index = 0; index < frames.size(); index++) {
            if (frames.get(index).getId().equals(dataId)) {
                return index;
            }
        }
        return -1;
    }

    static List<Integer> dynamicWindowIndexes(
            int frameCount,
            int sourceIndex,
            int previousFrames,
            int nextFrames) {
        if (frameCount <= 0 || sourceIndex < 0 || sourceIndex >= frameCount) {
            return List.of();
        }
        int safePreviousFrames = Math.max(previousFrames, 0);
        int safeNextFrames = Math.max(nextFrames, 0);
        int firstIndex = Math.max(0, sourceIndex - safePreviousFrames);
        int lastIndex = Math.min(frameCount - 1, sourceIndex + safeNextFrames);
        List<Integer> indexes = new ArrayList<>(lastIndex - firstIndex + 1);
        for (int index = firstIndex; index <= lastIndex; index++) {
            indexes.add(index);
        }
        return indexes;
    }

    static ProjectedPose projectPose(
            double localX,
            double localY,
            double localZ,
            double localYaw,
            Pose sourcePose,
            Pose targetPose,
            boolean syncUseZ) {
        return projectPose(localX, localY, localZ, localYaw, sourcePose, targetPose, syncUseZ, false);
    }

    static ProjectedPose projectPose(
            double localX,
            double localY,
            double localZ,
            double localYaw,
            Pose sourcePose,
            Pose targetPose,
            boolean syncUseZ,
            boolean syncWorldVertical) {
        if (sourcePose == null || targetPose == null || !sourcePose.complete || !targetPose.complete) {
            throw new IllegalArgumentException("Complete source and target poses are required");
        }
        boolean useWorldVertical = syncUseZ;
        double[] worldPoint = localToWorld(localX, localY, localZ, sourcePose, useWorldVertical);
        double[] targetLocal = worldToLocal(worldPoint[0], worldPoint[1], worldPoint[2], targetPose, useWorldVertical);
        if (!syncUseZ) {
            targetLocal[2] = localZ;
        }
        return new ProjectedPose(
                targetLocal[0],
                targetLocal[1],
                targetLocal[2],
                localYaw + sourcePose.yaw - targetPose.yaw);
    }

    /**
     * Ground polylines/polygons always use pose.z together with x/y/yaw so synced geometry
     * matches the same world-fixed transform as 3D boxes when syncUseZ is enabled.
     */
    private static boolean useWorldVerticalSync(JSONObject attrs) {
        return true;
    }

    private static double[] localToWorld(
            double localX,
            double localY,
            double localZ,
            Pose pose,
            boolean useWorldVertical) {
        double yaw = pose.yaw;
        double pitch = useWorldVertical ? pose.pitch : 0;
        double roll = useWorldVertical ? pose.roll : 0;
        double cosYaw = Math.cos(yaw);
        double sinYaw = Math.sin(yaw);
        double cosPitch = Math.cos(pitch);
        double sinPitch = Math.sin(pitch);
        double cosRoll = Math.cos(roll);
        double sinRoll = Math.sin(roll);
        double rxX = localX;
        double rxY = localY * cosRoll - localZ * sinRoll;
        double rxZ = localY * sinRoll + localZ * cosRoll;
        double bodyX = rxX * cosPitch + rxZ * sinPitch;
        double bodyY = rxY;
        double bodyZ = -rxX * sinPitch + rxZ * cosPitch;
        double worldX = pose.x + bodyX * cosYaw - bodyY * sinYaw;
        double worldY = pose.y + bodyX * sinYaw + bodyY * cosYaw;
        double worldZ = useWorldVertical ? pose.z + bodyZ : localZ;
        return new double[]{worldX, worldY, worldZ};
    }

    private static double[] worldToLocal(
            double worldX,
            double worldY,
            double worldZ,
            Pose pose,
            boolean useWorldVertical) {
        double yaw = pose.yaw;
        double pitch = useWorldVertical ? pose.pitch : 0;
        double roll = useWorldVertical ? pose.roll : 0;
        double cosYaw = Math.cos(yaw);
        double sinYaw = Math.sin(yaw);
        double cosPitch = Math.cos(pitch);
        double sinPitch = Math.sin(pitch);
        double cosRoll = Math.cos(roll);
        double sinRoll = Math.sin(roll);
        double deltaX = worldX - pose.x;
        double deltaY = worldY - pose.y;
        double bodyX = deltaX * cosYaw + deltaY * sinYaw;
        double bodyY = -deltaX * sinYaw + deltaY * cosYaw;
        double bodyZ = useWorldVertical ? worldZ - pose.z : worldZ;
        double rxX = bodyX * cosPitch - bodyZ * sinPitch;
        double rxY = bodyY;
        double rxZ = bodyX * sinPitch + bodyZ * cosPitch;
        double localX = rxX;
        double localY = rxY * cosRoll + rxZ * sinRoll;
        double localZ = -rxY * sinRoll + rxZ * cosRoll;
        return new double[]{localX, localY, localZ};
    }

    private static Pose withYawOffset(Pose pose, double syncYawOffset) {
        if (pose == null || syncYawOffset == 0) {
            return pose;
        }
        return new Pose(
                pose.x,
                pose.y,
                pose.z,
                pose.yaw + syncYawOffset,
                pose.explicitRoll ? pose.roll : null,
                pose.pitch,
                pose.explicitRoll,
                pose.explicitPitch);
    }

    private static void addReachableFrames(
            List<DataInfo> frames,
            int sourceIndex,
            int direction,
            Map<Long, DataAnnotationObject> existingByDataId,
            int maxDisappearGap,
            Set<Long> reachable) {
        int disappearedFrames = 0;
        for (int index = sourceIndex + direction; index >= 0 && index < frames.size(); index += direction) {
            Long frameId = frames.get(index).getId();
            if (existingByDataId.containsKey(frameId)) {
                disappearedFrames = 0;
            } else if (++disappearedFrames > maxDisappearGap) {
                return;
            }
            reachable.add(frameId);
        }
    }

    private static boolean sameClassId(DataAnnotationObject obj, Long classId) {
        if (classId == null) {
            return false;
        }
        Long objClassId = classIdOf(obj);
        return classId.equals(objClassId);
    }

    private static boolean sameClass(DataAnnotationObject obj, DataAnnotationObjectBO source) {
        Long sourceClassId = source.getClassId();
        if (sourceClassId == null && source.getClassAttributes() != null) {
            sourceClassId = source.getClassAttributes().getLong("classId");
        }
        Long objClassId = classIdOf(obj);
        if (sourceClassId != null && objClassId != null) {
            return sourceClassId.equals(objClassId);
        }
        String sourceType = classTypeOf(source.getClassAttributes());
        String objType = classTypeOf(obj.getClassAttributes());
        return StrUtil.isNotBlank(sourceType) && sourceType.equals(objType);
    }

    private static Long classIdOf(DataAnnotationObject obj) {
        if (obj.getClassId() != null) {
            return obj.getClassId();
        }
        JSONObject attrs = obj.getClassAttributes();
        return attrs == null ? null : attrs.getLong("classId");
    }

    private static String classTypeOf(JSONObject attrs) {
        return attrs == null ? null : attrs.getStr("classType");
    }

    private static DataAnnotationObject preferExistingRow(DataAnnotationObject current, DataAnnotationObject candidate,
                                                          Long sourceObjectId) {
        if (candidate.getId() != null && candidate.getId().equals(sourceObjectId)) {
            return candidate;
        }
        if (current.getId() != null && current.getId().equals(sourceObjectId)) {
            return current;
        }
        boolean candidateUsable = hasUsableBox(candidate);
        boolean currentUsable = hasUsableBox(current);
        if (candidateUsable != currentUsable) {
            return candidateUsable ? candidate : current;
        }
        return candidate.getId() != null && current.getId() != null && candidate.getId() > current.getId()
                ? candidate
                : current;
    }

    private static boolean hasUsableBox(DataAnnotationObject obj) {
        JSONObject attrs = obj.getClassAttributes();
        JSONObject contour = attrs == null ? null : attrs.getJSONObject("contour");
        JSONObject size3D = contour == null ? null : contour.getJSONObject("size3D");
        return size3D != null
                && Math.abs(getDouble(size3D, "x")) > 0
                && Math.abs(getDouble(size3D, "y")) > 0
                && Math.abs(getDouble(size3D, "z")) > 0;
    }

    private static boolean hasSyncableBox(DataAnnotationObject object) {
        JSONObject attrs = object.getClassAttributes();
        JSONObject contour = attrs == null ? null : attrs.getJSONObject("contour");
        return contour != null
                && contour.getJSONObject("center3D") != null
                && contour.getJSONObject("size3D") != null;
    }

    private static boolean hasSyncableObject(DataAnnotationObject object) {
        return hasSyncableBox(object)
                || isGroundPolygon(object.getClassAttributes())
                || isGroundPolyline(object.getClassAttributes());
    }

    private static boolean isGroundPolygon(JSONObject attrs) {
        if (attrs == null || !GROUND_POLYGON.equals(attrs.getStr("type"))) {
            return false;
        }
        JSONObject contour = attrs.getJSONObject("contour");
        JSONArray points = contour == null ? null : contour.getJSONArray("points");
        return points != null && points.size() == 4;
    }

    private static boolean isGroundPolyline(JSONObject attrs) {
        if (attrs == null || !GROUND_POLYLINE.equals(attrs.getStr("type"))) {
            return false;
        }
        JSONObject contour = attrs.getJSONObject("contour");
        return contour != null && contour.getJSONArray("points") != null;
    }

    private SyncResult applyChanges(List<DataAnnotationObject> toInsert, List<DataAnnotationObject> toUpdate,
                               List<Long> toDeleteIds) {
        Map<Long, DataAnnotationObject> storedById = CollUtil.isEmpty(toUpdate)
                ? Map.of()
                : dataAnnotationObjectDAO.listByIds(
                                toUpdate.stream().map(DataAnnotationObject::getId).collect(Collectors.toList()))
                        .stream()
                        .collect(Collectors.toMap(DataAnnotationObject::getId, object -> object));
        List<DataAnnotationObject> changedUpdates = toUpdate.stream()
                .filter(candidate -> {
                    DataAnnotationObject stored = storedById.get(candidate.getId());
                    return stored == null
                            || !ObjectUtil.equal(stored.getClassId(), candidate.getClassId())
                            || !ObjectUtil.equal(
                                    JSONUtil.toJsonStr(stored.getClassAttributes()),
                                    JSONUtil.toJsonStr(candidate.getClassAttributes()));
                })
                .collect(Collectors.toList());
        Set<Long> affectedDataIds = new HashSet<>();
        toInsert.forEach(object -> affectedDataIds.add(object.getDataId()));
        changedUpdates.forEach(object -> affectedDataIds.add(object.getDataId()));
        if (CollUtil.isNotEmpty(toDeleteIds)) {
            dataAnnotationObjectDAO.listByIds(toDeleteIds)
                    .forEach(object -> affectedDataIds.add(object.getDataId()));
        }
        if (CollUtil.isNotEmpty(toInsert)) {
            dataAnnotationObjectDAO.getBaseMapper().insertBatch(toInsert);
        }
        if (CollUtil.isNotEmpty(changedUpdates)) {
            dataAnnotationObjectDAO.getBaseMapper().mysqlInsertOrUpdateBatch(changedUpdates);
        }
        if (CollUtil.isNotEmpty(toDeleteIds)) {
            dataAnnotationObjectDAO.removeBatchByIds(toDeleteIds);
        }
        return new SyncResult(affectedDataIds);
    }

    public static class SyncResult {
        private final List<Long> affectedDataIds;
        private final long syncVersion;

        SyncResult(Set<Long> affectedDataIds) {
            this.affectedDataIds = affectedDataIds.stream().sorted().collect(Collectors.toList());
            this.syncVersion = System.currentTimeMillis();
        }

        static SyncResult empty() {
            return new SyncResult(Set.of());
        }

        public List<Long> getAffectedDataIds() {
            return affectedDataIds;
        }

        public long getSyncVersion() {
            return syncVersion;
        }
    }

    private static double getDouble(JSONObject obj, String key) {
        if (obj == null) return 0;
        Object v = obj.get(key);
        return v == null ? 0 : ((Number) v).doubleValue();
    }

    private static double getPositiveDouble(JSONObject obj, String key, double defaultValue) {
        if (obj == null) return defaultValue;
        Object v = obj.get(key);
        if (!(v instanceof Number)) return defaultValue;
        double value = ((Number) v).doubleValue();
        return value > 0 ? value : defaultValue;
    }

    private static int getNonNegativeInt(JSONObject obj, String key, int defaultValue) {
        if (obj == null) return defaultValue;
        Object value = obj.get(key);
        if (!(value instanceof Number)) return defaultValue;
        int intValue = ((Number) value).intValue();
        return intValue >= 0 ? intValue : defaultValue;
    }

    private static int getPositiveInt(JSONObject obj, String key, int defaultValue) {
        if (obj == null) return defaultValue;
        Object value = obj.get(key);
        if (!(value instanceof Number)) return defaultValue;
        int intValue = ((Number) value).intValue();
        return intValue > 0 ? intValue : defaultValue;
    }

    private static boolean getBoolean(JSONObject obj, String key, boolean defaultValue) {
        if (obj == null) return defaultValue;
        Object v = obj.get(key);
        return v instanceof Boolean ? (Boolean) v : defaultValue;
    }

    private static double distanceToBoxFootprint(double centerX, double centerY, double yaw, JSONObject size3D) {
        double halfX = Math.max(Math.abs(getDouble(size3D, "x")) / 2.0, 0.0);
        double halfY = Math.max(Math.abs(getDouble(size3D, "y")) / 2.0, 0.0);

        // Ego is at (0, 0) in the target frame. Rotate the ego-to-center vector into the box's
        // local axes, then compute point-to-axis-aligned-rectangle distance.
        double dx = -centerX;
        double dy = -centerY;
        double localX = dx * Math.cos(yaw) + dy * Math.sin(yaw);
        double localY = -dx * Math.sin(yaw) + dy * Math.cos(yaw);
        double outsideX = Math.max(Math.abs(localX) - halfX, 0.0);
        double outsideY = Math.max(Math.abs(localY) - halfY, 0.0);
        return Math.sqrt(outsideX * outsideX + outsideY * outsideY);
    }

    private static class ExistingRows {
        final Map<Long, DataAnnotationObject> byDataId;
        final List<Long> duplicateObjectIds;
        final Map<Long, Long> duplicateDataIdByObjectId;

        ExistingRows(
                Map<Long, DataAnnotationObject> byDataId,
                List<Long> duplicateObjectIds,
                Map<Long, Long> duplicateDataIdByObjectId) {
            this.byDataId = byDataId;
            this.duplicateObjectIds = duplicateObjectIds;
            this.duplicateDataIdByObjectId = duplicateDataIdByObjectId;
        }
    }

    static class Pose {
        final double x;
        final double y;
        final double z;
        final double yaw;
        final double roll;
        final double pitch;
        final boolean explicitRoll;
        final boolean explicitPitch;
        final boolean complete;

        Pose(Double x, Double y, Double z, Double yaw) {
            this(value(x), value(y), value(z), value(yaw), 0, 0, false, false, x != null && y != null && z != null && yaw != null);
        }

        Pose(Double x, Double y, Double z, Double yaw, Double pitch) {
            this(
                    value(x),
                    value(y),
                    value(z),
                    value(yaw),
                    0,
                    value(pitch),
                    false,
                    pitch != null,
                    x != null && y != null && z != null && yaw != null);
        }

        Pose(Double x, Double y, Double z, Double yaw, Double roll, Double pitch) {
            this(
                    value(x),
                    value(y),
                    value(z),
                    value(yaw),
                    roll == null ? 0 : roll,
                    pitch == null ? 0 : pitch,
                    roll != null,
                    pitch != null,
                    x != null && y != null && z != null && yaw != null);
        }

        Pose(
                double x,
                double y,
                double z,
                double yaw,
                Double roll,
                double pitch,
                boolean explicitRoll,
                boolean explicitPitch) {
            this(
                    x,
                    y,
                    z,
                    yaw,
                    roll == null ? 0 : roll,
                    pitch,
                    explicitRoll,
                    explicitPitch,
                    true);
        }

        private Pose(
                double x,
                double y,
                double z,
                double yaw,
                double roll,
                double pitch,
                boolean explicitRoll,
                boolean explicitPitch,
                boolean complete) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.yaw = yaw;
            this.roll = roll;
            this.pitch = pitch;
            this.explicitRoll = explicitRoll;
            this.explicitPitch = explicitPitch;
            this.complete = complete;
        }

        private static double value(Double value) {
            return value == null ? 0 : value;
        }
    }

    static class PolylineDistanceMask {
        final JSONArray points;
        final List<Boolean> outsideSegments;

        PolylineDistanceMask(JSONArray points, List<Boolean> outsideSegments) {
            this.points = points;
            this.outsideSegments = outsideSegments;
        }
    }

    static class ProjectedPose {
        final double x;
        final double y;
        final double z;
        final double yaw;

        ProjectedPose(double x, double y, double z, double yaw) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.yaw = yaw;
        }
    }
}
