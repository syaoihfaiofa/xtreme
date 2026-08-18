package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.SceneInferenceRunDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneInferenceRun;
import ai.basic.x1.adapter.port.rpc.dto.SceneInferenceTrackingDTO;
import ai.basic.x1.entity.DatasetInferenceConfig;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.SceneInferenceRunStatusEnum;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
public class SceneInferenceFinalizer {

    @Autowired
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    @Autowired
    private SceneInferenceRunDAO sceneInferenceRunDAO;

    @Transactional(rollbackFor = Exception.class)
    public void replaceInferenceAnnotations(SceneInferenceRun run, List<Long> frameIds,
                                            SceneInferenceTrackingDTO.Response response) {
        Map<Long, List<DataAnnotationObject>> protectedByDataId = loadProtectedAnnotations(frameIds);
        List<DataAnnotationObject> newObjects = buildAnnotations(run, response, protectedByDataId);

        dataAnnotationObjectDAO.remove(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .in(DataAnnotationObject::getDataId, frameIds)
                .eq(DataAnnotationObject::getSourceType, DataAnnotationObjectSourceTypeEnum.INFERENCE));
        if (CollUtil.isNotEmpty(newObjects)) {
            dataAnnotationObjectDAO.saveBatch(newObjects);
        }

        sceneInferenceRunDAO.updateById(SceneInferenceRun.builder()
                .id(run.getId())
                .status(SceneInferenceRunStatusEnum.SUCCEEDED)
                .progress(1.0)
                .completedFrames(run.getTotalFrames())
                .affectedDataIds(frameIds)
                .build());
    }

