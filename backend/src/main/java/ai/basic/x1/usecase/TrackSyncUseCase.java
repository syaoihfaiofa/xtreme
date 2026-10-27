package ai.basic.x1.usecase;

import ai.basic.x1.adapter.exception.ApiException;
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
import cn.hutool.core.collection.ListUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONUtil;
import com.google.common.cache.Cache;
import com.google.common.cache.CacheBuilder;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import ai.basic.x1.usecase.exception.UsecaseCode;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
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
 *     existing rows. Optional dynamic range sync projects complete geometry into a frame window.
 *     A ground polygon keeps each existing frame's center and heading, and replaces the relative
 *     footprint with the source shape. Range sync projects the four points into the frame window.</li>
 *     <li>{@code DYNAMIC_VARIABLE_SIZE} - by default, geometry stays independent per frame.
 *     Optional dynamic range sync projects complete geometry into a frame window.</li>
 * </ul>
 */
@Slf4j
public class TrackSyncUseCase {

    private static final double DEFAULT_STATIC_SYNC_RADIUS_M = 12.0;
    private static final double DEFAULT_SEMI_STATIC_SYNC_RADIUS_M = 5.0;
    private static final double DEFAULT_GROUND_POLYGON_SYNC_RADIUS_M = 10.0;
    /** Do not propagate a static target between vertically separated road levels. */
    private static final double STATIC_SYNC_VERTICAL_TOLERANCE_M = 2.0;
    private static final double DEFAULT_GROUND_POLYLINE_SYNC_RADIUS_M = 15.0;
    private static final int DEFAULT_SYNC_MAX_DISAPPEAR_GAP = 50;
    private static final int DEFAULT_SYNC_LOCATION_GAP_MS = 1000;
    private static final int DEFAULT_DYNAMIC_SYNC_PREVIOUS_FRAMES = 1;
    private static final int DEFAULT_DYNAMIC_SYNC_NEXT_FRAMES = 1;
    private static final int SYNC_WRITE_BATCH_SIZE = 200;
    private static final double POLYLINE_OVERLAP_SNAP_M = 0.2;
    private static final double GEOMETRY_EPSILON = 0.000000001;
    private static final List<String> CAMERA_VIEW_KEYS = List.of("0", "1", "2", "3");

    private static final String MOTION_STATIC = "STATIC";
    private static final String MOTION_SEMI_STATIC = "SEMI_STATIC";
    private static final String MOTION_DYNAMIC_FIXED_SIZE = "DYNAMIC_FIXED_SIZE";
    private static final String MOTION_DYNAMIC_VARIABLE_SIZE = "DYNAMIC_VARIABLE_SIZE";
    private static final String SEMI_STATIC_POSITION_LOCKED = "semiStaticPositionLocked";
    private static final String MANUAL_SYNC_SEGMENT_ID = "manualSyncSegmentId";
    private static final String MANUAL_SYNC_SEGMENT_BOUNDARY_DATA_ID = "manualSyncSegmentBoundaryDataId";
    private static final String MANUAL_SYNC_SEGMENT_START_DATA_ID = "manualSyncSegmentStartDataId";
    private static final String MANUAL_SYNC_SEGMENT_END_DATA_ID = "manualSyncSegmentEndDataId";
    private static final String PENDING_SYNC_QUARTER_TURNS = "pendingSyncQuarterTurns";
    private static final String GROUND_POLYGON = "GROUND_POLYGON";
    private static final String GROUND_POLYLINE = "GROUND_POLYLINE";
    private static final String IRREGULAR_WALL = "IRREGULAR_WALL";
    private static final String PROJECTED_GROUND_POLYLINE = "2D_GROUND_POLYLINE";
    private static final String PROJECTED_IRREGULAR_WALL = "2D_IRREGULAR_WALL";
    private static final double TRACK_SPLIT_MATCH_TOLERANCE_M = 0.2;
    private static final double TRACK_SPLIT_MIN_LENGTH_M = 0.01;

    @Autowired
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private SceneLocationDAO sceneLocationDAO;

    @Autowired
    private SceneLocationSampleDAO sceneLocationSampleDAO;

