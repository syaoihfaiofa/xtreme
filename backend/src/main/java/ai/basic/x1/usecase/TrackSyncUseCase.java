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
    private static final int DEFAULT_SYNC_MAX_DISAPPEAR_GAP = 50;
    private static final int DEFAULT_SYNC_LOCATION_GAP_MS = 200;
    private static final int DEFAULT_DYNAMIC_SYNC_PREVIOUS_FRAMES = 1;
    private static final int DEFAULT_DYNAMIC_SYNC_NEXT_FRAMES = 1;

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
    public void syncByDataIdAndTrackId(Long dataId, String trackId) {
        syncByDataIdAndTrackId(dataId, trackId, null);
    }

    @Transactional(rollbackFor = Exception.class)
    public void syncByDataIdAndTrackId(Long dataId, String trackId, Long classId) {
        if (ObjectUtil.isNull(dataId) || StrUtil.isBlank(trackId)) {
            return;
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
        syncOne(DefaultConverter.convert(source.get(), DataAnnotationObjectBO.class));
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
                .filter(object -> {
                    JSONObject contour = object.getClassAttributes().getJSONObject("contour");
                    return contour != null
                            && contour.getJSONObject("center3D") != null
                            && contour.getJSONObject("size3D") != null;
                })
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

    private void syncOne(DataAnnotationObjectBO source) {
        JSONObject attrs = source.getClassAttributes();
        if (ObjectUtil.isNull(attrs) || ObjectUtil.isNull(source.getDatasetId()) || ObjectUtil.isNull(source.getDataId())) {
            return;
        }
        String trackId = attrs.getStr("trackId");
        String motionMode = attrs.getStr("motionMode");
        if (StrUtil.isBlank(trackId) || StrUtil.isBlank(motionMode)) {
            return;
        }
        if (!MOTION_STATIC.equals(motionMode)
                && !MOTION_DYNAMIC_FIXED_SIZE.equals(motionMode)
                && !MOTION_DYNAMIC_VARIABLE_SIZE.equals(motionMode)) {
            return;
        }

        var dataset = datasetDAO.getById(source.getDatasetId());
        if (ObjectUtil.isNull(dataset) || !Boolean.TRUE.equals(dataset.getSyncMode())) {
            return;
        }

        var sourceFrame = dataInfoDAO.getById(source.getDataId());
        if (ObjectUtil.isNull(sourceFrame) || ObjectUtil.isNull(sourceFrame.getParentId())) {
            return;
        }
        Long sceneId = sourceFrame.getParentId();

        var frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sceneId)
                .eq(DataInfo::getIsDeleted, false)
                .orderByAsc(DataInfo::getOrderName));
        if (CollUtil.isEmpty(frames)) {
            return;
        }
        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());

        Map<Long, Pose> poseByDataId = buildPoseByDataId(sceneId, frames, frameIds);
        int locationGapMs = getPositiveInt(attrs, "syncLocationGapMs", DEFAULT_SYNC_LOCATION_GAP_MS);
        Map<Long, Integer> segmentByDataId = buildSegmentByDataId(sceneId, frames, locationGapMs);

        if (isGroundPolygon(attrs)) {
            requireScenePose(poseByDataId, source.getDataId());
            syncGroundPolygon(source, trackId, frames, poseByDataId);
            return;
        }
        if (isGroundPolyline(attrs)) {
            if (MOTION_STATIC.equals(motionMode)) {
                requireScenePose(poseByDataId, source.getDataId());
                syncGroundPolyline(source, trackId, frames, poseByDataId);
            }
            return;
        }

        // existing annotation rows across the whole scene, so we can decide insert vs update vs delete
        var existingObjects = dataAnnotationObjectDAO.list(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .in(DataAnnotationObject::getDataId, frameIds));
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
            syncMotionModeOnly(
                    source,
                    motionMode,
                    frames,
                    existingByDataId,
                    existingRows.duplicateObjectIds,
                    segmentByDataId,
                    locationGapMs,
                    maxDisappearGap
            );
            return;
        }

        JSONObject contour = attrs.getJSONObject("contour");
        JSONObject center3D = contour == null ? null : contour.getJSONObject("center3D");
        JSONObject size3D = contour == null ? null : contour.getJSONObject("size3D");
        if (center3D == null || size3D == null) {
            // not a 3D_BOX object (e.g. a 2D_RECT/2D_BOX projection row sharing the trackId)
            return;
        }

        if (MOTION_STATIC.equals(motionMode)) {
            requireScenePose(poseByDataId, source.getDataId());
            double syncRadius = getPositiveDouble(attrs, "syncDistance", DEFAULT_STATIC_SYNC_RADIUS_M);
            boolean syncUseZ = getBoolean(attrs, "syncUseZ", true);
            double syncYawOffset = Math.toRadians(getDouble(attrs, "syncYawOffsetDeg"));
            double syncXOffset = getDouble(attrs, "syncXOffsetM");
            double syncYOffset = getDouble(attrs, "syncYOffsetM");
            syncStatic(source, trackId, center3D, size3D, contour.getJSONObject("rotation3D"),
                    syncRadius, syncUseZ, syncYawOffset, syncXOffset, syncYOffset, frames, poseByDataId, existingByDataId,
                    existingRows.duplicateObjectIds, reachableFrameIds, maxDisappearGap, segmentByDataId,
                    locationGapMs, segmentsInitialized);
        } else if (dynamicRangeSyncEnabled) {
            requireScenePose(poseByDataId, source.getDataId());
            boolean syncUseZ = getBoolean(attrs, "syncUseZ", true);
            syncDynamicRange(
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
                    syncUseZ
            );
        } else {
            syncFixedSize(
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

    private void syncDynamicRange(
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
            boolean syncUseZ) {
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
                    localX, localY, localZ, localYaw, sourcePose, targetPose, syncUseZ);
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
                    syncUseZ);

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
        applyChanges(toInsert, toUpdate, toDeleteIds);
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
            boolean syncUseZ) {
        attrs.set("classId", source.getClassId());
        attrs.set("motionMode", motionMode);
        attrs.set("dynamicRangeSyncEnabled", true);
        attrs.set("dynamicSyncPreviousFrames", previousFrames);
        attrs.set("dynamicSyncNextFrames", nextFrames);
        attrs.set("syncUseZ", syncUseZ);
        updateSyncMetadata(attrs, maxDisappearGap, segmentId, locationGapMs);
    }

    /**
     * Propagate the static four-corner parking footprint to every frame that has a pose.
     * The stored contour remains in each frame's local LiDAR coordinates; world coordinates
     * are used only while transforming between source and target frames.
     */
    private void syncGroundPolygon(DataAnnotationObjectBO source, String trackId, List<DataInfo> frames,
                                   Map<Long, Pose> poseByDataId) {
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
            double worldX = sourcePose.x + localX * Math.cos(sourcePose.yaw) - localY * Math.sin(sourcePose.yaw);
            double worldY = sourcePose.y + localX * Math.sin(sourcePose.yaw) + localY * Math.cos(sourcePose.yaw);
            worldPoints.add(new double[]{worldX, worldY, sourcePose.z + localZ});
        }

        Map<Long, DataAnnotationObject> existingByDataId = dataAnnotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .in(DataAnnotationObject::getDataId,
                                        frames.stream().map(DataInfo::getId).collect(Collectors.toList())))
                .stream()
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
                double dx = worldPoint[0] - targetPose.x;
                double dy = worldPoint[1] - targetPose.y;
                JSONObject targetPoint = new JSONObject();
                targetPoint.set("x", dx * Math.cos(targetPose.yaw) + dy * Math.sin(targetPose.yaw));
                targetPoint.set("y", -dx * Math.sin(targetPose.yaw) + dy * Math.cos(targetPose.yaw));
                targetPoint.set("z", worldPoint[2] - targetPose.z);
                targetPoints.add(targetPoint);
            }
            contour.set("points", targetPoints);
            attrs.set("type", "GROUND_POLYGON");
            attrs.set("trackId", trackId);
            attrs.set("motionMode", MOTION_STATIC);
            attrs.set("parkingOpeningEdge", "P3_P0");
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
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
        applyChanges(inserts, updates, new ArrayList<>());
    }

    private void syncGroundPolyline(DataAnnotationObjectBO source, String trackId, List<DataInfo> frames,
                                    Map<Long, Pose> poseByDataId) {
        JSONObject sourceAttrs = source.getClassAttributes();
        JSONObject sourceContour = sourceAttrs.getJSONObject("contour");
        JSONArray sourcePoints = sourceContour == null ? null : sourceContour.getJSONArray("points");
        if (sourcePoints == null) {
            throw new IllegalArgumentException(
                    String.format("Ground polyline points are required: dataId=%s, trackId=%s",
                            source.getDataId(), trackId));
        }
        Pose sourcePose = poseByDataId.get(source.getDataId());
        Map<Long, DataAnnotationObject> existingByDataId = dataAnnotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .in(DataAnnotationObject::getDataId,
                                        frames.stream().map(DataInfo::getId).collect(Collectors.toList())))
                .stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> sameClass(object, source))
                .filter(object -> isGroundPolyline(object.getClassAttributes()))
                .collect(Collectors.toMap(
                        DataAnnotationObject::getDataId,
                        object -> object,
                        (first, ignored) -> first));

        List<DataAnnotationObject> inserts = new ArrayList<>();
        List<DataAnnotationObject> updates = new ArrayList<>();
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
            contour.set("points", projectGroundPoints(sourcePoints, sourcePose, targetPose));
            attrs.set("type", GROUND_POLYLINE);
            attrs.set("trackId", trackId);
            attrs.set("motionMode", MOTION_STATIC);
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
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
        applyChanges(inserts, updates, new ArrayList<>());
    }

    static JSONArray projectGroundPoints(JSONArray sourcePoints, Pose sourcePose, Pose targetPose) {
        JSONArray targetPoints = new JSONArray();
        for (int index = 0; index < sourcePoints.size(); index++) {
            JSONObject sourcePoint = sourcePoints.getJSONObject(index);
            if (sourcePoint == null) {
                throw new IllegalArgumentException(String.format("Ground shape point is invalid: index=%s", index));
            }
            double localX = getDouble(sourcePoint, "x");
            double localY = getDouble(sourcePoint, "y");
            double localZ = getDouble(sourcePoint, "z");
            double worldX = sourcePose.x + localX * Math.cos(sourcePose.yaw) - localY * Math.sin(sourcePose.yaw);
            double worldY = sourcePose.y + localX * Math.sin(sourcePose.yaw) + localY * Math.cos(sourcePose.yaw);
            double dx = worldX - targetPose.x;
            double dy = worldY - targetPose.y;
            targetPoints.add(point3D(
                    dx * Math.cos(targetPose.yaw) + dy * Math.sin(targetPose.yaw),
                    -dx * Math.sin(targetPose.yaw) + dy * Math.cos(targetPose.yaw),
                    sourcePose.z + localZ - targetPose.z));
        }
        return targetPoints;
    }

    private void syncStatic(DataAnnotationObjectBO source, String trackId, JSONObject center3D, JSONObject size3D,
                             JSONObject rotation3D, double syncRadius, boolean syncUseZ, double syncYawOffset,
                             double syncXOffset, double syncYOffset, List<DataInfo> frames,
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
        double srcYaw = srcPose == null ? 0 : srcPose.yaw + syncYawOffset;
        double worldX = srcPose == null ? 0 : srcPose.x + localX * Math.cos(srcYaw) - localY * Math.sin(srcYaw);
        double worldY = srcPose == null ? 0 : srcPose.y + localX * Math.sin(srcYaw) + localY * Math.cos(srcYaw);
        double worldZ = srcPose == null ? 0 : srcPose.z + localZ;
        double worldYaw = srcPose == null ? 0 : localYaw + srcYaw;
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
                    updateStaticMetadata(existingAttrs, source, size3D, syncRadius, syncUseZ, syncYawOffset,
                            syncXOffset, syncYOffset, maxDisappearGap, targetSegmentId, locationGapMs);
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
                    updateStaticMetadata(sourceAttrs, source, size3D, syncRadius, syncUseZ, syncYawOffset,
                            syncXOffset, syncYOffset, maxDisappearGap, targetSegmentId, locationGapMs);
                    existing.setClassId(source.getClassId());
                    existing.setClassAttributes(sourceAttrs);
                    toUpdate.add(existing);
                }
                continue;
            }

            Pose pose = poseByDataId.get(frame.getId());
            double poseYaw = pose.yaw + syncYawOffset;
            double dx = worldX - pose.x;
            double dy = worldY - pose.y;
            double tgtLocalX = dx * Math.cos(poseYaw) + dy * Math.sin(poseYaw) + syncXOffset;
            double tgtLocalY = -dx * Math.sin(poseYaw) + dy * Math.cos(poseYaw) + syncYOffset;
            double tgtLocalZ = syncUseZ ? worldZ - pose.z : localZ;
            double tgtLocalYaw = worldYaw - poseYaw;
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
            updateStaticMetadata(newAttrs, source, size3D, syncRadius, syncUseZ, syncYawOffset,
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

        applyChanges(toInsert, toUpdate, toDeleteIds);
    }

    private void updateStaticMetadata(JSONObject attrs, DataAnnotationObjectBO source, JSONObject size3D,
                                      double syncRadius, boolean syncUseZ, double syncYawOffset,
                                      double syncXOffset, double syncYOffset, int maxDisappearGap,
                                      Integer segmentId, int locationGapMs) {
        JSONObject contour = attrs.getJSONObject("contour");
        if (contour != null) {
            contour.set("size3D", JSONUtil.parseObj(JSONUtil.toJsonStr(size3D)));
        }
        attrs.set("classId", source.getClassId());
        attrs.set("motionMode", MOTION_STATIC);
        attrs.set("syncDistance", syncRadius);
        attrs.set("syncUseZ", syncUseZ);
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
        // A newly auto-created synced row should not inherit source-frame attributes such as
        // Occlusion/Truncation/State. Those are per-frame labels, while Sync only propagates
        // track geometry and sync metadata.
        attrs.set("attrs", new JSONObject());
    }

    private void syncFixedSize(DataAnnotationObjectBO source, JSONObject size3D, List<DataInfo> frames,
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
        applyChanges(new ArrayList<>(), toUpdate, new ArrayList<>(duplicateObjectIds));
    }

    private void syncMotionModeOnly(DataAnnotationObjectBO source, String motionMode, List<DataInfo> frames,
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
        applyChanges(new ArrayList<>(), toUpdate, new ArrayList<>(duplicateObjectIds));
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
            if (!trackId.equals(obj.getClassAttributes().getStr("trackId"))) continue;
            if (!sameClass(obj, source)) continue;
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
                poseByDataId.put(frame.getId(), new Pose(pose[0], pose[1], pose[2], pose[3]));
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
        locations.forEach(location -> poseByDataId.put(
                location.getDataId(),
                new Pose(location.getPosX(), location.getPosY(), location.getPosZ(), location.getYaw())));
        // #region agent log
        Map<String, Object> logData = new HashMap<>();
        logData.put("sceneId", sceneId);
        logData.put("poseSource", "scene_location_table");
        logData.put("tableCount", locations.size());
        SyncPoseDebugLog.log("H2", "buildPoseByDataId fallback to table", logData);
        // #endregion
        return poseByDataId;
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
        if (sourcePose == null || targetPose == null || !sourcePose.complete || !targetPose.complete) {
            throw new IllegalArgumentException("Complete source and target poses are required");
        }
        double worldX = sourcePose.x
                + localX * Math.cos(sourcePose.yaw)
                - localY * Math.sin(sourcePose.yaw);
        double worldY = sourcePose.y
                + localX * Math.sin(sourcePose.yaw)
                + localY * Math.cos(sourcePose.yaw);
        double dx = worldX - targetPose.x;
        double dy = worldY - targetPose.y;
        double targetX = dx * Math.cos(targetPose.yaw) + dy * Math.sin(targetPose.yaw);
        double targetY = -dx * Math.sin(targetPose.yaw) + dy * Math.cos(targetPose.yaw);
        return new ProjectedPose(
                targetX,
                targetY,
                syncUseZ ? sourcePose.z + localZ - targetPose.z : localZ,
                localYaw + sourcePose.yaw - targetPose.yaw);
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

    private void applyChanges(List<DataAnnotationObject> toInsert, List<DataAnnotationObject> toUpdate,
                               List<Long> toDeleteIds) {
        if (CollUtil.isNotEmpty(toInsert)) {
            dataAnnotationObjectDAO.getBaseMapper().insertBatch(toInsert);
        }
        if (CollUtil.isNotEmpty(toUpdate)) {
            dataAnnotationObjectDAO.getBaseMapper().mysqlInsertOrUpdateBatch(toUpdate);
        }
        if (CollUtil.isNotEmpty(toDeleteIds)) {
            dataAnnotationObjectDAO.removeBatchByIds(toDeleteIds);
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
        final boolean complete;

        Pose(Double x, Double y, Double z, Double yaw) {
            this.x = x == null ? 0 : x;
            this.y = y == null ? 0 : y;
            this.z = z == null ? 0 : z;
            this.yaw = yaw == null ? 0 : yaw;
            this.complete = x != null && y != null && z != null && yaw != null;
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