    private Map<Long, List<DataAnnotationObject>> loadProtectedAnnotations(List<Long> frameIds) {
        List<DataAnnotationObject> protectedObjects = dataAnnotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .in(DataAnnotationObject::getDataId, frameIds)
                        .in(DataAnnotationObject::getSourceType,
                                DataAnnotationObjectSourceTypeEnum.DATA_FLOW,
                                DataAnnotationObjectSourceTypeEnum.IMPORTED));
        Map<Long, List<DataAnnotationObject>> result = new HashMap<>();
        for (DataAnnotationObject object : protectedObjects) {
            result.computeIfAbsent(object.getDataId(), ignored -> new ArrayList<>()).add(object);
        }
        return result;
    }

    private List<DataAnnotationObject> buildAnnotations(
            SceneInferenceRun run,
            SceneInferenceTrackingDTO.Response response,
            Map<Long, List<DataAnnotationObject>> protectedByDataId) {
        if (response == null || response.getFrames() == null) {
            throw new UsecaseException("Tracking response frames are missing: runId=" + run.getId());
        }
        DatasetInferenceConfig config = run.getConfigSnapshot();
        List<DataAnnotationObject> result = new ArrayList<>();
        for (SceneInferenceTrackingDTO.Frame frame : response.getFrames()) {
            if (frame.getDataId() == null || frame.getObjects() == null) {
                throw new UsecaseException("Invalid tracking frame: runId=" + run.getId()
                        + ", frame=" + JSONUtil.toJsonStr(frame));
            }
            List<SceneInferenceTrackingDTO.Object> orderedObjects = new ArrayList<>(frame.getObjects());
            orderedObjects.sort(Comparator
                    .comparing(SceneInferenceTrackingDTO.Object::getConfidence,
                            Comparator.nullsLast(Comparator.reverseOrder()))
                    .thenComparing(SceneInferenceTrackingDTO.Object::getPredictionId,
                            Comparator.nullsLast(Comparator.naturalOrder())));
            List<SceneInferenceTrackingDTO.Object> acceptedObjects = new ArrayList<>();
            for (SceneInferenceTrackingDTO.Object object : orderedObjects) {
                validateTrackedObject(run.getId(), object);
                if (overlapsProtected(object, protectedByDataId.get(frame.getDataId()),
                        config.getAssociationIou())
                        || overlapsInference(object, acceptedObjects, config.getAssociationIou())) {
                    continue;
                }
                acceptedObjects.add(object);
                result.add(DataAnnotationObject.builder()
                        .datasetId(run.getDatasetId())
                        .dataId(frame.getDataId())
                        .classId(object.getDatasetClassId())
                        .sourceType(DataAnnotationObjectSourceTypeEnum.INFERENCE)
                        .sourceId(run.getId())
                        .classAttributes(buildAttributes(object, config))
                        .build());
            }
        }
        return result;
    }

    private static void validateTrackedObject(Long runId, SceneInferenceTrackingDTO.Object object) {
        if (object == null || object.getDatasetClassId() == null || StrUtil.isBlank(object.getTrackingId())
                || object.getMotionMode() == null || !hasGeometry(object)) {
            throw new UsecaseException("Invalid tracked object: runId=" + runId
                    + ", object=" + JSONUtil.toJsonStr(object));
        }
    }

    private static boolean hasGeometry(SceneInferenceTrackingDTO.Object object) {
        return object.getX() != null && object.getY() != null && object.getZ() != null
                && object.getDx() != null && object.getDx() > 0.0
                && object.getDy() != null && object.getDy() > 0.0
                && object.getDz() != null && object.getDz() > 0.0
                && object.getRotX() != null && object.getRotY() != null && object.getRotZ() != null;
    }

    private static JSONObject buildAttributes(SceneInferenceTrackingDTO.Object object,
                                              DatasetInferenceConfig config) {
        JSONObject contour = JSONUtil.createObj()
                .set("type", "3D_BOX")
                .set("center3D", point(object.getX(), object.getY(), object.getZ()))
                .set("size3D", point(object.getDx(), object.getDy(), object.getDz()))
                .set("rotation3D", point(object.getRotX(), object.getRotY(), object.getRotZ()));
        return JSONUtil.createObj()
                .set("contour", contour)
                .set("trackId", object.getTrackingId())
                .set("standardDataId", object.getStandardDataId())
                .set("motionMode", object.getMotionMode().name())
                .set("syncDistance", config.getSyncDistance())
                .set("maxOutsideFrames", config.getMaxOutsideFrames())
                .set("associationIou", config.getAssociationIou())
                .set("modelClass", object.getLabel())
                .set("modelClassCode", object.getLabel())
                .set("confidence", object.getConfidence());
    }

    private static JSONObject point(Double x, Double y, Double z) {
        return JSONUtil.createObj().set("x", x).set("y", y).set("z", z);
    }

    private static boolean overlapsProtected(SceneInferenceTrackingDTO.Object candidate,
                                             List<DataAnnotationObject> protectedObjects,
                                             double threshold) {
        if (CollUtil.isEmpty(protectedObjects)) {
            return false;
        }
        for (DataAnnotationObject protectedObject : protectedObjects) {
            if (!candidate.getDatasetClassId().equals(protectedObject.getClassId())) {
                continue;
            }
            Box protectedBox = boxFromAttributes(protectedObject.getClassAttributes());
            if (protectedBox != null && bevIou(
                    new Box(candidate.getX(), candidate.getY(), candidate.getDx(), candidate.getDy(),
                            candidate.getRotZ()), protectedBox) > threshold) {
                return true;
            }
        }
        return false;
    }

    private static boolean overlapsInference(SceneInferenceTrackingDTO.Object candidate,
                                             List<SceneInferenceTrackingDTO.Object> acceptedObjects,
                                             double threshold) {
        Box candidateBox = new Box(candidate.getX(), candidate.getY(), candidate.getDx(), candidate.getDy(),
                candidate.getRotZ());
        for (SceneInferenceTrackingDTO.Object accepted : acceptedObjects) {
            if (candidate.getDatasetClassId().equals(accepted.getDatasetClassId())
                    && bevIou(candidateBox, new Box(accepted.getX(), accepted.getY(), accepted.getDx(),
                    accepted.getDy(), accepted.getRotZ())) > threshold) {
                return true;
            }
        }
        return false;
    }

    private static Box boxFromAttributes(JSONObject attributes) {
        JSONObject contour = attributes == null ? null : attributes.getJSONObject("contour");
        JSONObject center = contour == null ? null : contour.getJSONObject("center3D");
        JSONObject size = contour == null ? null : contour.getJSONObject("size3D");
        JSONObject rotation = contour == null ? null : contour.getJSONObject("rotation3D");
        if (center == null || size == null || rotation == null) {
            return null;
        }
        return new Box(center.getDouble("x"), center.getDouble("y"), size.getDouble("x"),
                size.getDouble("y"), rotation.getDouble("z"));
    }

    static double bevIou(Box first, Box second) {
        if (!first.isValid() || !second.isValid()) {
            return 0.0;
        }
        List<Point> intersection = polygon(first);
        List<Point> clip = polygon(second);
        for (int index = 0; index < clip.size(); index++) {
            Point edgeStart = clip.get(index);
            Point edgeEnd = clip.get((index + 1) % clip.size());
            intersection = clipPolygon(intersection, edgeStart, edgeEnd);
            if (intersection.isEmpty()) {
                return 0.0;
            }
        }
        double intersectionArea = area(intersection);
        double unionArea = first.dx * first.dy + second.dx * second.dy - intersectionArea;
        return unionArea > 0.0 ? intersectionArea / unionArea : 0.0;
    }

    private static List<Point> polygon(Box box) {
        double halfX = box.dx / 2.0;
        double halfY = box.dy / 2.0;
        double cosine = Math.cos(box.yaw);
        double sine = Math.sin(box.yaw);
        double[][] corners = {{-halfX, -halfY}, {halfX, -halfY}, {halfX, halfY}, {-halfX, halfY}};
        List<Point> result = new ArrayList<>(4);
        for (double[] corner : corners) {
            result.add(new Point(box.x + corner[0] * cosine - corner[1] * sine,
                    box.y + corner[0] * sine + corner[1] * cosine));
        }
        return result;
    }

    private static List<Point> clipPolygon(List<Point> subject, Point edgeStart, Point edgeEnd) {
        List<Point> output = new ArrayList<>();
        if (subject.isEmpty()) {
            return output;
        }
        Point previous = subject.get(subject.size() - 1);
        for (Point current : subject) {
            boolean currentInside = inside(current, edgeStart, edgeEnd);
            boolean previousInside = inside(previous, edgeStart, edgeEnd);
            if (currentInside) {
                if (!previousInside) {
                    output.add(intersection(previous, current, edgeStart, edgeEnd));
                }
                output.add(current);
            } else if (previousInside) {
                output.add(intersection(previous, current, edgeStart, edgeEnd));
            }
            previous = current;
        }
        return output;
    }

    private static boolean inside(Point point, Point edgeStart, Point edgeEnd) {
        return cross(edgeStart, edgeEnd, point) >= -1.0e-10;
    }

    private static Point intersection(Point lineStart, Point lineEnd, Point edgeStart, Point edgeEnd) {
        double lineX = lineEnd.x - lineStart.x;
        double lineY = lineEnd.y - lineStart.y;
        double edgeX = edgeEnd.x - edgeStart.x;
        double edgeY = edgeEnd.y - edgeStart.y;
        double denominator = lineX * edgeY - lineY * edgeX;
        if (Math.abs(denominator) < 1.0e-12) {
            return lineEnd;
        }
        double t = ((edgeStart.x - lineStart.x) * edgeY
                - (edgeStart.y - lineStart.y) * edgeX) / denominator;
        return new Point(lineStart.x + t * lineX, lineStart.y + t * lineY);
    }

    private static double cross(Point start, Point end, Point point) {
        return (end.x - start.x) * (point.y - start.y)
                - (end.y - start.y) * (point.x - start.x);
    }

    private static double area(List<Point> polygon) {
        double sum = 0.0;
        for (int index = 0; index < polygon.size(); index++) {
            Point current = polygon.get(index);
            Point next = polygon.get((index + 1) % polygon.size());
            sum += current.x * next.y - next.x * current.y;
        }
        return Math.abs(sum) / 2.0;
    }

    static final class Box {
        private final Double x;
        private final Double y;
        private final Double dx;
        private final Double dy;
        private final Double yaw;

        Box(Double x, Double y, Double dx, Double dy, Double yaw) {
            this.x = x;
            this.y = y;
            this.dx = dx;
            this.dy = dy;
            this.yaw = yaw;
        }

        private boolean isValid() {
            return x != null && y != null && dx != null && dx > 0.0
                    && dy != null && dy > 0.0 && yaw != null;
        }
    }

    private static final class Point {
        private final double x;
        private final double y;

        private Point(double x, double y) {
            this.x = x;
            this.y = y;
        }
    }
}
