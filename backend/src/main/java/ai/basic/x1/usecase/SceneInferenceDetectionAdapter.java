package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionRespDTO;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudDetectionObject;
import ai.basic.x1.adapter.port.rpc.dto.SceneInferenceTrackingDTO;
import ai.basic.x1.entity.DatasetInferenceConfig;
import ai.basic.x1.entity.PointBO;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.json.JSONUtil;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class SceneInferenceDetectionAdapter {

    private SceneInferenceDetectionAdapter() {
    }

    public static List<SceneInferenceTrackingDTO.Object> fromPointCloud(
            Long runId,
            int frameIndex,
            Long dataId,
            List<PointCloudDetectionObject> predictions,
            Map<String, DatasetInferenceConfig.ClassMapping> mappings,
            double minConfidence) {
        List<SceneInferenceTrackingDTO.Object> result = new ArrayList<>();
        if (predictions == null) {
            return result;
        }
        int objectIndex = 0;
        for (PointCloudDetectionObject prediction : predictions) {
            DatasetInferenceConfig.ClassMapping mapping =
                    prediction == null ? null : mappings.get(prediction.getLabel());
            if (!isSelected(prediction == null ? null : prediction.getConfidence(), mapping, minConfidence)) {
                continue;
            }
            validateGeometry(
                    runId, dataId, prediction,
                    prediction.getX(), prediction.getY(), prediction.getZ(),
                    prediction.getDx(), prediction.getDy(), prediction.getDz(),
                    prediction.getRotX(), prediction.getRotY(), prediction.getRotZ());
            result.add(build(
                    runId, frameIndex, objectIndex++, prediction.getLabel(),
                    prediction.getConfidence(), prediction.getX(), prediction.getY(), prediction.getZ(),
                    prediction.getDx(), prediction.getDy(), prediction.getDz(),
                    prediction.getRotX(), prediction.getRotY(), prediction.getRotZ(), mapping));
        }
        return result;
    }

    public static List<SceneInferenceTrackingDTO.Object> fromKeypointLifted(
            Long runId,
            int frameIndex,
            Long dataId,
            List<ImageKeypointLiftedDetectionRespDTO.ObjectDTO> predictions,
            Map<String, DatasetInferenceConfig.ClassMapping> mappings,
            double minConfidence) {
        List<SceneInferenceTrackingDTO.Object> result = new ArrayList<>();
        if (predictions == null) {
            return result;
        }
        int objectIndex = 0;
        for (ImageKeypointLiftedDetectionRespDTO.ObjectDTO prediction : predictions) {
            if (prediction != null && "GROUND_POLYLINE".equals(prediction.getObjType())) {
                continue;
            }
            DatasetInferenceConfig.ClassMapping mapping =
                    prediction == null ? null : mappings.get(prediction.getModelClass());
            if (!isSelected(prediction == null ? null : prediction.getConfidence(), mapping, minConfidence)) {
                continue;
            }
            PointBO center = prediction.getCenter3D();
            PointBO size = prediction.getSize3D();
            PointBO rotation = prediction.getRotation3D();
            validateGeometry(
                    runId, dataId, prediction,
                    value(center, Axis.X), value(center, Axis.Y), value(center, Axis.Z),
                    value(size, Axis.X), value(size, Axis.Y), value(size, Axis.Z),
                    value(rotation, Axis.X), value(rotation, Axis.Y), value(rotation, Axis.Z));
            result.add(build(
                    runId, frameIndex, objectIndex++, prediction.getModelClass(), prediction.getConfidence(),
                    value(center, Axis.X), value(center, Axis.Y), value(center, Axis.Z),
                    value(size, Axis.X), value(size, Axis.Y), value(size, Axis.Z),
                    value(rotation, Axis.X), value(rotation, Axis.Y), value(rotation, Axis.Z), mapping));
        }
        return result;
    }

    private static boolean isSelected(
            BigDecimal confidence,
            DatasetInferenceConfig.ClassMapping mapping,
            double minConfidence) {
        return mapping != null && confidence != null && confidence.doubleValue() >= minConfidence;
    }

    private static SceneInferenceTrackingDTO.Object build(
            Long runId,
            int frameIndex,
            int objectIndex,
            String label,
            BigDecimal confidence,
            BigDecimal x,
            BigDecimal y,
            BigDecimal z,
            BigDecimal dx,
            BigDecimal dy,
            BigDecimal dz,
            BigDecimal rotX,
            BigDecimal rotY,
            BigDecimal rotZ,
            DatasetInferenceConfig.ClassMapping mapping) {
        return SceneInferenceTrackingDTO.Object.builder()
                .predictionId(runId + "-" + frameIndex + "-" + objectIndex)
                .label(label)
                .confidence(confidence.doubleValue())
                .x(x.doubleValue()).y(y.doubleValue()).z(z.doubleValue())
                .dx(dx.doubleValue()).dy(dy.doubleValue()).dz(dz.doubleValue())
                .rotX(rotX.doubleValue()).rotY(rotY.doubleValue()).rotZ(rotZ.doubleValue())
                .motionMode(mapping.getMotionMode())
                .datasetClassId(mapping.getDatasetClassId())
                .build();
    }

    private static void validateGeometry(
            Long runId,
            Long dataId,
            java.lang.Object prediction,
            BigDecimal x,
            BigDecimal y,
            BigDecimal z,
            BigDecimal dx,
            BigDecimal dy,
            BigDecimal dz,
            BigDecimal rotX,
            BigDecimal rotY,
            BigDecimal rotZ) {
        if (x == null || y == null || z == null
                || dx == null || dx.signum() <= 0
                || dy == null || dy.signum() <= 0
                || dz == null || dz.signum() <= 0
                || rotX == null || rotY == null || rotZ == null) {
            throw new UsecaseException("Detection returned invalid geometry: runId=" + runId
                    + ", dataId=" + dataId + ", prediction=" + JSONUtil.toJsonStr(prediction));
        }
    }

    private static BigDecimal value(PointBO point, Axis axis) {
        if (point == null) {
            return null;
        }
        switch (axis) {
            case X:
                return point.getX();
            case Y:
                return point.getY();
            case Z:
                return point.getZ();
            default:
                throw new IllegalStateException("Unsupported axis: axis=" + axis);
        }
    }

    private enum Axis {
        X,
        Y,
        Z
    }
}