    private final ScenePoseCache scenePoseCache = new ScenePoseCache();

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
                                .in(DataAnnotationObject::getDataId, frameIds)
                                .and(query -> query
                                        .eq(DataAnnotationObject::getTrackId, trackId)
                                        .or()
                                        .isNull(DataAnnotationObject::getTrackId)))
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

    /**
     * Splits every row of a ground-polyline/irregular-wall track at one physical location.
     * Validation is deliberately completed before the first database write so a divergent
     * frame or stale 2D projection cannot leave the scene half split.
     */
    @Transactional(rollbackFor = Exception.class)
    public TrackSplitResult splitTrack(TrackSplitRequest request) {
        if (request == null || request.dataId == null || StrUtil.isBlank(request.trackId)
                || StrUtil.isBlank(request.objectType) || request.segmentIndex == null
                || request.t == null) {
            throw new IllegalArgumentException("dataId, trackId, objectType, segmentIndex and t are required");
        }
        if (request.t < 0 || request.t > 1) {
            throw new IllegalArgumentException("The split ratio must be between zero and one");
        }
        if (!GROUND_POLYLINE.equals(request.objectType) && !IRREGULAR_WALL.equals(request.objectType)) {
            throw new IllegalArgumentException("Only GROUND_POLYLINE and IRREGULAR_WALL can be split");
        }

        DataInfo sourceFrame = dataInfoDAO.getById(request.dataId);
        if (sourceFrame == null || sourceFrame.getParentId() == null) {
            throw new IllegalArgumentException(String.format("Scene frame not found: dataId=%s", request.dataId));
        }
        List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sourceFrame.getParentId())
                .eq(DataInfo::getIsDeleted, false)
                .orderByAsc(DataInfo::getOrderName));
        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        List<DataAnnotationObject> sceneObjects = dataAnnotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .in(DataAnnotationObject::getDataId, frameIds));
        List<DataAnnotationObject> trackObjects = dataAnnotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .in(DataAnnotationObject::getDataId, frameIds)
                                .eq(DataAnnotationObject::getTrackId, request.trackId)
                                .last("FOR UPDATE"))
                .stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> request.trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> request.classId == null || sameClassId(object, request.classId))
                .collect(Collectors.toList());
        DataAnnotationObject source = trackObjects.stream()
                .filter(object -> request.dataId.equals(object.getDataId()))
                .filter(object -> request.objectType.equals(object.getClassAttributes().getStr("type")))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("The selected track object was not found"));
        trackObjects = trackObjects.stream()
                .filter(object -> sameClassId(object, classIdOf(source)))
                .collect(Collectors.toList());
        List<Long> incompatibleFrameIds = trackObjects.stream()
                .filter(object -> {
                    String type = object.getClassAttributes().getStr("type");
                    boolean compatibleProjection =
                            (GROUND_POLYLINE.equals(request.objectType)
                                    && PROJECTED_GROUND_POLYLINE.equals(type))
                            || (IRREGULAR_WALL.equals(request.objectType)
                                    && PROJECTED_IRREGULAR_WALL.equals(type));
                    return !request.objectType.equals(type) && !compatibleProjection;
                })
                .map(DataAnnotationObject::getDataId)
                .collect(Collectors.toList());
        if (!incompatibleFrameIds.isEmpty()) {
            throwSplitConflict(incompatibleFrameIds);
        }
        List<DataAnnotationObject> shapes = trackObjects.stream()
                .filter(object -> request.objectType.equals(object.getClassAttributes().getStr("type")))
                .collect(Collectors.toList());
        if (shapes.isEmpty()) {
            throw new IllegalArgumentException("The selected track has no splittable objects");
        }
        Map<Long, Long> shapeCountsByFrame = shapes.stream().collect(Collectors.groupingBy(
                DataAnnotationObject::getDataId, Collectors.counting()));
        List<Long> duplicateFrameIds = shapeCountsByFrame.entrySet().stream()
                .filter(entry -> entry.getValue() != 1)
                .map(Map.Entry::getKey)
                .collect(Collectors.toList());
        if (!duplicateFrameIds.isEmpty()) {
            throwSplitConflict(duplicateFrameIds);
        }

        Map<Long, Pose> poses = buildPoseByDataId(sourceFrame.getParentId(), frames, frameIds);
        boolean worldVertical = useWorldVerticalSync(source.getClassAttributes());
        Pose selectedPose = poses.get(source.getDataId());
        if (selectedPose == null || !selectedPose.complete) {
            throwSplitConflict(List.of(source.getDataId()));
        }
        String originalTrackName = StrUtil.blankToDefault(
                source.getClassAttributes().getStr("trackName"), request.trackId);
        String newTrackName = nextSplitTrackName(originalTrackName, sceneObjects);
        String newTrackId = UUID.randomUUID().toString().replace("-", "").substring(0, 16);

        List<DataAnnotationObject> updates = new ArrayList<>();
        List<DataAnnotationObject> inserts = new ArrayList<>();
        Map<Long, ShapeSplit> splitByFrame = new HashMap<>();
        List<Long> failedFrameIds = new ArrayList<>();

        if (GROUND_POLYLINE.equals(request.objectType)) {
            splitGroundPolylineTrack(request, source, shapes, poses, worldVertical,
                    newTrackId, newTrackName, updates, inserts, splitByFrame, failedFrameIds);
        } else {
            splitIrregularWallTrack(request, source, shapes, poses, worldVertical,
                    newTrackId, newTrackName, updates, inserts, splitByFrame, failedFrameIds);
        }

        List<DataAnnotationObject> projections = trackObjects.stream()
                .filter(object -> PROJECTED_GROUND_POLYLINE.equals(
                        object.getClassAttributes().getStr("type")))
                .collect(Collectors.toList());
        List<DataAnnotationObject> wallProjections = trackObjects.stream()
                .filter(object -> PROJECTED_IRREGULAR_WALL.equals(
                        object.getClassAttributes().getStr("type")))
                .collect(Collectors.toList());
        if (GROUND_POLYLINE.equals(request.objectType)) {
            splitProjectedPolylines(projections, splitByFrame, newTrackId, newTrackName,
                    updates, inserts, failedFrameIds);
        } else {
            splitProjectedIrregularWalls(wallProjections, splitByFrame, newTrackId, newTrackName,
                    updates, inserts, failedFrameIds);
        }
        if (!failedFrameIds.isEmpty()) {
            throwSplitConflict(failedFrameIds);
        }

        if (!updates.isEmpty()) {
            dataAnnotationObjectDAO.getBaseMapper().mysqlInsertOrUpdateBatch(updates);
        }
        if (!inserts.isEmpty()) {
            dataAnnotationObjectDAO.getBaseMapper().insertBatch(inserts);
        }
        List<Long> affected = shapes.stream().map(DataAnnotationObject::getDataId)
                .distinct().sorted().collect(Collectors.toList());
        List<DataAnnotationObject> storedInserts = dataAnnotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .in(DataAnnotationObject::getDataId, affected))
                .stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> newTrackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> sameClassId(object, classIdOf(source)))
                .collect(Collectors.toList());
        if (storedInserts.size() != inserts.size()) {
            throw new IllegalStateException("The split objects could not be read back after creation");
        }
        List<DataAnnotationObjectBO> changed = new ArrayList<>();
        changed.addAll(DefaultConverter.convert(updates, DataAnnotationObjectBO.class));
        changed.addAll(DefaultConverter.convert(storedInserts, DataAnnotationObjectBO.class));
        int projectionCount = GROUND_POLYLINE.equals(request.objectType)
                ? projections.size() : wallProjections.size();
        return new TrackSplitResult(request.trackId, originalTrackName, newTrackId, newTrackName,
                affected, changed, shapes.size(), shapes.size(), projectionCount, projectionCount);
    }

    private void splitGroundPolylineTrack(
            TrackSplitRequest request,
            DataAnnotationObject source,
            List<DataAnnotationObject> shapes,
            Map<Long, Pose> poses,
            boolean worldVertical,
            String newTrackId,
            String newTrackName,
            List<DataAnnotationObject> updates,
            List<DataAnnotationObject> inserts,
            Map<Long, ShapeSplit> splitByFrame,
            List<Long> failedFrameIds) {
        JSONArray sourcePoints = source.getClassAttributes().getJSONObject("contour").getJSONArray("points");
        if (!validSegment(sourcePoints, request.segmentIndex)) {
            throw new IllegalArgumentException("Invalid source split segment");
        }
        JSONObject sourceCutLocal = interpolatePoint(
                sourcePoints.getJSONObject(request.segmentIndex),
                sourcePoints.getJSONObject(request.segmentIndex + 1), request.t);
        if (!validSplitParts(splitPoints(sourcePoints, request.segmentIndex, request.t))) {
            throw new IllegalArgumentException("The split point is too close to a polyline endpoint");
        }
        Pose sourcePose = poses.get(source.getDataId());
        double[] cutWorld = localToWorld(getDouble(sourceCutLocal, "x"), getDouble(sourceCutLocal, "y"),
                getDouble(sourceCutLocal, "z"), sourcePose, worldVertical);

        for (DataAnnotationObject shape : shapes) {
            Pose pose = poses.get(shape.getDataId());
            if (pose == null || !pose.complete) {
                failedFrameIds.add(shape.getDataId());
                continue;
            }
            JSONObject attrs = shape.getClassAttributes();
            JSONArray points = attrs.getJSONObject("contour").getJSONArray("points");
            JSONArray worldPoints = polylineToWorld(points, pose, worldVertical);
            SegmentHit hit = closestSegment(worldPoints, cutWorld[0], cutWorld[1]);
            if (hit == null || hit.distance > TRACK_SPLIT_MATCH_TOLERANCE_M) {
                failedFrameIds.add(shape.getDataId());
                continue;
            }
            SplitParts parts = splitPoints(points, hit.segmentIndex, hit.t);
            if (!validSplitParts(parts)) {
                failedFrameIds.add(shape.getDataId());
                continue;
            }
            String newFrontId = UUID.randomUUID().toString();
            JSONObject leftAttrs = splitGroundPolylineAttributes(attrs, parts.left,
                    hit.segmentIndex, hit.t, false, request.trackId, originalTrackName(attrs), null);
            JSONObject rightAttrs = splitGroundPolylineAttributes(attrs, parts.right,
                    hit.segmentIndex, hit.t, true, newTrackId, newTrackName, newFrontId);
            shape.setClassAttributes(leftAttrs);
            shape.setSourceId(-1L);
            shape.setSourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW);
            updates.add(shape);
            DataAnnotationObject right = cloneForSplit(shape, rightAttrs);
            inserts.add(right);
            splitByFrame.put(shape.getDataId(), new ShapeSplit(points.size(), hit.segmentIndex,
                    hit.t, 0, -1, 0, false, leftAttrs.getStr("frontId"), newFrontId));
        }
    }

    private void splitIrregularWallTrack(
            TrackSplitRequest request,
            DataAnnotationObject source,
            List<DataAnnotationObject> shapes,
            Map<Long, Pose> poses,
            boolean worldVertical,
            String newTrackId,
            String newTrackName,
            List<DataAnnotationObject> updates,
            List<DataAnnotationObject> inserts,
            Map<Long, ShapeSplit> splitByFrame,
            List<Long> failedFrameIds) {
        String side = StrUtil.blankToDefault(request.side, "bottom");
        if (!"bottom".equals(side) && !"top".equals(side)) {
            throw new IllegalArgumentException("Irregular wall side must be bottom or top");
        }
        JSONObject sourceContour = source.getClassAttributes().getJSONObject("contour");
        JSONArray sourceBottom = sourceContour.getJSONArray("bottomPoints");
        JSONArray sourceTop = sourceContour.getJSONArray("topPoints");
        if (sourceBottom == null || sourceBottom.size() < 2 || sourceTop == null || sourceTop.size() < 2) {
            throw new IllegalArgumentException("Irregular wall split requires complete top and bottom edges");
        }
        JSONArray clicked = "top".equals(side) ? sourceTop : sourceBottom;
        if (!validSegment(clicked, request.segmentIndex)) {
            throw new IllegalArgumentException("Invalid source wall split segment");
        }
        double fraction = fractionAt(clicked, request.segmentIndex, request.t);
        if ("top".equals(side) && isReverseAligned(sourceBottom, sourceTop)) fraction = 1 - fraction;
        SplitParts sourceBottomParts = splitAtFraction(sourceBottom, fraction);
        JSONArray orientedSourceTop = orientedTop(sourceBottom, sourceTop);
        SplitParts sourceTopParts = splitAtFraction(orientedSourceTop, fraction);
        if (!validSplitParts(sourceBottomParts) || !validSplitParts(sourceTopParts)) {
            throw new IllegalArgumentException("The wall split point is too close to an endpoint");
        }
        Pose sourcePose = poses.get(source.getDataId());
        double[] sourceBottomWorld = pointToWorld(sourceBottomParts.cut, sourcePose, worldVertical);
        double[] sourceTopWorld = pointToWorld(sourceTopParts.cut, sourcePose, worldVertical);

        for (DataAnnotationObject shape : shapes) {
            Pose pose = poses.get(shape.getDataId());
            if (pose == null || !pose.complete) {
                failedFrameIds.add(shape.getDataId());
                continue;
            }
            JSONObject attrs = shape.getClassAttributes();
            JSONObject contour = attrs.getJSONObject("contour");
            JSONArray bottom = contour.getJSONArray("bottomPoints");
            JSONArray top = contour.getJSONArray("topPoints");
            if (bottom == null || bottom.size() < 2 || top == null || top.size() < 2) {
                failedFrameIds.add(shape.getDataId());
                continue;
            }
            SplitParts bottomParts = splitAtFraction(bottom, fraction);
            boolean topReversed = isReverseAligned(bottom, top);
            JSONArray alignedTop = orientedTop(bottom, top);
            SplitParts topParts = splitAtFraction(alignedTop, fraction);
            if (!validSplitParts(bottomParts) || !validSplitParts(topParts)
                    || worldDistanceXY(pointToWorld(bottomParts.cut, pose, worldVertical), sourceBottomWorld)
                        > TRACK_SPLIT_MATCH_TOLERANCE_M
                    || worldDistanceXY(pointToWorld(topParts.cut, pose, worldVertical), sourceTopWorld)
                        > TRACK_SPLIT_MATCH_TOLERANCE_M) {
                failedFrameIds.add(shape.getDataId());
                continue;
            }
            String newFrontId = UUID.randomUUID().toString();
            JSONObject leftAttrs = splitWallAttributes(attrs, bottomParts.left,
                    topParts.left,
                    request.trackId, originalTrackName(attrs), null);
            JSONObject rightAttrs = splitWallAttributes(attrs, bottomParts.right,
                    topParts.right,
                    newTrackId, newTrackName, newFrontId);
            shape.setClassAttributes(leftAttrs);
            shape.setSourceId(-1L);
            shape.setSourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW);
            updates.add(shape);
            inserts.add(cloneForSplit(shape, rightAttrs));
            splitByFrame.put(shape.getDataId(), new ShapeSplit(bottom.size(), bottomParts.segmentIndex,
                    bottomParts.t, top.size(), topParts.segmentIndex, topParts.t, topReversed,
                    leftAttrs.getStr("frontId"), newFrontId));
        }
    }

    private void splitProjectedIrregularWalls(
            List<DataAnnotationObject> projections,
            Map<Long, ShapeSplit> splitByFrame,
            String newTrackId,
            String newTrackName,
            List<DataAnnotationObject> updates,
            List<DataAnnotationObject> inserts,
            List<Long> failedFrameIds) {
        for (DataAnnotationObject projection : projections) {
            ShapeSplit split = splitByFrame.get(projection.getDataId());
            JSONObject attrs = projection.getClassAttributes();
            JSONObject contour = attrs.getJSONObject("contour");
            JSONArray bottom = contour == null ? null : contour.getJSONArray("bottomPoints");
            JSONArray top = contour == null ? null : contour.getJSONArray("topPoints");
            JSONObject meta = attrs.getJSONObject("meta");
            String projectedFromId = StrUtil.blankToDefault(
                    attrs.getStr("projectedFromId"), meta == null ? null : meta.getStr("projectedFromId"));
            if (split == null || StrUtil.isBlank(split.originalFrontId)
                    || !split.originalFrontId.equals(projectedFromId)
                    || bottom == null || bottom.size() != split.originalPointCount
                    || top == null || top.size() != split.originalTopPointCount) {
                failedFrameIds.add(projection.getDataId());
                continue;
            }
            JSONArray alignedTop = split.topReversed ? reversePoints(top) : copyPoints(top);
            SplitParts bottomParts = splitPoints(bottom, split.segmentIndex, split.t);
            SplitParts topParts = splitPoints(alignedTop, split.topSegmentIndex, split.topT);
            if (!validSplitParts(bottomParts) || !validSplitParts(topParts)) {
                failedFrameIds.add(projection.getDataId());
                continue;
            }
            String newFrontId = UUID.randomUUID().toString();
            JSONObject leftAttrs = splitWallAttributes(attrs, bottomParts.left, topParts.left,
                    attrs.getStr("trackId"), originalTrackName(attrs), null);
            JSONObject rightAttrs = splitWallAttributes(attrs, bottomParts.right, topParts.right,
                    newTrackId, newTrackName, newFrontId);
            rightAttrs.set("projectedFromId", split.newFrontId);
            JSONObject rightMeta = rightAttrs.getJSONObject("meta");
            if (rightMeta != null) rightMeta.set("projectedFromId", split.newFrontId);
            projection.setClassAttributes(leftAttrs);
            projection.setSourceId(-1L);
            projection.setSourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW);
            updates.add(projection);
            inserts.add(cloneForSplit(projection, rightAttrs));
        }
    }

    private static JSONArray reversePoints(JSONArray points) {
        JSONArray result = new JSONArray();
        for (int index = points.size() - 1; index >= 0; index--) {
            result.add(copyPoint(points.getJSONObject(index)));
        }
        return result;
    }

    private void splitProjectedPolylines(
            List<DataAnnotationObject> projections,
            Map<Long, ShapeSplit> splitByFrame,
            String newTrackId,
            String newTrackName,
            List<DataAnnotationObject> updates,
            List<DataAnnotationObject> inserts,
            List<Long> failedFrameIds) {
        for (DataAnnotationObject projection : projections) {
            ShapeSplit split = splitByFrame.get(projection.getDataId());
            JSONObject attrs = projection.getClassAttributes();
            JSONObject contour = attrs.getJSONObject("contour");
            JSONArray points = contour == null ? null : contour.getJSONArray("points");
            JSONObject meta = attrs.getJSONObject("meta");
            String projectedFromId = StrUtil.blankToDefault(
                    attrs.getStr("projectedFromId"), meta == null ? null : meta.getStr("projectedFromId"));
            if (split == null || StrUtil.isBlank(split.originalFrontId)
                    || !split.originalFrontId.equals(projectedFromId)
                    || points == null || points.size() != split.originalPointCount) {
                failedFrameIds.add(projection.getDataId());
                continue;
            }
            SplitParts parts = splitPoints(points, split.segmentIndex, split.t);
            if (!validSplitParts(parts)) {
                failedFrameIds.add(projection.getDataId());
                continue;
            }
            String newFrontId = UUID.randomUUID().toString();
            JSONObject leftAttrs = copyAttributes(attrs);
            leftAttrs.getJSONObject("contour").set("points", parts.left);
            markManualSplit(leftAttrs, attrs.getStr("trackId"), originalTrackName(attrs), null);
            JSONObject rightAttrs = copyAttributes(attrs);
            rightAttrs.getJSONObject("contour").set("points", parts.right);
            markManualSplit(rightAttrs, newTrackId, newTrackName, newFrontId);
            rightAttrs.set("projectedFromId", split.newFrontId);
            JSONObject rightMeta = rightAttrs.getJSONObject("meta");
            if (rightMeta != null) rightMeta.set("projectedFromId", split.newFrontId);
            projection.setClassAttributes(leftAttrs);
            projection.setSourceId(-1L);
            projection.setSourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW);
            updates.add(projection);
            inserts.add(cloneForSplit(projection, rightAttrs));
        }
    }

    private static JSONObject splitGroundPolylineAttributes(JSONObject attrs, JSONArray points,
                                                             int splitSegment, double splitT, boolean right,
                                                             String trackId, String trackName,
                                                             String frontId) {
        JSONObject result = copyAttributes(attrs);
        JSONObject contour = result.getJSONObject("contour");
        contour.set("points", points);
        for (String key : List.of("segmentVisibilityByView", "segmentForceVisibleByView")) {
            JSONObject visibility = contour.getJSONObject(key);
            if (visibility != null) {
                contour.set(key, sliceVisibility(visibility, splitSegment, splitT, right));
            }
        }
        markManualSplit(result, trackId, trackName, frontId);
        return result;
    }

    private static JSONObject splitWallAttributes(JSONObject attrs, JSONArray bottom, JSONArray top,
                                                   String trackId, String trackName, String frontId) {
        JSONObject result = copyAttributes(attrs);
        JSONObject contour = result.getJSONObject("contour");
        contour.set("bottomPoints", bottom);
        contour.set("topPoints", top);
        if (PROJECTED_IRREGULAR_WALL.equals(result.getStr("type"))) {
            JSONArray points = copyPoints(bottom);
            points.addAll(copyPoints(top));
            contour.set("points", points);
        } else {
            contour.set("points", copyPoints(bottom));
        }
        markManualSplit(result, trackId, trackName, frontId);
        return result;
    }

    static JSONObject sliceVisibility(JSONObject visibility, int splitSegment, boolean right) {
        return sliceVisibility(visibility, splitSegment, 0.5, right);
    }

    private static JSONObject sliceVisibility(JSONObject visibility, int splitSegment,
                                               double splitT, boolean right) {
        JSONObject result = new JSONObject();
        boolean atStart = splitT <= GEOMETRY_EPSILON;
        boolean atEnd = splitT >= 1 - GEOMETRY_EPSILON;
        int rightOffset = atEnd ? splitSegment + 1 : splitSegment;
        for (String viewKey : visibility.keySet()) {
            JSONArray source = visibility.getJSONArray(viewKey);
            JSONArray target = new JSONArray();
            if (source != null) {
                for (Object value : source) {
                    JSONObject entry = value instanceof JSONObject ? (JSONObject) value : JSONUtil.parseObj(value);
                    Integer storedIndex = entry.getInt("index");
                    int oldIndex = storedIndex == null ? -1 : storedIndex;
                    boolean includeLeft = oldIndex < splitSegment || (!atStart && oldIndex == splitSegment);
                    boolean includeRight = oldIndex > splitSegment || (!atEnd && oldIndex == splitSegment);
                    if ((!right && includeLeft) || (right && includeRight)) {
                        JSONObject next = copyAttributes(entry);
                        next.set("index", right ? oldIndex - rightOffset : oldIndex);
                        target.add(next);
                    }
                }
            }
            result.set(viewKey, target);
        }
        return result;
    }

    private static void markManualSplit(JSONObject attrs, String trackId, String trackName, String frontId) {
        attrs.set("trackId", trackId);
        attrs.set("trackName", trackName);
        attrs.set("reviewedCorrect", false);
        attrs.set("manualModified", true);
        attrs.set("sourceId", -1L);
        attrs.set("sourceType", DataAnnotationObjectSourceTypeEnum.DATA_FLOW.name());
        if (frontId != null) {
            attrs.set("id", frontId);
            attrs.set("frontId", frontId);
            attrs.remove("backId");
            JSONObject meta = attrs.getJSONObject("meta");
            if (meta != null) meta.remove("backId");
        }
    }

    private static DataAnnotationObject cloneForSplit(DataAnnotationObject source, JSONObject attrs) {
        return DataAnnotationObject.builder()
                .datasetId(source.getDatasetId())
                .dataId(source.getDataId())
                .classId(source.getClassId())
                .classAttributes(attrs)
                .sourceId(-1L)
                .sourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW)
                .createdAt(OffsetDateTime.now())
                .createdBy(source.getCreatedBy())
                .build();
    }

    private static JSONObject copyAttributes(JSONObject attrs) {
        return JSONUtil.parseObj(JSONUtil.toJsonStr(attrs));
    }

    private static String originalTrackName(JSONObject attrs) {
        return StrUtil.blankToDefault(attrs.getStr("trackName"), attrs.getStr("trackId"));
    }

    private static String nextSplitTrackName(String original, List<DataAnnotationObject> sceneObjects) {
        Set<String> names = sceneObjects.stream()
                .map(DataAnnotationObject::getClassAttributes)
                .filter(ObjectUtil::isNotNull)
                .map(attrs -> attrs.getStr("trackName"))
                .filter(StrUtil::isNotBlank)
                .collect(Collectors.toSet());
        String base = StrUtil.blankToDefault(original, "track") + "-B";
        if (!names.contains(base)) return base;
        for (int suffix = 2; ; suffix++) {
            String candidate = base + "-" + suffix;
            if (!names.contains(candidate)) return candidate;
        }
    }

    private static boolean validSegment(JSONArray points, int index) {
        return points != null && index >= 0 && index < points.size() - 1;
    }

    private static SplitParts splitPoints(JSONArray points, int segmentIndex, double t) {
        JSONArray left = new JSONArray();
        JSONArray right = new JSONArray();
        if (t <= GEOMETRY_EPSILON) {
            JSONObject cut = copyPoint(points.getJSONObject(segmentIndex));
            for (int index = 0; index <= segmentIndex; index++) left.add(copyPoint(points.getJSONObject(index)));
            for (int index = segmentIndex; index < points.size(); index++) right.add(copyPoint(points.getJSONObject(index)));
            return new SplitParts(left, right, cut, segmentIndex, 0);
        }
        if (t >= 1 - GEOMETRY_EPSILON) {
            JSONObject cut = copyPoint(points.getJSONObject(segmentIndex + 1));
            for (int index = 0; index <= segmentIndex + 1; index++) left.add(copyPoint(points.getJSONObject(index)));
            for (int index = segmentIndex + 1; index < points.size(); index++) right.add(copyPoint(points.getJSONObject(index)));
            return new SplitParts(left, right, cut, segmentIndex, 1);
        }
        for (int index = 0; index <= segmentIndex; index++) left.add(copyPoint(points.getJSONObject(index)));
        JSONObject cut = interpolatePoint(points.getJSONObject(segmentIndex), points.getJSONObject(segmentIndex + 1), t);
        left.add(copyPoint(cut));
        right.add(copyPoint(cut));
        for (int index = segmentIndex + 1; index < points.size(); index++) right.add(copyPoint(points.getJSONObject(index)));
        return new SplitParts(left, right, cut, segmentIndex, t);
    }

    static SplitParts splitAtFraction(JSONArray points, double fraction) {
        if (points == null || points.size() < 2 || fraction <= 0 || fraction >= 1) return null;
        double total = polylineLength(points);
        double target = total * fraction;
        double passed = 0;
        for (int index = 0; index < points.size() - 1; index++) {
            double length = pointDistance(points.getJSONObject(index), points.getJSONObject(index + 1));
            if (passed + length >= target && length > GEOMETRY_EPSILON) {
                return splitPoints(points, index, (target - passed) / length);
            }
            passed += length;
        }
        return null;
    }

    private static double fractionAt(JSONArray points, int segmentIndex, double t) {
        double total = polylineLength(points);
        double passed = 0;
        for (int index = 0; index < segmentIndex; index++) {
            passed += pointDistance(points.getJSONObject(index), points.getJSONObject(index + 1));
        }
        passed += pointDistance(points.getJSONObject(segmentIndex), points.getJSONObject(segmentIndex + 1)) * t;
        return total <= GEOMETRY_EPSILON ? 0 : passed / total;
    }

    private static double polylineLength(JSONArray points) {
        double length = 0;
        for (int index = 0; points != null && index < points.size() - 1; index++) {
            length += pointDistance(points.getJSONObject(index), points.getJSONObject(index + 1));
        }
        return length;
    }

    private static double pointDistance(JSONObject first, JSONObject second) {
        double dx = getDouble(second, "x") - getDouble(first, "x");
        double dy = getDouble(second, "y") - getDouble(first, "y");
        double dz = getDouble(second, "z") - getDouble(first, "z");
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private static boolean validSplitParts(SplitParts parts) {
        return parts != null && parts.left.size() >= 2 && parts.right.size() >= 2
                && polylineLength(parts.left) >= TRACK_SPLIT_MIN_LENGTH_M
                && polylineLength(parts.right) >= TRACK_SPLIT_MIN_LENGTH_M;
    }

    private static SegmentHit closestSegment(JSONArray points, double x, double y) {
        SegmentHit best = null;
        for (int index = 0; points != null && index < points.size() - 1; index++) {
            JSONObject start = points.getJSONObject(index);
            JSONObject end = points.getJSONObject(index + 1);
            double dx = getDouble(end, "x") - getDouble(start, "x");
            double dy = getDouble(end, "y") - getDouble(start, "y");
            double lengthSquared = dx * dx + dy * dy;
            if (lengthSquared <= GEOMETRY_EPSILON) continue;
            double t = Math.max(0, Math.min(1,
                    ((x - getDouble(start, "x")) * dx + (y - getDouble(start, "y")) * dy) / lengthSquared));
            double px = getDouble(start, "x") + dx * t;
            double py = getDouble(start, "y") + dy * t;
            double distance = Math.hypot(x - px, y - py);
            if (best == null || distance < best.distance) best = new SegmentHit(index, t, distance);
        }
        return best;
    }

    private static boolean isReverseAligned(JSONArray bottom, JSONArray top) {
        if (bottom == null || top == null || bottom.size() < 2 || top.size() < 2) return false;
        JSONObject bottomStart = bottom.getJSONObject(0);
        JSONObject bottomEnd = bottom.getJSONObject(bottom.size() - 1);
        JSONObject topStart = top.getJSONObject(0);
        JSONObject topEnd = top.getJSONObject(top.size() - 1);
        return pointDistance(bottomStart, topEnd) + pointDistance(bottomEnd, topStart)
                < pointDistance(bottomStart, topStart) + pointDistance(bottomEnd, topEnd);
    }

    static JSONArray orientedTop(JSONArray bottom, JSONArray top) {
        JSONArray result = new JSONArray();
        if (top == null) return result;
        if (isReverseAligned(bottom, top)) {
            for (int index = top.size() - 1; index >= 0; index--) result.add(copyPoint(top.getJSONObject(index)));
        } else {
            result.addAll(copyPoints(top));
        }
        return result;
    }

    private static double[] pointToWorld(JSONObject point, Pose pose, boolean worldVertical) {
        return localToWorld(getDouble(point, "x"), getDouble(point, "y"), getDouble(point, "z"), pose, worldVertical);
    }

    private static double worldDistanceXY(double[] first, double[] second) {
        if (first == null || second == null) return Double.POSITIVE_INFINITY;
        return Math.hypot(first[0] - second[0], first[1] - second[1]);
    }

    private static void throwSplitConflict(List<Long> frameIds) {
        List<Long> failures = frameIds.stream().distinct().sorted().collect(Collectors.toList());
        Map<String, Object> data = new HashMap<>();
        data.put("frameIds", failures);
        throw new ApiException(HttpStatus.CONFLICT, UsecaseCode.PARAM_ERROR,
                "Track split failed because some frames cannot be mapped", data);
    }

    @Transactional(rollbackFor = Exception.class)
    public SyncResult syncByDataIdAndTrackId(Long dataId, String trackId, Long classId) {
        return syncByDataIdAndTrackId(dataId, trackId, classId, null);
    }

    @Transactional(rollbackFor = Exception.class)
    public SyncResult syncByDataIdAndTrackId(Long dataId, String trackId, Long classId, Long sourceObjectId) {
        if (ObjectUtil.isNull(dataId) || StrUtil.isBlank(trackId)) {
            return SyncResult.empty();
        }
        var objects = dataAnnotationObjectDAO.list(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .eq(DataAnnotationObject::getDataId, dataId)
                .eq(DataAnnotationObject::getTrackId, trackId));
        var sourceCandidates = objects.stream()
                .filter(obj -> ObjectUtil.isNotNull(obj.getClassAttributes()))
                .filter(obj -> trackId.equals(obj.getClassAttributes().getStr("trackId")))
                .filter(TrackSyncUseCase::hasSyncableObject)
                .filter(obj -> classId == null || sameClassId(obj, classId))
                .collect(Collectors.toList());
        log.info(
                "Sync source candidates: dataId={}, trackId={}, classId={}, candidates={}",
                dataId,
                trackId,
                classId,
                sourceCandidates.stream()
                        .map(candidate -> String.format(
                                "id=%s,type=%s,motionMode=%s",
                                candidate.getId(),
                                candidate.getClassAttributes().getStr("type"),
                                candidate.getClassAttributes().getStr("motionMode")))
                        .collect(Collectors.toList()));
        if (sourceCandidates.isEmpty()) {
            throw new IllegalArgumentException(
                    String.format("No syncable 3D object found: dataId=%s, trackId=%s", dataId, trackId));
        }
        return syncOne(DefaultConverter.convert(
                selectSyncSource(sourceCandidates, sourceObjectId), DataAnnotationObjectBO.class));
    }

    @Transactional(rollbackFor = Exception.class)
    public ManualSyncSegmentSplitResult splitManualSyncSegment(ManualSyncSegmentSplitRequest request) {
        if (request == null
                || request.dataId == null
                || request.sourceObjectId == null
                || StrUtil.isBlank(request.trackId)) {
            throw new IllegalArgumentException("dataId, trackId and sourceObjectId are required");
        }
        DataInfo sourceFrame = dataInfoDAO.getById(request.dataId);
        if (sourceFrame == null || sourceFrame.getParentId() == null) {
            throw new IllegalArgumentException(String.format("Scene frame not found: dataId=%s", request.dataId));
        }
        List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sourceFrame.getParentId())
                .eq(DataInfo::getIsDeleted, false)
                .orderByAsc(DataInfo::getOrderName));
        int splitFrameIndex = findFrameIndex(frames, request.dataId);
        if (splitFrameIndex < 0 || splitFrameIndex >= frames.size() - 1) {
            throw new IllegalArgumentException("The current frame must have a following frame to split");
        }
        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        List<DataAnnotationObject> sceneObjects = dataAnnotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .in(DataAnnotationObject::getDataId, frameIds)
                        .eq(DataAnnotationObject::getTrackId, request.trackId));
        DataAnnotationObject source = sceneObjects.stream()
                .filter(object -> request.sourceObjectId.equals(object.getId()))
                .filter(object -> request.dataId.equals(object.getDataId()))
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> request.trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(TrackSyncUseCase::hasSyncableObject)
                .filter(object -> request.classId == null || sameClassId(object, request.classId))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("The selected sync object was not found"));
        JSONObject sourceAttributes = source.getClassAttributes();
        if (!supportsLocationSegmentSplit(sourceAttributes)) {
            throw new IllegalArgumentException(
                    "Only 3D_BOX, GROUND_POLYGON and GROUND_POLYLINE support location segment splits");
        }
        int sourceSegmentId = manualSyncSegmentId(source.getClassAttributes());
        List<DataAnnotationObject> segmentObjects = sceneObjects.stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> request.trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> sameObjectType(sourceAttributes, object.getClassAttributes()))
                .filter(object -> request.classId == null || sameClassId(object, request.classId))
                .filter(object -> manualSyncSegmentId(object.getClassAttributes()) == sourceSegmentId)
                .collect(Collectors.toList());
        Map<Long, Integer> frameIndexById = new HashMap<>();
        for (int index = 0; index < frames.size(); index++) {
            frameIndexById.put(frames.get(index).getId(), index);
        }
        int sourceStartIndex = manualSegmentStartIndex(
                source.getClassAttributes(), frameIndexById, frames.size());
        int sourceEndIndex = manualSegmentEndIndex(
                source.getClassAttributes(), frameIndexById, frames.size());
        if (splitFrameIndex < sourceStartIndex || splitFrameIndex >= sourceEndIndex) {
            throw new IllegalArgumentException("The current frame is outside the selected segment or at its end");
        }
        boolean hasFollowingObject = segmentObjects.stream()
                .map(DataAnnotationObject::getDataId)
                .map(frameIndexById::get)
                .anyMatch(index -> index != null && index > splitFrameIndex && index <= sourceEndIndex);
        if (!hasFollowingObject) {
            throw new IllegalArgumentException("The selected segment has no object after the current frame");
        }
        int nextSegmentId = sceneObjects.stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> request.trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> sameObjectType(sourceAttributes, object.getClassAttributes()))
                .filter(object -> request.classId == null || sameClassId(object, request.classId))
                .map(DataAnnotationObject::getClassAttributes)
                .filter(ObjectUtil::isNotNull)
                .mapToInt(TrackSyncUseCase::manualSyncSegmentId)
                .max()
                .orElse(0) + 1;
        List<DataAnnotationObject> updates = new ArrayList<>();
        Set<Long> affectedDataIds = new HashSet<>();
        for (DataAnnotationObject object : segmentObjects) {
            Integer frameIndex = frameIndexById.get(object.getDataId());
            if (frameIndex == null) {
                continue;
            }
            int targetSegmentId = frameIndex > splitFrameIndex ? nextSegmentId : sourceSegmentId;
            JSONObject attrs = object.getClassAttributes();
            Long targetStartDataId = frames.get(
                    frameIndex > splitFrameIndex ? splitFrameIndex + 1 : sourceStartIndex).getId();
            Long targetEndDataId = frames.get(
                    frameIndex > splitFrameIndex ? sourceEndIndex : splitFrameIndex).getId();
            if (manualSyncSegmentId(attrs) != targetSegmentId
                    || !targetStartDataId.equals(attrs.getLong(MANUAL_SYNC_SEGMENT_START_DATA_ID))
                    || !targetEndDataId.equals(attrs.getLong(MANUAL_SYNC_SEGMENT_END_DATA_ID))) {
                attrs.set(MANUAL_SYNC_SEGMENT_ID, targetSegmentId);
                attrs.set(MANUAL_SYNC_SEGMENT_START_DATA_ID, targetStartDataId);
                attrs.set(MANUAL_SYNC_SEGMENT_END_DATA_ID, targetEndDataId);
                attrs.remove(MANUAL_SYNC_SEGMENT_BOUNDARY_DATA_ID);
                object.setClassAttributes(attrs);
                updates.add(object);
                affectedDataIds.add(object.getDataId());
            }
        }
        if (CollUtil.isNotEmpty(updates)) {
            dataAnnotationObjectDAO.getBaseMapper().mysqlInsertOrUpdateBatch(updates);
        }
        return new ManualSyncSegmentSplitResult(
                sourceSegmentId,
                nextSegmentId,
                affectedDataIds.stream().sorted().collect(Collectors.toList()));
    }

    @Transactional(rollbackFor = Exception.class)
    public ManualSyncSegmentSplitResult mergeManualSyncSegment(ManualSyncSegmentSplitRequest request) {
        if (request == null
                || request.dataId == null
                || request.sourceObjectId == null
                || StrUtil.isBlank(request.trackId)) {
            throw new IllegalArgumentException("dataId, trackId and sourceObjectId are required");
        }
        DataInfo sourceFrame = dataInfoDAO.getById(request.dataId);
        if (sourceFrame == null || sourceFrame.getParentId() == null) {
            throw new IllegalArgumentException(String.format("Scene frame not found: dataId=%s", request.dataId));
        }
        List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sourceFrame.getParentId())
                .eq(DataInfo::getIsDeleted, false)
                .orderByAsc(DataInfo::getOrderName));
        Map<Long, Integer> frameIndexById = frameIndexes(frames);
        List<DataAnnotationObject> sceneObjects = dataAnnotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .in(DataAnnotationObject::getDataId,
                                frames.stream().map(DataInfo::getId).collect(Collectors.toList()))
                        .eq(DataAnnotationObject::getTrackId, request.trackId));
        DataAnnotationObject source = sceneObjects.stream()
                .filter(object -> request.sourceObjectId.equals(object.getId()))
                .filter(object -> request.dataId.equals(object.getDataId()))
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> request.trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(TrackSyncUseCase::hasSyncableObject)
                .filter(object -> request.classId == null || sameClassId(object, request.classId))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("The selected sync object was not found"));
        String sourceType = source.getClassAttributes().getStr("type");
        if (!"3D_BOX".equals(sourceType)
                && !GROUND_POLYGON.equals(sourceType)
                && !IRREGULAR_WALL.equals(sourceType)) {
            throw new IllegalArgumentException(
                    "Only 3D_BOX, GROUND_POLYGON and IRREGULAR_WALL support location segment merges");
        }
        int currentSegmentId = manualSyncSegmentId(source.getClassAttributes());
        int currentStart = manualSegmentStartIndex(source.getClassAttributes(), frameIndexById, frames.size());
        int currentEnd = manualSegmentEndIndex(source.getClassAttributes(), frameIndexById, frames.size());
        List<DataAnnotationObject> trackObjects = sceneObjects.stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> request.trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> sourceType.equals(object.getClassAttributes().getStr("type")))
                .filter(object -> request.classId == null || sameClassId(object, request.classId))
                .collect(Collectors.toList());
        DataAnnotationObject previous = trackObjects.stream()
                .filter(object -> manualSyncSegmentId(object.getClassAttributes()) != currentSegmentId)
                .filter(object -> manualSegmentEndIndex(
                        object.getClassAttributes(), frameIndexById, frames.size()) == currentStart - 1)
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException(
                        "The current segment has no previous adjacent segment to merge"));
        int previousSegmentId = manualSyncSegmentId(previous.getClassAttributes());
        int previousStart = manualSegmentStartIndex(
                previous.getClassAttributes(), frameIndexById, frames.size());
        List<DataAnnotationObject> updates = new ArrayList<>();
        Set<Long> affectedDataIds = new HashSet<>();
        for (DataAnnotationObject object : trackObjects) {
            int segmentId = manualSyncSegmentId(object.getClassAttributes());
            if (segmentId != previousSegmentId && segmentId != currentSegmentId) {
                continue;
            }
            JSONObject attrs = object.getClassAttributes();
            attrs.set(MANUAL_SYNC_SEGMENT_ID, previousSegmentId);
            attrs.set(MANUAL_SYNC_SEGMENT_START_DATA_ID, frames.get(previousStart).getId());
            attrs.set(MANUAL_SYNC_SEGMENT_END_DATA_ID, frames.get(currentEnd).getId());
            attrs.remove(MANUAL_SYNC_SEGMENT_BOUNDARY_DATA_ID);
            object.setClassAttributes(attrs);
            updates.add(object);
            affectedDataIds.add(object.getDataId());
        }
        if (CollUtil.isNotEmpty(updates)) {
            dataAnnotationObjectDAO.getBaseMapper().mysqlInsertOrUpdateBatch(updates);
        }
        return new ManualSyncSegmentSplitResult(
                currentSegmentId,
                previousSegmentId,
                affectedDataIds.stream().sorted().collect(Collectors.toList()));
    }

    static DataAnnotationObject selectSyncSource(
            List<DataAnnotationObject> sourceCandidates, Long sourceObjectId) {
        if (sourceObjectId == null) {
            return sourceCandidates.get(0);
        }
        return sourceCandidates.stream()
                .filter(candidate -> sourceObjectId.equals(candidate.getId()))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException(
                        String.format("Selected sync source was not found: objectId=%s", sourceObjectId)));
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
                                .eq(DataAnnotationObject::getDataId, dataId)
                                .eq(DataAnnotationObject::getTrackId, trackId))
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

    public Map<Long, Integer> findManualSyncSegments(Long dataId, String trackId) {
        if (ObjectUtil.isNull(dataId) || StrUtil.isBlank(trackId)) {
            return Map.of();
        }
        DataInfo sourceFrame = dataInfoDAO.getById(dataId);
        if (ObjectUtil.isNull(sourceFrame) || ObjectUtil.isNull(sourceFrame.getParentId())) {
            return Map.of();
        }
        List<Long> frameIds = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                        .eq(DataInfo::getParentId, sourceFrame.getParentId())
                        .eq(DataInfo::getIsDeleted, false))
                .stream()
                .map(DataInfo::getId)
                .collect(Collectors.toList());
        return dataAnnotationObjectDAO.list(Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .in(DataAnnotationObject::getDataId, frameIds)
                        .eq(DataAnnotationObject::getTrackId, trackId))
                .stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> object.getClassAttributes().containsKey(MANUAL_SYNC_SEGMENT_ID))
                .collect(Collectors.toMap(
                        DataAnnotationObject::getDataId,
                        object -> manualSyncSegmentId(object.getClassAttributes()),
                        (first, ignored) -> first));
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
                .in(DataAnnotationObject::getDataId, frameIds)
                .eq(DataAnnotationObject::getTrackId, trackId));
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
                && !MOTION_SEMI_STATIC.equals(motionMode)
                && !MOTION_DYNAMIC_FIXED_SIZE.equals(motionMode)
                && !MOTION_DYNAMIC_VARIABLE_SIZE.equals(motionMode)) {
            return SyncResult.empty();
        }
        log.info(
                "Synchronizing track: sourceDataId={}, trackId={}, motionMode={}, type={}",
                source.getDataId(),
                trackId,
                motionMode,
                attrs.getStr("type"));

        var dataset = datasetDAO.getById(source.getDatasetId());
        if (ObjectUtil.isNull(dataset) || !Boolean.TRUE.equals(dataset.getSyncMode())) {
            return SyncResult.empty();
        }

        var sourceFrame = dataInfoDAO.getById(source.getDataId());
        if (ObjectUtil.isNull(sourceFrame) || ObjectUtil.isNull(sourceFrame.getParentId())) {
            return SyncResult.empty();
        }
        Long sceneId = sourceFrame.getParentId();
        long inputLoadStartedAt = System.nanoTime();

        var frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .select(DataInfo::getId, DataInfo::getName, DataInfo::getOrderName)
                .eq(DataInfo::getParentId, sceneId)
                .eq(DataInfo::getIsDeleted, false)
                .orderByAsc(DataInfo::getOrderName));
        if (CollUtil.isEmpty(frames)) {
            return SyncResult.empty();
        }
        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        boolean dynamicRangeSyncEnabled = getBoolean(attrs, "dynamicRangeSyncEnabled", false);
        boolean dynamicRangeMotionMode = dynamicRangeSyncEnabled
                && (MOTION_DYNAMIC_FIXED_SIZE.equals(motionMode)
                || MOTION_DYNAMIC_VARIABLE_SIZE.equals(motionMode));
        int sourceFrameIndex = dynamicRangeMotionMode
                ? findFrameIndex(frames, source.getDataId())
                : -1;
        List<DataInfo> objectQueryFrames = dynamicRangeMotionMode && sourceFrameIndex >= 0
                ? dynamicWindowIndexes(
                        frames.size(),
                        sourceFrameIndex,
                        getNonNegativeInt(
                                attrs,
                                "dynamicSyncPreviousFrames",
                                DEFAULT_DYNAMIC_SYNC_PREVIOUS_FRAMES),
                        getNonNegativeInt(
                                attrs,
                                "dynamicSyncNextFrames",
                                DEFAULT_DYNAMIC_SYNC_NEXT_FRAMES))
                        .stream()
                        .map(frames::get)
                        .collect(Collectors.toList())
                : frames;
        List<Long> objectQueryFrameIds = objectQueryFrames.stream()
                .map(DataInfo::getId)
                .collect(Collectors.toList());
        // Read only this track's rows. The (data_id, track_id) index avoids materializing
        // unrelated annotations from large scenes before the type-specific sync filters run.
        var existingObjects = dataAnnotationObjectDAO.list(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .in(DataAnnotationObject::getDataId, objectQueryFrameIds)
                .eq(DataAnnotationObject::getTrackId, trackId));
        existingObjects.forEach(DataAnnotationObject::capturePersistedSyncState);

        int locationGapMs = getPositiveInt(attrs, "syncLocationGapMs", DEFAULT_SYNC_LOCATION_GAP_MS);
        boolean groundPolygon = isGroundPolygon(attrs);
        boolean groundPolyline = isGroundPolyline(attrs);
        boolean irregularWall = isIrregularWall(attrs);
        boolean requiresPose = requiresScenePose(motionMode, dynamicRangeSyncEnabled);
        boolean requiresSegments = (!groundPolygon && !groundPolyline && !irregularWall)
                || (groundPolygon
                && (MOTION_DYNAMIC_FIXED_SIZE.equals(motionMode)
                || MOTION_DYNAMIC_VARIABLE_SIZE.equals(motionMode)));
        Map<Long, Pose> poseByDataId = requiresPose
                ? dynamicRangeMotionMode
                ? buildPoseByDataId(sceneId, objectQueryFrames, objectQueryFrameIds)
                : getOrBuildScenePoses(sceneId, frames, frameIds)
                : Map.of();
        Map<Long, Integer> segmentByDataId = requiresSegments
                ? buildSegmentByDataId(sceneId, frames, locationGapMs)
                : Map.of();
        log.info(
                "Sync input loaded: sourceDataId={}, trackId={}, frameCount={}, trackObjectCount={}, poseLoaded={}, "
                        + "segmentLoaded={}, elapsedMs={}",
                source.getDataId(),
                trackId,
                frames.size(),
                existingObjects.size(),
                requiresPose,
                requiresSegments,
                (System.nanoTime() - inputLoadStartedAt) / 1_000_000);

        boolean syncWorldVertical = useWorldVerticalSync(attrs);
        if (groundPolygon && MOTION_STATIC.equals(motionMode)) {
            requireScenePose(poseByDataId, source.getDataId());
            double syncRadius = getPositiveDouble(attrs, "syncDistance", DEFAULT_GROUND_POLYGON_SYNC_RADIUS_M);
            return syncGroundPolygon(
                    source, trackId, syncRadius, frames, poseByDataId, syncWorldVertical, existingObjects);
        }
        if (groundPolygon && MOTION_DYNAMIC_FIXED_SIZE.equals(motionMode)) {
            return syncGroundPolygonDynamicFixedSize(
                    source, trackId, frames, poseByDataId, syncWorldVertical, existingObjects,
                    segmentByDataId, locationGapMs);
        }
        if (groundPolygon && MOTION_DYNAMIC_VARIABLE_SIZE.equals(motionMode)) {
            return syncGroundPolygonDynamicVariableSize(
                    source, trackId, frames, poseByDataId, syncWorldVertical, existingObjects,
                    segmentByDataId, locationGapMs);
        }
        if (groundPolygon && MOTION_SEMI_STATIC.equals(motionMode)) {
            requireScenePose(poseByDataId, source.getDataId());
            double initialSyncRadius = getPositiveDouble(
                    attrs, "syncDistance", DEFAULT_GROUND_POLYGON_SYNC_RADIUS_M);
            double semiStaticSyncRadius = getPositiveDouble(
                    attrs, "semiStaticSyncDistance", DEFAULT_SEMI_STATIC_SYNC_RADIUS_M);
            SyncResult result = syncGroundPolygonSemiStatic(
                    source,
                    trackId,
                    initialSyncRadius,
                    semiStaticSyncRadius,
                    frames,
                    poseByDataId,
                    syncWorldVertical,
                    existingObjects,
                    locationGapMs
            );
            return propagateSemiStaticMotionMode(source, trackId, existingObjects, result);
        }
        if (groundPolyline) {
            if (MOTION_STATIC.equals(motionMode)) {
                requireScenePose(poseByDataId, source.getDataId());
                double syncRadius = getPositiveDouble(
                        attrs, "syncDistance", DEFAULT_GROUND_POLYLINE_SYNC_RADIUS_M);
                return syncGroundPolyline(
                        source, trackId, syncRadius, frames, poseByDataId, syncWorldVertical, existingObjects);
            }
            return SyncResult.empty();
        }
        if (irregularWall && MOTION_STATIC.equals(motionMode)) {
            requireScenePose(poseByDataId, source.getDataId());
            double syncRadius = getPositiveDouble(
                    attrs, "syncDistance", DEFAULT_GROUND_POLYLINE_SYNC_RADIUS_M);
            return syncIrregularWall(
                    source, trackId, syncRadius, frames, poseByDataId, syncWorldVertical, existingObjects);
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
        } else if (MOTION_SEMI_STATIC.equals(motionMode)) {
            requireScenePose(poseByDataId, source.getDataId());
            double initialSyncRadius = getPositiveDouble(attrs, "syncDistance", DEFAULT_STATIC_SYNC_RADIUS_M);
            double semiStaticSyncRadius = getPositiveDouble(
                    attrs, "semiStaticSyncDistance", DEFAULT_SEMI_STATIC_SYNC_RADIUS_M);
            boolean syncUseZ = getBoolean(attrs, "syncUseZ", true);
            double syncYawOffset = Math.toRadians(getDouble(attrs, "syncYawOffsetDeg"));
            double syncXOffset = getDouble(attrs, "syncXOffsetM");
            double syncYOffset = getDouble(attrs, "syncYOffsetM");
            boolean initialized = getBoolean(attrs, "semiStaticSyncInitialized", false)
                    || existingByDataId.values().stream()
                    .map(DataAnnotationObject::getClassAttributes)
                    .filter(ObjectUtil::isNotNull)
                    .anyMatch(existingAttrs -> getBoolean(existingAttrs, "semiStaticSyncInitialized", false));
            SyncResult result = syncSemiStatic(
                    source,
                    trackId,
                    center3D,
                    size3D,
                    contour.getJSONObject("rotation3D"),
                    initialSyncRadius,
                    semiStaticSyncRadius,
                    initialized,
                    syncUseZ,
                    syncWorldVertical,
                    syncYawOffset,
                    syncXOffset,
                    syncYOffset,
                    frames,
                    poseByDataId,
                    existingByDataId,
                    existingRows.duplicateObjectIds,
                    reachableFrameIds,
                    maxDisappearGap,
                    segmentByDataId,
                    locationGapMs,
                    segmentsInitialized
            );
            return propagateSemiStaticMotionMode(source, trackId, existingObjects, result);
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
                    locationGapMs,
                    getPendingSyncQuarterTurns(attrs)
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
        copyClassId(attrs, source.getClassId());
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
        double sourceWorldZ = worldPoints.stream().mapToDouble(point -> point[2]).average()
                .orElseThrow(() -> new IllegalStateException(
                        String.format("Parking slot has no world points: dataId=%s, trackId=%s",
                                source.getDataId(), trackId)));

        Map<Long, DataAnnotationObject> existingByDataId = existingObjects.stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                // A track retains its identity when an annotator changes class
                // (for example car -> parkingspace).  Matching the old target
                // row by class here would insert a second P annotation instead
                // of updating that row to the source class.
                .filter(object -> isGroundPolygon(object.getClassAttributes()))
                .collect(Collectors.toMap(
                        DataAnnotationObject::getDataId,
                        object -> object,
                        (first, ignored) -> first));

        List<DataAnnotationObject> inserts = new ArrayList<>();
        List<DataAnnotationObject> updates = new ArrayList<>();
        List<Long> deleteIds = new ArrayList<>();
        Map<Long, Integer> frameIndexes = frameIndexes(frames);
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
            boolean sameManualSegment = existing == null
                    ? isFrameInManualSyncSegment(sourceAttrs, frameIndexes, frame.getId())
                    : isSameManualSyncSegment(sourceAttrs, existing.getClassAttributes());
            if (!sameManualSegment) {
                if (existing != null) {
                    contour.set("points", applyFixedPolygonShape(sourcePoints, contour.getJSONArray("points")));
                    copyClassId(attrs, source.getClassId());
                    attrs.set("type", GROUND_POLYGON);
                    attrs.set("trackId", trackId);
                    attrs.set("motionMode", MOTION_STATIC);
                    attrs.set("syncUseZ", getBoolean(sourceAttrs, "syncUseZ", true));
                    attrs.set("syncDistance", syncRadius);
                    attrs.set("parkingOpeningEdge", "P3_P0");
                    existing.setClassId(source.getClassId());
                    existing.setClassAttributes(attrs);
                    updates.add(existing);
                }
                continue;
            }
            // The source frame is the user-confirmed parking-slot annotation and
            // must never be deleted by the propagation radius check.  Only target
            // frames outside the sync range are omitted/removed.
            if (
                    !frame.getId().equals(source.getDataId())
                            && !isWithinStaticSyncRange(
                                    distanceToGroundShapeFootprint(targetPoints),
                                    syncRadius,
                                    sourceWorldZ,
                                    targetPose.z,
                                    getBoolean(sourceAttrs, "syncUseZ", true))) {
                if (existing != null) {
                    deleteIds.add(existing.getId());
                }
                continue;
            }
            contour.set("points", targetPoints);
            copyClassId(attrs, source.getClassId());
            attrs.set("type", "GROUND_POLYGON");
            attrs.set("trackId", trackId);
            attrs.set("motionMode", MOTION_STATIC);
            // Keep the target editor's sync settings aligned with the source,
            // including the user's choice to preserve local Z on later syncs.
            attrs.set("syncUseZ", getBoolean(sourceAttrs, "syncUseZ", true));
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

    private SyncResult syncGroundPolygonSemiStatic(
            DataAnnotationObjectBO source,
            String trackId,
            double initialSyncRadius,
            double semiStaticSyncRadius,
            List<DataInfo> frames,
            Map<Long, Pose> poseByDataId,
            boolean syncWorldVertical,
            List<DataAnnotationObject> existingObjects,
            int locationGapMs) {
        JSONObject sourceAttrs = source.getClassAttributes();
        JSONArray sourcePoints = groundPolygonPoints(sourceAttrs, source.getDataId(), trackId);
        Pose sourcePose = poseByDataId.get(source.getDataId());
        List<double[]> worldPoints = new ArrayList<>(4);
        for (int index = 0; index < 4; index++) {
            JSONObject point = sourcePoints.getJSONObject(index);
            double[] worldPoint = localToWorld(
                    getDouble(point, "x"),
                    getDouble(point, "y"),
                    getDouble(point, "z"),
                    sourcePose,
                    syncWorldVertical);
            worldPoints.add(worldPoint);
        }

        Map<Long, DataAnnotationObject> existingByDataId = groundPolygonsByTrack(existingObjects, trackId);
        boolean initialized = getBoolean(sourceAttrs, "semiStaticSyncInitialized", false)
                || existingByDataId.values().stream()
                .map(DataAnnotationObject::getClassAttributes)
                .filter(ObjectUtil::isNotNull)
                .anyMatch(attrs -> getBoolean(attrs, "semiStaticSyncInitialized", false));
        boolean sourcePositionLocked = isSourceGroundPolygonPositionLockEligible(
                source, semiStaticSyncRadius);
        int maxDisappearGap = getNonNegativeInt(
                sourceAttrs, "syncMaxDisappearGap", DEFAULT_SYNC_MAX_DISAPPEAR_GAP);
        List<DataAnnotationObject> inserts = new ArrayList<>();
        List<DataAnnotationObject> updates = new ArrayList<>();
        Map<Long, Integer> frameIndexes = frameIndexes(frames);

        for (DataInfo frame : frames) {
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            Pose targetPose = poseByDataId.get(frame.getId());
            if (targetPose == null || !targetPose.complete) {
                continue;
            }
            if (frame.getId().equals(source.getDataId())) {
                if (existing != null) {
                    JSONObject attrs = JSONUtil.parseObj(JSONUtil.toJsonStr(existing.getClassAttributes()));
                    updateGroundPolygonSemiStaticMetadata(
                            attrs,
                            source,
                            trackId,
                            initialSyncRadius,
                            semiStaticSyncRadius,
                            maxDisappearGap,
                            locationGapMs);
                    existing.setClassId(source.getClassId());
                    existing.setClassAttributes(attrs);
                    updates.add(existing);
                }
                continue;
            }

            boolean sameManualSegment = existing == null
                    ? isFrameInManualSyncSegment(sourceAttrs, frameIndexes, frame.getId())
                    : isSameManualSyncSegment(sourceAttrs, existing.getClassAttributes());
            if (!sameManualSegment) {
                if (existing != null) {
                    JSONObject attrs = JSONUtil.parseObj(JSONUtil.toJsonStr(existing.getClassAttributes()));
                    JSONObject contour = attrs.getJSONObject("contour");
                    if (contour != null) {
                        contour.set("points", applyFixedPolygonShape(sourcePoints, contour.getJSONArray("points")));
                    }
                    updateGroundPolygonSemiStaticMetadata(
                            attrs,
                            source,
                            trackId,
                            initialSyncRadius,
                            semiStaticSyncRadius,
                            maxDisappearGap,
                            locationGapMs);
                    existing.setClassId(source.getClassId());
                    existing.setClassAttributes(attrs);
                    updates.add(existing);
                }
                continue;
            }

            JSONArray projectedPoints = new JSONArray();
            for (double[] worldPoint : worldPoints) {
                double[] localPoint = worldToLocal(
                        worldPoint[0], worldPoint[1], worldPoint[2], targetPose, syncWorldVertical);
                projectedPoints.add(point3D(localPoint[0], localPoint[1], localPoint[2]));
            }
            double distance = distanceToGroundPolygonFootprint(projectedPoints);
            if (distance > initialSyncRadius) {
                continue;
            }

            boolean targetPositionLocked = existing != null
                    && getBoolean(existing.getClassAttributes(), SEMI_STATIC_POSITION_LOCKED, false);
            boolean syncPosition = !shouldPreserveSemiStaticPosition(sourcePositionLocked, targetPositionLocked)
                    && shouldSyncSemiStaticPosition(initialized, distance, semiStaticSyncRadius);
            if (!syncPosition && existing == null) {
                continue;
            }

            JSONObject attrs = JSONUtil.parseObj(JSONUtil.toJsonStr(
                    existing == null ? sourceAttrs : existing.getClassAttributes()));
            JSONObject contour = attrs.getJSONObject("contour");
            if (contour == null) {
                contour = new JSONObject();
                attrs.set("contour", contour);
            }
            if (syncPosition) {
                contour.set("points", projectedPoints);
            } else {
                contour.set("points", applyFixedPolygonShape(sourcePoints, contour.getJSONArray("points")));
            }
            updateGroundPolygonSemiStaticMetadata(
                    attrs,
                    source,
                    trackId,
                    initialSyncRadius,
                    semiStaticSyncRadius,
                    maxDisappearGap,
                    locationGapMs);
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
        return applyChanges(inserts, updates, new ArrayList<>());
    }

    private void updateGroundPolygonSemiStaticMetadata(
            JSONObject attrs,
            DataAnnotationObjectBO source,
            String trackId,
            double initialSyncRadius,
            double semiStaticSyncRadius,
            int maxDisappearGap,
            int locationGapMs) {
        boolean sourcePositionLocked = isSourceGroundPolygonPositionLockEligible(source, semiStaticSyncRadius);
        copyClassId(attrs, source.getClassId());
        attrs.set("type", GROUND_POLYGON);
        attrs.set("trackId", trackId);
        attrs.set("motionMode", MOTION_SEMI_STATIC);
        attrs.set("syncDistance", initialSyncRadius);
        attrs.set("semiStaticSyncDistance", semiStaticSyncRadius);
        attrs.set("semiStaticSyncInitialized",
                !sourcePositionLocked || getBoolean(attrs, "semiStaticSyncInitialized", false));
        attrs.set("syncUseZ", getBoolean(source.getClassAttributes(), "syncUseZ", true));
        attrs.set("parkingOpeningEdge", "P3_P0");
        attrs.remove("syncDirty");
        updateSyncMetadata(attrs, maxDisappearGap, null, locationGapMs);
    }

    private SyncResult syncGroundPolygonDynamicFixedSize(
            DataAnnotationObjectBO source,
            String trackId,
            List<DataInfo> frames,
            Map<Long, Pose> poseByDataId,
            boolean syncWorldVertical,
            List<DataAnnotationObject> existingObjects,
            Map<Long, Integer> segmentByDataId,
            int locationGapMs) {
        JSONObject sourceAttrs = source.getClassAttributes();
        int maxDisappearGap = getNonNegativeInt(
                sourceAttrs, "syncMaxDisappearGap", DEFAULT_SYNC_MAX_DISAPPEAR_GAP);
        if (getBoolean(sourceAttrs, "dynamicRangeSyncEnabled", false)) {
            requireScenePose(poseByDataId, source.getDataId());
            int previousFrames = getNonNegativeInt(
                    sourceAttrs, "dynamicSyncPreviousFrames", DEFAULT_DYNAMIC_SYNC_PREVIOUS_FRAMES);
            int nextFrames = getNonNegativeInt(
                    sourceAttrs, "dynamicSyncNextFrames", DEFAULT_DYNAMIC_SYNC_NEXT_FRAMES);
            return syncGroundPolygonDynamicRange(
                    source,
                    trackId,
                    frames,
                    poseByDataId,
                    syncWorldVertical,
                    existingObjects,
                    previousFrames,
                    nextFrames,
                    maxDisappearGap,
                    segmentByDataId,
                    locationGapMs,
                    MOTION_DYNAMIC_FIXED_SIZE);
        }
        return syncGroundPolygonFixedShape(
                source, trackId, existingObjects, maxDisappearGap, segmentByDataId, locationGapMs);
    }

    /**
     * Variable-size parking slots keep independent per-frame shapes. Without range sync only the
     * motion mode and dynamic configuration are propagated; with range sync, existing frames in
     * the window are aligned to the source position and heading while keeping their own shape.
     */
    private SyncResult syncGroundPolygonDynamicVariableSize(
            DataAnnotationObjectBO source,
            String trackId,
            List<DataInfo> frames,
            Map<Long, Pose> poseByDataId,
            boolean syncWorldVertical,
            List<DataAnnotationObject> existingObjects,
            Map<Long, Integer> segmentByDataId,
            int locationGapMs) {
        JSONObject sourceAttrs = source.getClassAttributes();
        int maxDisappearGap = getNonNegativeInt(
                sourceAttrs, "syncMaxDisappearGap", DEFAULT_SYNC_MAX_DISAPPEAR_GAP);
        if (getBoolean(sourceAttrs, "dynamicRangeSyncEnabled", false)) {
            requireScenePose(poseByDataId, source.getDataId());
            int previousFrames = getNonNegativeInt(
                    sourceAttrs, "dynamicSyncPreviousFrames", DEFAULT_DYNAMIC_SYNC_PREVIOUS_FRAMES);
            int nextFrames = getNonNegativeInt(
                    sourceAttrs, "dynamicSyncNextFrames", DEFAULT_DYNAMIC_SYNC_NEXT_FRAMES);
            return syncGroundPolygonDynamicRange(
                    source,
                    trackId,
                    frames,
                    poseByDataId,
                    syncWorldVertical,
                    existingObjects,
                    previousFrames,
                    nextFrames,
                    maxDisappearGap,
                    segmentByDataId,
                    locationGapMs,
                    MOTION_DYNAMIC_VARIABLE_SIZE);
        }
        List<DataAnnotationObject> updates = new ArrayList<>();
        for (DataAnnotationObject existing : groundPolygonsByTrack(existingObjects, trackId).values()) {
            JSONObject attrs = JSONUtil.parseObj(JSONUtil.toJsonStr(existing.getClassAttributes()));
            copyClassId(attrs, source.getClassId());
            attrs.set("motionMode", MOTION_DYNAMIC_VARIABLE_SIZE);
            copyDynamicSyncConfiguration(attrs, sourceAttrs);
            updateSyncMetadata(
                    attrs, maxDisappearGap, segmentByDataId.get(existing.getDataId()), locationGapMs);
            existing.setClassId(source.getClassId());
            existing.setClassAttributes(attrs);
            updates.add(existing);
        }
        return applyChanges(new ArrayList<>(), updates, new ArrayList<>());
    }

    /**
     * Copy the source parking-slot footprint onto polygons that already exist for this track.
     * Each target keeps its own center and heading.
     */
    private SyncResult syncGroundPolygonFixedShape(
            DataAnnotationObjectBO source,
            String trackId,
            List<DataAnnotationObject> existingObjects,
            int maxDisappearGap,
            Map<Long, Integer> segmentByDataId,
            int locationGapMs) {
        JSONObject sourceAttrs = source.getClassAttributes();
        JSONArray sourcePoints = groundPolygonPoints(sourceAttrs, source.getDataId(), trackId);
        List<DataAnnotationObject> updates = new ArrayList<>();
        for (DataAnnotationObject existing : groundPolygonsByTrack(existingObjects, trackId).values()) {
            JSONObject attrs = JSONUtil.parseObj(JSONUtil.toJsonStr(existing.getClassAttributes()));
            JSONObject contour = attrs.getJSONObject("contour");
            contour.set("points", applyFixedPolygonShape(sourcePoints, contour.getJSONArray("points")));
            copyClassId(attrs, source.getClassId());
            attrs.set("type", GROUND_POLYGON);
            attrs.set("trackId", trackId);
            attrs.set("motionMode", MOTION_DYNAMIC_FIXED_SIZE);
            attrs.set("parkingOpeningEdge", "P3_P0");
            copyDynamicSyncConfiguration(attrs, sourceAttrs);
            updateSyncMetadata(
                    attrs, maxDisappearGap, segmentByDataId.get(existing.getDataId()), locationGapMs);
            existing.setClassId(source.getClassId());
            existing.setClassAttributes(attrs);
            updates.add(existing);
        }
        return applyChanges(new ArrayList<>(), updates, new ArrayList<>());
    }

    /**
     * Project the source parking slot as a rigid footprint into the dynamic frame window.
     * Frames outside the window are left unchanged.
     */
    private SyncResult syncGroundPolygonDynamicRange(
            DataAnnotationObjectBO source,
            String trackId,
            List<DataInfo> frames,
            Map<Long, Pose> poseByDataId,
            boolean syncWorldVertical,
            List<DataAnnotationObject> existingObjects,
            int previousFrames,
            int nextFrames,
            int maxDisappearGap,
            Map<Long, Integer> segmentByDataId,
            int locationGapMs,
            String motionMode) {
        JSONObject sourceAttrs = source.getClassAttributes();
        JSONArray sourcePoints = groundPolygonPoints(sourceAttrs, source.getDataId(), trackId);
        Pose sourcePose = poseByDataId.get(source.getDataId());
        int sourceIndex = findFrameIndex(frames, source.getDataId());
        if (sourceIndex < 0 || sourcePose == null || !sourcePose.complete) {
            throw new IllegalStateException(String.format(
                    "Dynamic range sync requires source pose: dataId=%s, trackId=%s",
                    source.getDataId(), trackId));
        }
        List<double[]> worldPoints = new ArrayList<>(4);
        for (int index = 0; index < 4; index++) {
            JSONObject point = sourcePoints.getJSONObject(index);
            if (point == null) {
                throw new IllegalArgumentException(String.format(
                        "Parking slot point is invalid: dataId=%s, index=%s", source.getDataId(), index));
            }
            worldPoints.add(localToWorld(
                    getDouble(point, "x"),
                    getDouble(point, "y"),
                    getDouble(point, "z"),
                    sourcePose,
                    syncWorldVertical));
        }
        Map<Long, DataAnnotationObject> existingByDataId = groundPolygonsByTrack(existingObjects, trackId);
        List<DataAnnotationObject> inserts = new ArrayList<>();
        List<DataAnnotationObject> updates = new ArrayList<>();
        boolean syncUseZ = getBoolean(sourceAttrs, "syncUseZ", true);
        for (Integer frameIndex : dynamicWindowIndexes(
                frames.size(), sourceIndex, previousFrames, nextFrames)) {
            DataInfo frame = frames.get(frameIndex);
            Pose targetPose = poseByDataId.get(frame.getId());
            if (targetPose == null || !targetPose.complete) {
                log.warn("Dynamic range sync skipped target without pose: sourceDataId={}, targetDataId={}, trackId={}",
                        source.getDataId(), frame.getId(), trackId);
                continue;
            }
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            JSONObject attrs = JSONUtil.parseObj(JSONUtil.toJsonStr(
                    existing == null ? sourceAttrs : existing.getClassAttributes()));
            stripFrameLocalVisibilityAttrs(attrs, existing != null);
            JSONObject contour = attrs.getJSONObject("contour");
            if (contour == null) {
                contour = new JSONObject();
                attrs.set("contour", contour);
            }
            JSONArray targetPoints = new JSONArray();
            for (double[] worldPoint : worldPoints) {
                double[] localPoint = worldToLocal(
                        worldPoint[0], worldPoint[1], worldPoint[2], targetPose, syncWorldVertical);
                targetPoints.add(point3D(localPoint[0], localPoint[1], localPoint[2]));
            }
            boolean keepExistingShape = existing != null
                    && MOTION_DYNAMIC_VARIABLE_SIZE.equals(motionMode)
                    && contour.getJSONArray("points") != null;
            contour.set("points", keepExistingShape
                    ? applyPolygonPose(contour.getJSONArray("points"), polygonPose(targetPoints))
                    : targetPoints);
            attrs.set("type", GROUND_POLYGON);
            attrs.set("trackId", trackId);
            attrs.set("parkingOpeningEdge", "P3_P0");
            updateDynamicMetadata(
                    attrs,
                    source,
                    motionMode,
                    previousFrames,
                    nextFrames,
                    maxDisappearGap,
                    segmentByDataId.get(frame.getId()),
                    locationGapMs,
                    syncUseZ,
                    syncWorldVertical);
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
        return applyChanges(inserts, updates, new ArrayList<>());
    }

    private static JSONArray groundPolygonPoints(JSONObject attrs, Long dataId, String trackId) {
        JSONObject contour = attrs == null ? null : attrs.getJSONObject("contour");
        JSONArray points = contour == null ? null : contour.getJSONArray("points");
        if (points == null || points.size() != 4) {
            throw new IllegalArgumentException(String.format(
                    "Parking slot requires exactly four points: dataId=%s, trackId=%s", dataId, trackId));
        }
        return points;
    }

    private static Map<Long, DataAnnotationObject> groundPolygonsByTrack(
            List<DataAnnotationObject> existingObjects, String trackId) {
        return existingObjects.stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                .filter(object -> isGroundPolygon(object.getClassAttributes()))
                .collect(Collectors.toMap(
                        DataAnnotationObject::getDataId,
                        object -> object,
                        (first, ignored) -> first));
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
        // Curb walls and other ground polylines use the same source geometry for every
        // target frame in this request. Keep its world representation local to this call.
        JSONArray sourceWorldPoints = polylineToWorld(sourcePoints, sourcePose, syncWorldVertical);
        Map<Long, DataAnnotationObject> existingByDataId = existingObjects.stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                // See syncGroundPolygon: class changes must update an existing
                // ground-shape track rather than fork it into a second row.
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
        boolean syncSegmentVisibility = shouldSyncSegmentVisibility(sourceAttrs);
        boolean syncUseZ = getBoolean(sourceAttrs, "syncUseZ", true);
        Map<Long, Integer> frameIndexes = frameIndexes(frames);

        List<DataAnnotationObject> inserts = new ArrayList<>();
        List<DataAnnotationObject> updates = new ArrayList<>();
        List<Long> deleteIds = new ArrayList<>();
        for (DataInfo frame : frames) {
            // The source row was saved before entering sync and is the user-approved
            // truth. Propagation radius rules apply only to target frames; otherwise a
            // curb drawn farther than its configured radius can delete its own source.
            if (frame.getId().equals(source.getDataId())) {
                continue;
            }
            if (!reachableFrameIds.contains(frame.getId())) {
                continue;
            }
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            JSONObject existingAttrs = existing == null ? null : existing.getClassAttributes();
            if (!isManualSyncSegmentTarget(sourceAttrs, existingAttrs, frameIndexes, frame.getId())) {
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
            // Segment visibility is a per-frame camera observation.  A newly created synced
            // row must never inherit either manual or automatic occlusion from its source.
            if (existing == null) {
                contour.remove("segmentVisibilityByView");
                contour.remove("segmentForceVisibleByView");
                attrs.remove("autoCurbOcclusionPointCloudPending");
                attrs.set("autoCurbOcclusionPending", true);
            }
            JSONArray existingPoints = null;
            if (syncSegmentVisibility && existing != null && existing.getClassAttributes() != null) {
                JSONObject existingContour = existing.getClassAttributes().getJSONObject("contour");
                existingPoints = existingContour == null ? null : existingContour.getJSONArray("points");
            }
            JSONArray projectedPoints = polylineToLocal(sourceWorldPoints, targetPose, syncWorldVertical);
            PolylineDistanceMask distanceMask = splitGroundPolylineBySyncRange(
                    projectedPoints,
                    sourceWorldPoints,
                    syncRadius,
                    targetPose.z,
                    syncUseZ);
            if (isGroundPolylineFullyOutside(distanceMask.outsideSegments)) {
                if (existing != null) {
                    deleteIds.add(existing.getId());
                }
                continue;
            }
            contour.set("points", distanceMask.points);
            if (existing == null) {
                // The target frame must start with no source-frame visibility state.  Its own
                // camera-local visibility is calculated once by the editor when opened.
                contour.remove("segmentVisibilityByView");
                contour.remove("segmentForceVisibleByView");
            } else if (syncSegmentVisibility) {
                JSONArray visibilityReferencePoints = existingPoints == null
                        ? projectedPoints
                        : existingPoints;
                contour.set("segmentVisibilityByView", buildDistanceVisibility(
                        contour.getJSONObject("segmentVisibilityByView"),
                        visibilityReferencePoints,
                        distanceMask.points,
                        distanceMask.outsideSegments));
            }
            attrs.set("type", GROUND_POLYLINE);
            copyClassId(attrs, source.getClassId());
            attrs.set("trackId", trackId);
            attrs.set("motionMode", MOTION_STATIC);
            attrs.set("syncUseZ", getBoolean(sourceAttrs, "syncUseZ", true));
            attrs.set("syncDistance", syncRadius);
            attrs.set("syncMaxDisappearGap", maxDisappearGap);
            attrs.set("wallHeight", wallHeight);
            attrs.set("showSyncLocationBoundaries", showSyncLocationBoundaries);
            attrs.set("syncSegmentVisibility", syncSegmentVisibility);
            // A completed propagation is authoritative for every target frame.  In
            // particular, a target may have been saved as dirty before Ctrl+Y was
            // pressed; leaving that flag in its copied attributes keeps the timeline
            // progress cell cyan even though its geometry has just been synchronized.
            attrs.set("syncDirty", false);
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

    private SyncResult syncIrregularWall(DataAnnotationObjectBO source, String trackId, double syncRadius,
                                         List<DataInfo> frames, Map<Long, Pose> poseByDataId,
                                         boolean syncWorldVertical, List<DataAnnotationObject> existingObjects) {
        JSONObject sourceAttrs = source.getClassAttributes();
        JSONObject sourceContour = sourceAttrs.getJSONObject("contour");
        JSONArray sourceBottom = sourceContour == null ? null : sourceContour.getJSONArray("bottomPoints");
        JSONArray sourceTop = sourceContour == null ? null : sourceContour.getJSONArray("topPoints");
        if (sourceBottom == null || sourceBottom.size() < 2 || (sourceTop != null && sourceTop.size() == 1)) {
            throw new IllegalArgumentException("Irregular wall requires a bottom polyline and an optional complete top polyline");
        }
        Pose sourcePose = poseByDataId.get(source.getDataId());
        // The source wall and its pose are immutable for this sync request. Convert each
        // boundary once, then only transform the cached world points into each target frame.
        // Keeping this cache local to the request means a later edit or pose update always
        // starts from freshly computed world coordinates.
        JSONArray sourceBottomWorld = polylineToWorld(sourceBottom, sourcePose, syncWorldVertical);
        JSONArray sourceTopWorld = sourceTop == null || sourceTop.isEmpty()
                ? new JSONArray()
                : polylineToWorld(sourceTop, sourcePose, syncWorldVertical);
        Map<Long, DataAnnotationObject> existingByDataId = existingObjects.stream()
                .filter(object -> object.getClassAttributes() != null)
                .filter(object -> trackId.equals(object.getClassAttributes().getStr("trackId")))
                // Ground-shape identity is trackId plus shape type, not class.
                .filter(object -> isIrregularWall(object.getClassAttributes()))
                .collect(Collectors.toMap(DataAnnotationObject::getDataId, object -> object, (first, ignored) -> first));
        Map<Long, Integer> frameIndexes = frameIndexes(frames);
        List<DataAnnotationObject> inserts = new ArrayList<>();
        List<DataAnnotationObject> updates = new ArrayList<>();
        List<Long> deleteIds = new ArrayList<>();
        for (DataInfo frame : frames) {
            // As with ground polylines, the source wall is not a propagation target.
            // It must never be removed merely because it lies outside syncDistance.
            if (frame.getId().equals(source.getDataId())) {
                continue;
            }
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            JSONObject existingAttrs = existing == null ? null : existing.getClassAttributes();
            if (!isManualSyncSegmentTarget(sourceAttrs, existingAttrs, frameIndexes, frame.getId())) {
                continue;
            }
            Pose targetPose = poseByDataId.get(frame.getId());
            if (targetPose == null || !targetPose.complete) continue;
            JSONArray bottomPoints = polylineToLocal(sourceBottomWorld, targetPose, syncWorldVertical);
            IrregularWallSyncGeometry geometry = clipIrregularWallToSyncRange(
                    bottomPoints,
                    sourceBottomWorld,
                    sourceTopWorld,
                    targetPose,
                    syncRadius,
                    getBoolean(sourceAttrs, "syncUseZ", true));
            if (geometry.bottomPoints.size() < 2) {
                if (existing != null) deleteIds.add(existing.getId());
                continue;
            }
            JSONObject attrs = JSONUtil.parseObj(JSONUtil.toJsonStr(
                    existing == null ? sourceAttrs : existing.getClassAttributes()));
            JSONObject contour = attrs.getJSONObject("contour");
            if (contour == null) { contour = new JSONObject(); attrs.set("contour", contour); }
            contour.set("bottomPoints", geometry.bottomPoints);
            contour.set("topPoints", geometry.topPoints);
            // Keep a conventional points contour for clients that use the bottom
            // boundary for generic shape indexing.
            contour.set("points", geometry.bottomPoints);
            copyClassId(attrs, source.getClassId());
            attrs.set("type", IRREGULAR_WALL);
            attrs.set("trackId", trackId);
            attrs.set("motionMode", MOTION_STATIC);
            attrs.set("syncUseZ", getBoolean(sourceAttrs, "syncUseZ", true));
            attrs.set("syncDistance", syncRadius);
            // Do not inherit a target frame's pre-sync dirty state.  The frontend
            // uses this value for the TrackLine color, so it must be cleared along
            // with the synchronized irregular-wall geometry.
            attrs.set("syncDirty", false);
            if (existing == null) {
                inserts.add(DataAnnotationObject.builder().datasetId(source.getDatasetId()).dataId(frame.getId())
                        .classId(source.getClassId()).classAttributes(attrs).sourceId(-1L)
                        .sourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW).createdAt(OffsetDateTime.now())
                        .createdBy(source.getCreatedBy()).build());
            } else {
                existing.setClassId(source.getClassId()); existing.setClassAttributes(attrs); updates.add(existing);
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

    static PolylineDistanceMask splitGroundPolylineBySyncRange(
            JSONArray projectedPoints,
            JSONArray worldPoints,
            double radius,
            double targetSensorWorldZ,
            boolean syncUseZ) {
        if (
                projectedPoints == null ||
                worldPoints == null ||
                projectedPoints.size() < 2 ||
                projectedPoints.size() != worldPoints.size()) {
            throw new IllegalArgumentException("Projected and world ground polyline points must have equal sizes of at least two");
        }
        if (radius <= 0) {
            throw new IllegalArgumentException(String.format(
                    "Ground polyline sync radius must be positive: radius=%s", radius));
        }
        JSONArray splitProjectedPoints = new JSONArray();
        JSONArray splitWorldPoints = new JSONArray();
        splitProjectedPoints.add(copyPoint(requireGroundPoint(projectedPoints, 0)));
        splitWorldPoints.add(copyPoint(requireGroundPoint(worldPoints, 0)));
        for (int index = 1; index < projectedPoints.size(); index++) {
            JSONObject projectedStart = requireGroundPoint(projectedPoints, index - 1);
            JSONObject projectedEnd = requireGroundPoint(projectedPoints, index);
            JSONObject worldStart = requireGroundPoint(worldPoints, index - 1);
            JSONObject worldEnd = requireGroundPoint(worldPoints, index);
            List<Double> parameters = new ArrayList<>(circleSegmentIntersections(
                    getDouble(projectedStart, "x"),
                    getDouble(projectedStart, "y"),
                    getDouble(projectedEnd, "x"),
                    getDouble(projectedEnd, "y"),
                    radius));
            if (syncUseZ) {
                double startZ = getDouble(worldStart, "z");
                double deltaZ = getDouble(worldEnd, "z") - startZ;
                if (Math.abs(deltaZ) > GEOMETRY_EPSILON) {
                    for (double boundaryZ : new double[]{
                            targetSensorWorldZ - STATIC_SYNC_VERTICAL_TOLERANCE_M,
                            targetSensorWorldZ + STATIC_SYNC_VERTICAL_TOLERANCE_M}) {
                        double parameter = (boundaryZ - startZ) / deltaZ;
                        if (parameter > GEOMETRY_EPSILON && parameter < 1 - GEOMETRY_EPSILON) {
                            parameters.add(parameter);
                        }
                    }
                }
            }
            parameters.sort(Double::compare);
            double previousParameter = Double.NaN;
            for (double parameter : parameters) {
                if (!Double.isNaN(previousParameter) &&
                        Math.abs(parameter - previousParameter) <= GEOMETRY_EPSILON) {
                    continue;
                }
                splitProjectedPoints.add(interpolatePoint(projectedStart, projectedEnd, parameter));
                splitWorldPoints.add(interpolatePoint(worldStart, worldEnd, parameter));
                previousParameter = parameter;
            }
            splitProjectedPoints.add(copyPoint(projectedEnd));
            splitWorldPoints.add(copyPoint(worldEnd));
        }

        List<Boolean> outsideSegments = new ArrayList<>();
        double radiusSquared = radius * radius;
        for (int index = 1; index < splitProjectedPoints.size(); index++) {
            JSONObject projectedStart = splitProjectedPoints.getJSONObject(index - 1);
            JSONObject projectedEnd = splitProjectedPoints.getJSONObject(index);
            double middleX = (getDouble(projectedStart, "x") + getDouble(projectedEnd, "x")) / 2;
            double middleY = (getDouble(projectedStart, "y") + getDouble(projectedEnd, "y")) / 2;
            boolean outsideRadius = middleX * middleX + middleY * middleY >
                    radiusSquared + GEOMETRY_EPSILON;
            JSONObject worldStart = splitWorldPoints.getJSONObject(index - 1);
            JSONObject worldEnd = splitWorldPoints.getJSONObject(index);
            double middleWorldZ = (getDouble(worldStart, "z") + getDouble(worldEnd, "z")) / 2;
            boolean outsideHeight = syncUseZ &&
                    Math.abs(middleWorldZ - targetSensorWorldZ) >
                            STATIC_SYNC_VERTICAL_TOLERANCE_M + GEOMETRY_EPSILON;
            outsideSegments.add(outsideRadius || outsideHeight);
        }
        return new PolylineDistanceMask(splitProjectedPoints, outsideSegments);
    }

    static IrregularWallSyncGeometry clipIrregularWallToSyncRange(
            JSONArray projectedBottomPoints,
            JSONArray worldBottomPoints,
            JSONArray worldTopPoints,
            Pose targetPose,
            double radius,
            boolean syncUseZ) {
        PolylineDistanceMask mask = splitGroundPolylineBySyncRange(
                projectedBottomPoints,
                worldBottomPoints,
                radius,
                targetPose.z,
                syncUseZ);
        JSONArray bottomPoints = nearestVisiblePolylineComponent(mask);
        if (bottomPoints.size() < 2 || worldTopPoints == null || worldTopPoints.isEmpty()) {
            return new IrregularWallSyncGeometry(bottomPoints, new JSONArray());
        }
        JSONArray orientedTopPoints = orientWallTopPoints(worldBottomPoints, worldTopPoints);
        JSONArray topPoints = new JSONArray();
        JSONArray bottomWorldPoints = polylineToWorld(bottomPoints, targetPose, true);
        for (int index = 0; index < bottomWorldPoints.size(); index++) {
            double parameter = polylineParameterAtPoint(
                    worldBottomPoints,
                    bottomWorldPoints.getJSONObject(index));
            JSONObject topWorldPoint = interpolatePolylineAtParameter(orientedTopPoints, parameter);
            double[] topLocalPoint = worldToLocal(
                    getDouble(topWorldPoint, "x"),
                    getDouble(topWorldPoint, "y"),
                    getDouble(topWorldPoint, "z"),
                    targetPose,
                    true);
            topPoints.add(point3D(topLocalPoint[0], topLocalPoint[1], topLocalPoint[2]));
        }
        return new IrregularWallSyncGeometry(bottomPoints, topPoints);
    }

    private static JSONArray nearestVisiblePolylineComponent(PolylineDistanceMask mask) {
        List<JSONArray> components = new ArrayList<>();
        JSONArray current = new JSONArray();
        for (int index = 1; index < mask.points.size(); index++) {
            if (mask.outsideSegments.get(index - 1)) {
                addComponent(components, current);
                current = new JSONArray();
                continue;
            }
            JSONObject start = mask.points.getJSONObject(index - 1);
            JSONObject end = mask.points.getJSONObject(index);
            if (current.isEmpty()) {
                current.add(copyPoint(start));
            }
            if (!samePoint(current.getJSONObject(current.size() - 1), end)) {
                current.add(copyPoint(end));
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

    private static JSONArray orientWallTopPoints(JSONArray bottomPoints, JSONArray topPoints) {
        if (topPoints.size() < 2) {
            return topPoints;
        }
        JSONObject bottomStart = requireGroundPoint(bottomPoints, 0);
        JSONObject bottomEnd = requireGroundPoint(bottomPoints, bottomPoints.size() - 1);
        JSONObject topStart = requireGroundPoint(topPoints, 0);
        JSONObject topEnd = requireGroundPoint(topPoints, topPoints.size() - 1);
        double directDistance = squaredDistance(bottomStart, topStart) + squaredDistance(bottomEnd, topEnd);
        double reversedDistance = squaredDistance(bottomStart, topEnd) + squaredDistance(bottomEnd, topStart);
        if (directDistance <= reversedDistance) {
            return topPoints;
        }
        JSONArray reversed = new JSONArray();
        for (int index = topPoints.size() - 1; index >= 0; index--) {
            reversed.add(copyPoint(requireGroundPoint(topPoints, index)));
        }
        return reversed;
    }

    private static double polylineParameterAtPoint(JSONArray points, JSONObject point) {
        double totalLength = groundPolylineLength(points);
        if (totalLength <= GEOMETRY_EPSILON) {
            return 0;
        }
        double accumulatedLength = 0;
        double nearestDistanceSquared = Double.POSITIVE_INFINITY;
        double nearestParameter = 0;
        for (int index = 1; index < points.size(); index++) {
            JSONObject start = requireGroundPoint(points, index - 1);
            JSONObject end = requireGroundPoint(points, index);
            double segmentX = getDouble(end, "x") - getDouble(start, "x");
            double segmentY = getDouble(end, "y") - getDouble(start, "y");
            double segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
            double segmentLength = Math.sqrt(segmentLengthSquared);
            if (segmentLength <= GEOMETRY_EPSILON) {
                continue;
            }
            double pointX = getDouble(point, "x") - getDouble(start, "x");
            double pointY = getDouble(point, "y") - getDouble(start, "y");
            double ratio = Math.max(0, Math.min(1,
                    (pointX * segmentX + pointY * segmentY) / segmentLengthSquared));
            double deltaX = pointX - ratio * segmentX;
            double deltaY = pointY - ratio * segmentY;
            double distanceSquared = deltaX * deltaX + deltaY * deltaY;
            if (distanceSquared < nearestDistanceSquared) {
                nearestDistanceSquared = distanceSquared;
                nearestParameter = (accumulatedLength + ratio * segmentLength) / totalLength;
            }
            accumulatedLength += segmentLength;
        }
        return nearestParameter;
    }

    private static JSONObject interpolatePolylineAtParameter(JSONArray points, double parameter) {
        double totalLength = groundPolylineLength(points);
        if (totalLength <= GEOMETRY_EPSILON) {
            return copyPoint(requireGroundPoint(points, 0));
        }
        double targetLength = Math.max(0, Math.min(1, parameter)) * totalLength;
        double accumulatedLength = 0;
        for (int index = 1; index < points.size(); index++) {
            JSONObject start = requireGroundPoint(points, index - 1);
            JSONObject end = requireGroundPoint(points, index);
            double segmentLength = Math.sqrt(squaredDistance(start, end));
            if (segmentLength > GEOMETRY_EPSILON &&
                    targetLength <= accumulatedLength + segmentLength + GEOMETRY_EPSILON) {
                return interpolatePoint(start, end, (targetLength - accumulatedLength) / segmentLength);
            }
            accumulatedLength += segmentLength;
        }
        return copyPoint(requireGroundPoint(points, points.size() - 1));
    }

    private static double groundPolylineLength(JSONArray points) {
        double length = 0;
        for (int index = 1; index < points.size(); index++) {
            length += Math.sqrt(squaredDistance(
                    requireGroundPoint(points, index - 1),
                    requireGroundPoint(points, index)));
        }
        return length;
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

    static double distanceToGroundPolygonFootprint(JSONArray points) {
        if (points == null || points.size() < 3) {
            return Double.POSITIVE_INFINITY;
        }
        if (isPointInsideGroundPolygon(points, 0, 0)) {
            return 0;
        }
        double distance = Double.POSITIVE_INFINITY;
        for (int index = 0; index < points.size(); index++) {
            JSONObject start = points.getJSONObject(index);
            JSONObject end = points.getJSONObject((index + 1) % points.size());
            if (start == null || end == null) {
                continue;
            }
            distance = Math.min(distance, distanceToSegment(
                    0,
                    0,
                    getDouble(start, "x"),
                    getDouble(start, "y"),
                    getDouble(end, "x"),
                    getDouble(end, "y")));
        }
        return distance;
    }

    private static boolean isPointInsideGroundPolygon(JSONArray points, double pointX, double pointY) {
        boolean inside = false;
        for (int current = 0, previous = points.size() - 1; current < points.size(); previous = current++) {
            JSONObject currentPoint = points.getJSONObject(current);
            JSONObject previousPoint = points.getJSONObject(previous);
            if (currentPoint == null || previousPoint == null) {
                return false;
            }
            double currentX = getDouble(currentPoint, "x");
            double currentY = getDouble(currentPoint, "y");
            double previousX = getDouble(previousPoint, "x");
            double previousY = getDouble(previousPoint, "y");
            boolean crossesRay = (currentY > pointY) != (previousY > pointY)
                    && pointX < (previousX - currentX) * (pointY - currentY)
                    / (previousY - currentY) + currentX;
            if (crossesRay) {
                inside = !inside;
            }
        }
        return inside;
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

    private SyncResult syncSemiStatic(
            DataAnnotationObjectBO source,
            String trackId,
            JSONObject center3D,
            JSONObject size3D,
            JSONObject rotation3D,
            double initialSyncRadius,
            double semiStaticSyncRadius,
            boolean initialized,
            boolean syncUseZ,
            boolean syncWorldVertical,
            double syncYawOffset,
            double syncXOffset,
            double syncYOffset,
            List<DataInfo> frames,
            Map<Long, Pose> poseByDataId,
            Map<Long, DataAnnotationObject> existingByDataId,
            List<Long> duplicateObjectIds,
            Set<Long> reachableFrameIds,
            int maxDisappearGap,
            Map<Long, Integer> segmentByDataId,
            int locationGapMs,
            boolean segmentsInitialized) {
        double localX = getDouble(center3D, "x");
        double localY = getDouble(center3D, "y");
        double localZ = getDouble(center3D, "z");
        double localYaw = rotation3D == null ? 0 : getDouble(rotation3D, "z");
        double rotX = rotation3D == null ? 0 : getDouble(rotation3D, "x");
        double rotY = rotation3D == null ? 0 : getDouble(rotation3D, "y");

        Pose sourcePose = poseByDataId.get(source.getDataId());
        Pose effectiveSourcePose = withYawOffset(sourcePose, syncYawOffset);
        boolean useWorldVertical = syncUseZ;
        double[] worldPoint = localToWorld(localX, localY, localZ, effectiveSourcePose, useWorldVertical);
        double worldX = worldPoint[0];
        double worldY = worldPoint[1];
        double worldZ = worldPoint[2];
        double worldYaw = localYaw + effectiveSourcePose.yaw;
        Integer sourceSegmentId = segmentByDataId.get(source.getDataId());
        boolean sourcePositionLocked = isSourceSemiStaticPositionLockEligible(source, semiStaticSyncRadius);
        Map<Long, Integer> frameIndexes = frameIndexes(frames);

        var toInsert = new ArrayList<DataAnnotationObject>();
        var toUpdate = new ArrayList<DataAnnotationObject>();
        var toDeleteIds = new ArrayList<>(duplicateObjectIds);
        for (DataInfo frame : frames) {
            Integer targetSegmentId = segmentByDataId.get(frame.getId());
            DataAnnotationObject existing = existingByDataId.get(frame.getId());
            boolean sameManualSegment = existing == null
                    ? isFrameInManualSyncSegment(source.getClassAttributes(), frameIndexes, frame.getId())
                    : isSameManualSyncSegment(source.getClassAttributes(), existing.getClassAttributes());
            boolean canProjectPosition = poseByDataId.containsKey(frame.getId())
                    && reachableFrameIds.contains(frame.getId())
                    && (!segmentsInitialized || ObjectUtil.equal(sourceSegmentId, targetSegmentId))
                    && sameManualSegment;
            if (!canProjectPosition) {
                updateSemiStaticExisting(
                        existing,
                        source,
                        size3D,
                        initialSyncRadius,
                        semiStaticSyncRadius,
                        syncUseZ,
                        syncWorldVertical,
                        syncYawOffset,
                        syncXOffset,
                        syncYOffset,
                        maxDisappearGap,
                        targetSegmentId,
                        locationGapMs,
                        toUpdate);
                continue;
            }
            if (frame.getId().equals(source.getDataId())) {
                updateSemiStaticExisting(
                        existing,
                        source,
                        size3D,
                        initialSyncRadius,
                        semiStaticSyncRadius,
                        syncUseZ,
                        syncWorldVertical,
                        syncYawOffset,
                        syncXOffset,
                        syncYOffset,
                        maxDisappearGap,
                        targetSegmentId,
                        locationGapMs,
                        toUpdate
                );
                continue;
            }

            Pose targetPose = poseByDataId.get(frame.getId());
            Pose effectiveTargetPose = withYawOffset(targetPose, syncYawOffset);
            double[] targetLocal = worldToLocal(worldX, worldY, worldZ, effectiveTargetPose, useWorldVertical);
            double targetLocalX = targetLocal[0] + syncXOffset;
            double targetLocalY = targetLocal[1] + syncYOffset;
            double targetLocalZ = syncUseZ ? targetLocal[2] : localZ;
            double targetLocalYaw = worldYaw - effectiveTargetPose.yaw;
            double distance = distanceToBoxFootprint(targetLocalX, targetLocalY, targetLocalYaw, size3D);
            boolean sameLevel = !syncUseZ
                    || Math.abs(worldZ - targetPose.z) <= STATIC_SYNC_VERTICAL_TOLERANCE_M;
            if (!isWithinSemiStaticTrackRange(
                    distance, initialSyncRadius, worldZ, targetPose.z, syncUseZ)) {
                continue;
            }

            boolean targetPositionLocked = existing != null
                    && getBoolean(existing.getClassAttributes(), SEMI_STATIC_POSITION_LOCKED, false);
            boolean syncPosition = !shouldPreserveSemiStaticPosition(sourcePositionLocked, targetPositionLocked)
                    && shouldSyncSemiStaticPosition(initialized, distance, semiStaticSyncRadius)
                    && sameLevel;
            if (!syncPosition && existing != null) {
                updateSemiStaticExisting(
                        existing,
                        source,
                        size3D,
                        initialSyncRadius,
                        semiStaticSyncRadius,
                        syncUseZ,
                        syncWorldVertical,
                        syncYawOffset,
                        syncXOffset,
                        syncYOffset,
                        maxDisappearGap,
                        targetSegmentId,
                        locationGapMs,
                        toUpdate
                );
                continue;
            }
            if (!syncPosition && sourcePositionLocked) {
                continue;
            }
            if (!syncPosition && !sameLevel) {
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
            newContour.set("center3D", new JSONObject()
                    .set("x", targetLocalX)
                    .set("y", targetLocalY)
                    .set("z", targetLocalZ));
            newContour.set("rotation3D", new JSONObject()
                    .set("x", rotX)
                    .set("y", rotY)
                    .set("z", targetLocalYaw));
            newAttrs.set("trackId", trackId);
            updateSemiStaticMetadata(
                    newAttrs,
                    source,
                    size3D,
                    initialSyncRadius,
                    semiStaticSyncRadius,
                    syncUseZ,
                    syncWorldVertical,
                    syncYawOffset,
                    syncXOffset,
                    syncYOffset,
                    maxDisappearGap,
                    targetSegmentId,
                    locationGapMs
            );
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

    static boolean shouldSyncSemiStaticPosition(
            boolean initialized, double horizontalDistance, double semiStaticSyncRadius) {
        return !initialized || horizontalDistance <= semiStaticSyncRadius;
    }

    static boolean shouldPreserveSemiStaticPosition(boolean sourcePositionLocked, boolean targetPositionLocked) {
        return sourcePositionLocked || targetPositionLocked;
    }

    static boolean isSemiStaticPositionLockEligible(
            boolean requested, double sourceDistance, double semiStaticSyncRadius) {
        return requested && sourceDistance <= semiStaticSyncRadius;
    }

    private static boolean isSourceSemiStaticPositionLockEligible(
            DataAnnotationObjectBO source, double semiStaticSyncRadius) {
        JSONObject attrs = source.getClassAttributes();
        if (!getBoolean(attrs, SEMI_STATIC_POSITION_LOCKED, false)) {
            return false;
        }
        JSONObject contour = attrs.getJSONObject("contour");
        JSONObject center3D = contour == null ? null : contour.getJSONObject("center3D");
        JSONObject size3D = contour == null ? null : contour.getJSONObject("size3D");
        if (center3D == null || size3D == null) {
            return false;
        }
        JSONObject rotation3D = contour.getJSONObject("rotation3D");
        double sourceDistance = distanceToBoxFootprint(
                getDouble(center3D, "x"),
                getDouble(center3D, "y"),
                rotation3D == null ? 0 : getDouble(rotation3D, "z"),
                size3D);
        return isSemiStaticPositionLockEligible(true, sourceDistance, semiStaticSyncRadius);
    }

    private static boolean isSourceGroundPolygonPositionLockEligible(
            DataAnnotationObjectBO source, double semiStaticSyncRadius) {
        JSONObject attrs = source.getClassAttributes();
        if (!getBoolean(attrs, SEMI_STATIC_POSITION_LOCKED, false)) {
            return false;
        }
        return isSemiStaticPositionLockEligible(
                true,
                distanceToGroundPolygonFootprint(groundPolygonPoints(
                        attrs, source.getDataId(), attrs.getStr("trackId"))),
                semiStaticSyncRadius);
    }

    static boolean isWithinSemiStaticTrackRange(
            double horizontalDistance,
            double initialSyncRadius,
            double objectWorldZ,
            double targetSensorWorldZ,
            boolean syncUseZ) {
        return isWithinStaticSyncRange(
                horizontalDistance, initialSyncRadius, objectWorldZ, targetSensorWorldZ, syncUseZ);
    }

    private void updateSemiStaticExisting(
            DataAnnotationObject existing,
            DataAnnotationObjectBO source,
            JSONObject size3D,
            double initialSyncRadius,
            double semiStaticSyncRadius,
            boolean syncUseZ,
            boolean syncWorldVertical,
            double syncYawOffset,
            double syncXOffset,
            double syncYOffset,
            int maxDisappearGap,
            Integer targetSegmentId,
            int locationGapMs,
            List<DataAnnotationObject> toUpdate) {
        if (existing == null || ObjectUtil.isNull(existing.getClassAttributes())) {
            return;
        }
        JSONObject existingAttrs = existing.getClassAttributes();
        Object existingSyncDirty = existingAttrs.get("syncDirty");
        updateSemiStaticMetadata(
                existingAttrs,
                source,
                size3D,
                initialSyncRadius,
                semiStaticSyncRadius,
                syncUseZ,
                syncWorldVertical,
                syncYawOffset,
                syncXOffset,
                syncYOffset,
                maxDisappearGap,
                targetSegmentId,
                locationGapMs
        );
        if (existingSyncDirty == null) {
            existingAttrs.remove("syncDirty");
        } else {
            existingAttrs.set("syncDirty", existingSyncDirty);
        }
        existing.setClassId(source.getClassId());
        existing.setClassAttributes(existingAttrs);
        toUpdate.add(existing);
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
        Map<Long, Integer> frameIndexes = frameIndexes(frames);

        var toInsert = new ArrayList<DataAnnotationObject>();
        var toUpdate = new ArrayList<DataAnnotationObject>();
        var toDeleteIds = new ArrayList<>(duplicateObjectIds);

        for (DataInfo frame : frames) {
            Integer targetSegmentId = segmentByDataId.get(frame.getId());
            var existing = existingByDataId.get(frame.getId());
            boolean sameSegment = ObjectUtil.equal(sourceSegmentId, targetSegmentId);
            boolean sameManualSegment = existing == null
                    ? isFrameInManualSyncSegment(source.getClassAttributes(), frameIndexes, frame.getId())
                    : isSameManualSyncSegment(source.getClassAttributes(), existing.getClassAttributes());
            boolean canSyncPosition = srcPose != null
                    && poseByDataId.containsKey(frame.getId())
                    && reachableFrameIds.contains(frame.getId())
                    && (!segmentsInitialized || sameSegment)
                    && sameManualSegment;

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

            if (!isWithinStaticSyncRange(distance, syncRadius, worldZ, pose.z, syncUseZ)) {
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

    static boolean isWithinStaticSyncRange(
            double horizontalDistance,
            double horizontalRadius,
            double objectWorldZ,
            double targetSensorWorldZ,
            boolean syncUseZ) {
        if (horizontalDistance > horizontalRadius) return false;
        return !syncUseZ
                || Math.abs(objectWorldZ - targetSensorWorldZ) <= STATIC_SYNC_VERTICAL_TOLERANCE_M;
    }

    private void updateStaticMetadata(JSONObject attrs, DataAnnotationObjectBO source, JSONObject size3D,
                                      double syncRadius, boolean syncUseZ, boolean syncWorldVertical,
                                      double syncYawOffset, double syncXOffset, double syncYOffset,
                                      int maxDisappearGap, Integer segmentId, int locationGapMs) {
        JSONObject contour = attrs.getJSONObject("contour");
        if (contour != null) {
            contour.set("size3D", JSONUtil.parseObj(JSONUtil.toJsonStr(size3D)));
        }
        copyClassId(attrs, source.getClassId());
        attrs.set("motionMode", MOTION_STATIC);
        attrs.set("syncDistance", syncRadius);
        attrs.set("syncUseZ", syncUseZ);
        attrs.set("syncWorldVertical", syncWorldVertical);
        attrs.set("syncYawOffsetDeg", Math.toDegrees(syncYawOffset));
        attrs.set("syncXOffsetM", syncXOffset);
        attrs.set("syncYOffsetM", syncYOffset);
        updateSyncMetadata(attrs, maxDisappearGap, segmentId, locationGapMs);
    }

    private void updateSemiStaticMetadata(
            JSONObject attrs,
            DataAnnotationObjectBO source,
            JSONObject size3D,
            double initialSyncRadius,
            double semiStaticSyncRadius,
            boolean syncUseZ,
            boolean syncWorldVertical,
            double syncYawOffset,
            double syncXOffset,
            double syncYOffset,
            int maxDisappearGap,
            Integer segmentId,
            int locationGapMs) {
        JSONObject contour = attrs.getJSONObject("contour");
        if (contour != null) {
            contour.set("size3D", JSONUtil.parseObj(JSONUtil.toJsonStr(size3D)));
        }
        copyClassId(attrs, source.getClassId());
        attrs.set("motionMode", MOTION_SEMI_STATIC);
        attrs.set("syncDistance", initialSyncRadius);
        attrs.set("semiStaticSyncDistance", semiStaticSyncRadius);
        boolean sourcePositionLocked = isSourceSemiStaticPositionLockEligible(source, semiStaticSyncRadius);
        attrs.set("semiStaticSyncInitialized",
                !sourcePositionLocked || getBoolean(attrs, "semiStaticSyncInitialized", false));
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
                                Map<Long, Integer> segmentByDataId, int locationGapMs,
                                int pendingQuarterTurns) {
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
            if (!frame.getId().equals(source.getDataId()) && pendingQuarterTurns != 0) {
                applyFixedSizeOrientationTurn(existingContour, pendingQuarterTurns);
            }
            // This is an action marker, not persistent track metadata.  Clearing it on every
            // row makes a later Sync Now idempotent.
            existingAttrs.remove(PENDING_SYNC_QUARTER_TURNS);
            copyClassId(existingAttrs, source.getClassId());
            existingAttrs.set("motionMode", MOTION_DYNAMIC_FIXED_SIZE);
            copyDynamicSyncConfiguration(existingAttrs, source.getClassAttributes());
            updateSyncMetadata(existingAttrs, maxDisappearGap, segmentByDataId.get(frame.getId()), locationGapMs);
            existing.setClassId(source.getClassId());
            existing.setClassAttributes(existingAttrs);
            toUpdate.add(existing);
        }
        return applyChanges(new ArrayList<>(), toUpdate, new ArrayList<>(duplicateObjectIds));
    }

    static void applyFixedSizeOrientationTurn(JSONObject contour, int quarterTurns) {
        if (contour == null || quarterTurns == 0) return;
        JSONObject rotation = contour.getJSONObject("rotation3D");
        if (rotation == null) {
            rotation = new JSONObject();
            contour.set("rotation3D", rotation);
        }
        double yaw = getDouble(rotation, "z") + quarterTurns * Math.PI / 2.0;
        rotation.set("z", normalizeYaw(yaw));
    }

    private static int getPendingSyncQuarterTurns(JSONObject attrs) {
        if (attrs == null || !(attrs.get(PENDING_SYNC_QUARTER_TURNS) instanceof Number)) return 0;
        int turns = ((Number) attrs.get(PENDING_SYNC_QUARTER_TURNS)).intValue() % 4;
        return turns > 2 ? turns - 4 : turns < -2 ? turns + 4 : turns;
    }

    private static double normalizeYaw(double yaw) {
        double fullTurn = Math.PI * 2.0;
        yaw %= fullTurn;
        return yaw < 0.0 ? yaw + fullTurn : yaw;
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
            copyClassId(existingAttrs, source.getClassId());
            existingAttrs.set("motionMode", motionMode);
            copyDynamicSyncConfiguration(existingAttrs, source.getClassAttributes());
            updateSyncMetadata(existingAttrs, maxDisappearGap, segmentByDataId.get(frame.getId()), locationGapMs);
            existing.setClassId(source.getClassId());
            existing.setClassAttributes(existingAttrs);
            toUpdate.add(existing);
        }
        return applyChanges(new ArrayList<>(), toUpdate, new ArrayList<>(duplicateObjectIds));
    }

    private SyncResult propagateSemiStaticMotionMode(
            DataAnnotationObjectBO source,
            String trackId,
            List<DataAnnotationObject> existingObjects,
            SyncResult geometryResult) {
        JSONObject sourceAttrs = source.getClassAttributes();
        double initialSyncRadius = getPositiveDouble(
                sourceAttrs,
                "syncDistance",
                isGroundPolygon(sourceAttrs)
                        ? DEFAULT_GROUND_POLYGON_SYNC_RADIUS_M
                        : DEFAULT_STATIC_SYNC_RADIUS_M);
        double semiStaticSyncRadius = getPositiveDouble(
                sourceAttrs, "semiStaticSyncDistance", DEFAULT_SEMI_STATIC_SYNC_RADIUS_M);
        List<DataAnnotationObject> updates = new ArrayList<>();
        Set<Long> motionModeDataIds = new HashSet<>();
        for (DataAnnotationObject existing : existingObjects) {
            JSONObject existingAttrs = existing.getClassAttributes();
            if (existingAttrs == null
                    || !sameTrackId(existingAttrs, trackId)
                    || !hasSyncableObject(existing)) {
                continue;
            }
            existingAttrs.set("motionMode", MOTION_SEMI_STATIC);
            existingAttrs.set("syncDistance", initialSyncRadius);
            existingAttrs.set("semiStaticSyncDistance", semiStaticSyncRadius);
            existing.setClassAttributes(existingAttrs);
            updates.add(existing);
            motionModeDataIds.add(existing.getDataId());
        }
        SyncResult metadataResult = applyChanges(List.of(), updates, List.of());
        log.info(
                "Propagated semi-static motion mode: sourceDataId={}, trackId={}, updatedFrameCount={}",
                source.getDataId(),
                trackId,
                motionModeDataIds.size());
        return new SyncResult(mergeAffectedDataIds(
                geometryResult.getAffectedDataIds(),
                new HashSet<>(metadataResult.getAffectedDataIds())));
    }

    static Set<Long> mergeAffectedDataIds(List<Long> first, Set<Long> second) {
        Set<Long> merged = new HashSet<>(first);
        merged.addAll(second);
        return merged;
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
        putOptionalSyncPoseSegmentId(attrs, segmentId);
        attrs.set("syncPoseSegmentsInitialized", true);
        attrs.set("syncLocationGapMs", locationGapMs);
        attrs.set("syncMaxDisappearGap", maxDisappearGap);
        attrs.set("syncDirty", false);
    }

    static void putOptionalSyncPoseSegmentId(JSONObject attrs, Integer segmentId) {
        if (segmentId == null) {
            attrs.remove("syncPoseSegmentId");
        } else {
            attrs.set("syncPoseSegmentId", segmentId);
        }
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

    static boolean isSameManualSyncSegment(JSONObject sourceAttrs, JSONObject targetAttrs) {
        return manualSyncSegmentId(sourceAttrs) == manualSyncSegmentId(targetAttrs);
    }

    static boolean isManualSyncSegmentTarget(
            JSONObject sourceAttrs,
            JSONObject targetAttrs,
            Map<Long, Integer> frameIndexes,
            Long targetDataId) {
        return targetAttrs == null
                ? isFrameInManualSyncSegment(sourceAttrs, frameIndexes, targetDataId)
                : isSameManualSyncSegment(sourceAttrs, targetAttrs);
    }

    static boolean isFrameInManualSyncSegment(
            JSONObject sourceAttrs, Map<Long, Integer> frameIndexes, Long targetDataId) {
        Integer targetIndex = frameIndexes.get(targetDataId);
        if (targetIndex == null) {
            return false;
        }
        int startIndex = manualSegmentStartIndex(sourceAttrs, frameIndexes, frameIndexes.size());
        int endIndex = manualSegmentEndIndex(sourceAttrs, frameIndexes, frameIndexes.size());
        return targetIndex >= startIndex && targetIndex <= endIndex;
    }

    private static int manualSegmentStartIndex(
            JSONObject attrs, Map<Long, Integer> frameIndexes, int frameCount) {
        if (attrs == null) return 0;
        Long startDataId = attrs.containsKey(MANUAL_SYNC_SEGMENT_START_DATA_ID)
                ? attrs.getLong(MANUAL_SYNC_SEGMENT_START_DATA_ID)
                : null;
        Integer startIndex = startDataId == null ? null : frameIndexes.get(startDataId);
        if (startIndex != null) return startIndex;
        Long boundaryDataId = attrs.containsKey(MANUAL_SYNC_SEGMENT_BOUNDARY_DATA_ID)
                ? attrs.getLong(MANUAL_SYNC_SEGMENT_BOUNDARY_DATA_ID)
                : null;
        Integer boundaryIndex = boundaryDataId == null ? null : frameIndexes.get(boundaryDataId);
        return boundaryIndex != null && manualSyncSegmentId(attrs) != 0 ? boundaryIndex + 1 : 0;
    }

    private static int manualSegmentEndIndex(
            JSONObject attrs, Map<Long, Integer> frameIndexes, int frameCount) {
        if (attrs == null) return frameCount - 1;
        Long endDataId = attrs.containsKey(MANUAL_SYNC_SEGMENT_END_DATA_ID)
                ? attrs.getLong(MANUAL_SYNC_SEGMENT_END_DATA_ID)
                : null;
        Integer endIndex = endDataId == null ? null : frameIndexes.get(endDataId);
        if (endIndex != null) return endIndex;
        Long boundaryDataId = attrs.containsKey(MANUAL_SYNC_SEGMENT_BOUNDARY_DATA_ID)
                ? attrs.getLong(MANUAL_SYNC_SEGMENT_BOUNDARY_DATA_ID)
                : null;
        Integer boundaryIndex = boundaryDataId == null ? null : frameIndexes.get(boundaryDataId);
        return boundaryIndex != null && manualSyncSegmentId(attrs) == 0
                ? boundaryIndex
                : frameCount - 1;
    }

    private static int manualSyncSegmentId(JSONObject attrs) {
        Integer segmentId = attrs == null ? null : attrs.getInt(MANUAL_SYNC_SEGMENT_ID);
        return segmentId == null ? 0 : segmentId;
    }

    private static Map<Long, Integer> frameIndexes(List<DataInfo> frames) {
        Map<Long, Integer> indexes = new HashMap<>();
        for (int index = 0; index < frames.size(); index++) {
            indexes.put(frames.get(index).getId(), index);
        }
        return indexes;
    }

    private static void requireScenePose(Map<Long, Pose> poseByDataId, Long sourceDataId) {
        if (CollUtil.isEmpty(poseByDataId) || !poseByDataId.containsKey(sourceDataId)) {
            throw new IllegalStateException(
                    "Sync requires scene location data. Upload location/location.txt or re-upload the scene zip.");
        }
    }

    public void invalidateScenePoseCache(Long sceneId) {
        if (sceneId != null) {
            scenePoseCache.invalidate(sceneId);
        }
    }

    private Map<Long, Pose> getOrBuildScenePoses(
            Long sceneId,
            List<DataInfo> frames,
            List<Long> frameIds) {
        Map<Long, Pose> cached = scenePoseCache.getIfPresent(sceneId);
        if (cached != null) {
            return cached;
        }
        Map<Long, Pose> poses = buildPoseByDataId(sceneId, frames, frameIds);
        scenePoseCache.put(sceneId, poses);
        return poses;
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

    static final class PolygonPose {
        final double centerX;
        final double centerY;
        final double centerZ;
        final double yaw;

        PolygonPose(double centerX, double centerY, double centerZ, double yaw) {
            this.centerX = centerX;
            this.centerY = centerY;
            this.centerZ = centerZ;
            this.yaw = yaw;
        }
    }

    /**
     * Heading runs from the opening edge midpoint {@code (P0+P3)/2} toward the back edge
     * midpoint {@code (P1+P2)/2}.
     */
    static PolygonPose polygonPose(JSONArray points) {
        double[][] coordinates = polygonPointCoordinates(points);
        double centerX = 0;
        double centerY = 0;
        double centerZ = 0;
        for (double[] point : coordinates) {
            centerX += point[0];
            centerY += point[1];
            centerZ += point[2];
        }
        centerX /= 4.0;
        centerY /= 4.0;
        centerZ /= 4.0;
        double frontX = (coordinates[0][0] + coordinates[3][0]) / 2.0;
        double frontY = (coordinates[0][1] + coordinates[3][1]) / 2.0;
        double backX = (coordinates[1][0] + coordinates[2][0]) / 2.0;
        double backY = (coordinates[1][1] + coordinates[2][1]) / 2.0;
        return new PolygonPose(centerX, centerY, centerZ, Math.atan2(backY - frontY, backX - frontX));
    }

    /**
     * Place the source footprint on the target center and heading. Relative height offsets
     * come from the source; the target center Z is kept.
     */
    static JSONArray applyFixedPolygonShape(JSONArray sourcePoints, JSONArray targetPoints) {
        double[][] source = polygonPointCoordinates(sourcePoints);
        PolygonPose sourcePose = polygonPose(sourcePoints);
        PolygonPose targetPose = polygonPose(targetPoints);
        JSONArray result = new JSONArray();
        for (int index = 0; index < 4; index++) {
            double[] local = rotateZ(
                    source[index][0] - sourcePose.centerX,
                    source[index][1] - sourcePose.centerY,
                    -sourcePose.yaw);
            double[] placed = rotateZ(local[0], local[1], targetPose.yaw);
            result.add(point3D(
                    targetPose.centerX + placed[0],
                    targetPose.centerY + placed[1],
                    targetPose.centerZ + (source[index][2] - sourcePose.centerZ)));
        }
        return result;
    }

    /**
     * Keep the shape of {@code shapePoints} (relative to its own center and heading) and move it
     * onto {@code targetPose}. Relative height offsets come from the shape; the target center Z
     * is used.
     */
    static JSONArray applyPolygonPose(JSONArray shapePoints, PolygonPose targetPose) {
        double[][] shape = polygonPointCoordinates(shapePoints);
        PolygonPose shapePose = polygonPose(shapePoints);
        JSONArray result = new JSONArray();
        for (int index = 0; index < 4; index++) {
            double[] local = rotateZ(
                    shape[index][0] - shapePose.centerX,
                    shape[index][1] - shapePose.centerY,
                    -shapePose.yaw);
            double[] placed = rotateZ(local[0], local[1], targetPose.yaw);
            result.add(point3D(
                    targetPose.centerX + placed[0],
                    targetPose.centerY + placed[1],
                    targetPose.centerZ + (shape[index][2] - shapePose.centerZ)));
        }
        return result;
    }

    private static double[][] polygonPointCoordinates(JSONArray points) {
        if (points == null || points.size() != 4) {
            throw new IllegalArgumentException("Parking slot requires exactly four points");
        }
        double[][] coordinates = new double[4][3];
        for (int index = 0; index < 4; index++) {
            JSONObject point = points.getJSONObject(index);
            if (point == null) {
                throw new IllegalArgumentException("Parking slot point is invalid: index=" + index);
            }
            coordinates[index][0] = getDouble(point, "x");
            coordinates[index][1] = getDouble(point, "y");
            coordinates[index][2] = getDouble(point, "z");
        }
        return coordinates;
    }

    private static double[] rotateZ(double x, double y, double yaw) {
        double cos = Math.cos(yaw);
        double sin = Math.sin(yaw);
        return new double[] {x * cos - y * sin, x * sin + y * cos};
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

    static double[] localToWorld(
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

    static double[] worldToLocal(
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

    static boolean sameClass(DataAnnotationObject obj, DataAnnotationObjectBO source) {
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
        if (StrUtil.isNotBlank(sourceType) || StrUtil.isNotBlank(objType)) {
            return StrUtil.isNotBlank(sourceType) && sourceType.equals(objType);
        }
        // Unclassified ground shapes are valid sync targets. A missing class on
        // both rows means they belong to the same unclassified track variant.
        return sourceClassId == null && objClassId == null;
    }

    private static Long classIdOf(DataAnnotationObject obj) {
        if (obj.getClassId() != null) {
            return obj.getClassId();
        }
        JSONObject attrs = obj.getClassAttributes();
        return attrs == null ? null : attrs.getLong("classId");
    }

    /**
     * Hutool represents {@code JSONObject#set(key, null)} as JSONNull.  That sentinel cannot
     * be serialized by the MyBatis JSON type handler, so an unclassified track must omit the
     * optional classId attribute altogether.
     */
    private static void copyClassId(JSONObject attrs, Long classId) {
        if (classId == null) {
            attrs.remove("classId");
        } else {
            attrs.set("classId", classId);
        }
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

    static boolean requiresScenePose(String motionMode, boolean dynamicRangeSyncEnabled) {
        return MOTION_STATIC.equals(motionMode)
                || MOTION_SEMI_STATIC.equals(motionMode)
                || dynamicRangeSyncEnabled;
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
        return hasSyncableBox(object.getClassAttributes());
    }

    private static boolean hasSyncableBox(JSONObject attrs) {
        JSONObject contour = attrs == null ? null : attrs.getJSONObject("contour");
        return contour != null
                && contour.getJSONObject("center3D") != null
                && contour.getJSONObject("size3D") != null;
    }

    static boolean supportsLocationSegmentSplit(JSONObject attrs) {
        String type = attrs == null ? null : attrs.getStr("type");
        return "3D_BOX".equals(type)
                || GROUND_POLYGON.equals(type)
                || GROUND_POLYLINE.equals(type)
                || IRREGULAR_WALL.equals(type)
                || (StrUtil.isBlank(type) && hasSyncableBox(attrs));
    }

    static boolean sameObjectType(JSONObject sourceAttributes, JSONObject candidateAttributes) {
        String sourceType = sourceAttributes == null ? null : sourceAttributes.getStr("type");
        String candidateType = candidateAttributes == null ? null : candidateAttributes.getStr("type");
        return ObjectUtil.equal(sourceType, candidateType);
    }

    private static boolean hasSyncableObject(DataAnnotationObject object) {
        return hasSyncableBox(object)
                || isGroundPolygon(object.getClassAttributes())
                || isGroundPolyline(object.getClassAttributes())
                || isIrregularWall(object.getClassAttributes());
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

    /**
     * Per-track opt-in for the expensive per-view segment visibility remapping performed while
     * propagating a ground polyline. Missing legacy metadata deliberately means disabled.
     */
    static boolean shouldSyncSegmentVisibility(JSONObject attrs) {
        return getBoolean(attrs, "syncSegmentVisibility", false);
    }

    private static boolean isIrregularWall(JSONObject attrs) {
        if (attrs == null || !IRREGULAR_WALL.equals(attrs.getStr("type"))) return false;
        JSONObject contour = attrs.getJSONObject("contour");
        JSONArray bottomPoints = contour == null ? null : contour.getJSONArray("bottomPoints");
        JSONArray topPoints = contour == null ? null : contour.getJSONArray("topPoints");
        return bottomPoints != null && bottomPoints.size() >= 2
                && (topPoints == null || topPoints.isEmpty() || topPoints.size() >= 2);
    }

    private SyncResult applyChanges(List<DataAnnotationObject> toInsert, List<DataAnnotationObject> toUpdate,
                               List<Long> toDeleteIds) {
        long writeStartedAt = System.nanoTime();
        List<Long> unsnapshottedUpdateIds = toUpdate.stream()
                .filter(candidate -> !candidate.hasPersistedSyncState())
                .map(DataAnnotationObject::getId)
                .filter(ObjectUtil::isNotNull)
                .collect(Collectors.toList());
        Map<Long, DataAnnotationObject> storedById = CollUtil.isEmpty(unsnapshottedUpdateIds)
                ? Map.of()
                : dataAnnotationObjectDAO.listByIds(
                                unsnapshottedUpdateIds)
                        .stream()
                        .collect(Collectors.toMap(DataAnnotationObject::getId, object -> object));
        List<DataAnnotationObject> changedUpdates = toUpdate.stream()
                .filter(candidate -> {
                    if (candidate.hasPersistedSyncState()) {
                        return !candidate.matchesPersistedSyncState();
                    }
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
            ListUtil.split(toInsert, SYNC_WRITE_BATCH_SIZE).forEach(
                    batch -> dataAnnotationObjectDAO.getBaseMapper().insertBatch(batch));
        }
        if (CollUtil.isNotEmpty(changedUpdates)) {
            ListUtil.split(changedUpdates, SYNC_WRITE_BATCH_SIZE).forEach(
                    batch -> dataAnnotationObjectDAO.getBaseMapper().mysqlInsertOrUpdateBatch(batch));
        }
        if (CollUtil.isNotEmpty(toDeleteIds)) {
            dataAnnotationObjectDAO.removeBatchByIds(toDeleteIds);
        }
        log.info(
                "Sync changes applied: inserted={}, updated={}, deleted={}, affectedFrameCount={}, elapsedMs={}",
                toInsert.size(),
                changedUpdates.size(),
                toDeleteIds.size(),
                affectedDataIds.size(),
                (System.nanoTime() - writeStartedAt) / 1_000_000);
        return new SyncResult(affectedDataIds);
    }

    public static class TrackSplitRequest {
        private Long dataId;
        private String trackId;
        private Long classId;
        private String objectType;
        private Integer segmentIndex;
        private Double t;
        private String side;

        public Long getDataId() { return dataId; }
        public void setDataId(Long dataId) { this.dataId = dataId; }
        public String getTrackId() { return trackId; }
        public void setTrackId(String trackId) { this.trackId = trackId; }
        public Long getClassId() { return classId; }
        public void setClassId(Long classId) { this.classId = classId; }
        public String getObjectType() { return objectType; }
        public void setObjectType(String objectType) { this.objectType = objectType; }
        public Integer getSegmentIndex() { return segmentIndex; }
        public void setSegmentIndex(Integer segmentIndex) { this.segmentIndex = segmentIndex; }
        public Double getT() { return t; }
        public void setT(Double t) { this.t = t; }
        public String getSide() { return side; }
        public void setSide(String side) { this.side = side; }
    }

    public static class ManualSyncSegmentSplitRequest {
        private Long dataId;
        private String trackId;
        private Long classId;
        private Long sourceObjectId;

        public Long getDataId() { return dataId; }
        public void setDataId(Long dataId) { this.dataId = dataId; }
        public String getTrackId() { return trackId; }
        public void setTrackId(String trackId) { this.trackId = trackId; }
        public Long getClassId() { return classId; }
        public void setClassId(Long classId) { this.classId = classId; }
        public Long getSourceObjectId() { return sourceObjectId; }
        public void setSourceObjectId(Long sourceObjectId) { this.sourceObjectId = sourceObjectId; }
    }

    public static class ManualSyncSegmentSplitResult {
        private final int previousSegmentId;
        private final int nextSegmentId;
        private final List<Long> affectedDataIds;

        ManualSyncSegmentSplitResult(
                int previousSegmentId, int nextSegmentId, List<Long> affectedDataIds) {
            this.previousSegmentId = previousSegmentId;
            this.nextSegmentId = nextSegmentId;
            this.affectedDataIds = affectedDataIds;
        }

        public int getPreviousSegmentId() { return previousSegmentId; }
        public int getNextSegmentId() { return nextSegmentId; }
        public List<Long> getAffectedDataIds() { return affectedDataIds; }
    }

    public static class TrackSplitResult {
        private final String originalTrackId;
        private final String originalTrackName;
        private final String newTrackId;
        private final String newTrackName;
        private final List<Long> affectedDataIds;
        private final List<DataAnnotationObjectBO> objects;
        private final int updatedObjectCount;
        private final int createdObjectCount;
        private final int updatedProjectionCount;
        private final int createdProjectionCount;

        TrackSplitResult(String originalTrackId, String originalTrackName,
                         String newTrackId, String newTrackName,
                         List<Long> affectedDataIds, List<DataAnnotationObjectBO> objects,
                         int updatedObjectCount, int createdObjectCount,
                         int updatedProjectionCount, int createdProjectionCount) {
            this.originalTrackId = originalTrackId;
            this.originalTrackName = originalTrackName;
            this.newTrackId = newTrackId;
            this.newTrackName = newTrackName;
            this.affectedDataIds = affectedDataIds;
            this.objects = objects;
            this.updatedObjectCount = updatedObjectCount;
            this.createdObjectCount = createdObjectCount;
            this.updatedProjectionCount = updatedProjectionCount;
            this.createdProjectionCount = createdProjectionCount;
        }

        public String getOriginalTrackId() { return originalTrackId; }
        public String getOriginalTrackName() { return originalTrackName; }
        public String getNewTrackId() { return newTrackId; }
        public String getNewTrackName() { return newTrackName; }
        public List<Long> getAffectedDataIds() { return affectedDataIds; }
        public List<DataAnnotationObjectBO> getObjects() { return objects; }
        public int getUpdatedObjectCount() { return updatedObjectCount; }
        public int getCreatedObjectCount() { return createdObjectCount; }
        public int getUpdatedProjectionCount() { return updatedProjectionCount; }
        public int getCreatedProjectionCount() { return createdProjectionCount; }
    }

    static class SplitParts {
        final JSONArray left;
        final JSONArray right;
        final JSONObject cut;
        final int segmentIndex;
        final double t;

        SplitParts(JSONArray left, JSONArray right, JSONObject cut, int segmentIndex, double t) {
            this.left = left;
            this.right = right;
            this.cut = cut;
            this.segmentIndex = segmentIndex;
            this.t = t;
        }
    }

    private static class SegmentHit {
        final int segmentIndex;
        final double t;
        final double distance;

        SegmentHit(int segmentIndex, double t, double distance) {
            this.segmentIndex = segmentIndex;
            this.t = t;
            this.distance = distance;
        }
    }

    private static class ShapeSplit {
        final int originalPointCount;
        final int segmentIndex;
        final double t;
        final int originalTopPointCount;
        final int topSegmentIndex;
        final double topT;
        final boolean topReversed;
        final String originalFrontId;
        final String newFrontId;

        ShapeSplit(int originalPointCount, int segmentIndex, double t,
                   int originalTopPointCount, int topSegmentIndex, double topT,
                   boolean topReversed,
                   String originalFrontId, String newFrontId) {
            this.originalPointCount = originalPointCount;
            this.segmentIndex = segmentIndex;
            this.t = t;
            this.originalTopPointCount = originalTopPointCount;
            this.topSegmentIndex = topSegmentIndex;
            this.topT = topT;
            this.topReversed = topReversed;
            this.originalFrontId = originalFrontId;
            this.newFrontId = newFrontId;
        }
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

    static final class ScenePoseCache {
        private static final int MAX_SCENES = 64;

        private final Cache<Long, Map<Long, Pose>> posesByScene = CacheBuilder.newBuilder()
                .maximumSize(MAX_SCENES)
                .build();

        Map<Long, Pose> getIfPresent(Long sceneId) {
            return posesByScene.getIfPresent(sceneId);
        }

        void put(Long sceneId, Map<Long, Pose> poses) {
            posesByScene.put(sceneId, Map.copyOf(poses));
        }

        void invalidate(Long sceneId) {
            posesByScene.invalidate(sceneId);
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

    static class IrregularWallSyncGeometry {
        final JSONArray bottomPoints;
        final JSONArray topPoints;

        IrregularWallSyncGeometry(JSONArray bottomPoints, JSONArray topPoints) {
            this.bottomPoints = bottomPoints;
            this.topPoints = topPoints;
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
