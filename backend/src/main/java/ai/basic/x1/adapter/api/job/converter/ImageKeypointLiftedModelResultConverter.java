package ai.basic.x1.adapter.api.job.converter;

import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.dto.PreModelParamDTO;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelClass;
import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionRespDTO;
import ai.basic.x1.entity.ImageKeypointLiftedObjectBO;
import ai.basic.x1.entity.PointBO;
import ai.basic.x1.usecase.exception.UsecaseCode;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;

public class ImageKeypointLiftedModelResultConverter {

    private ImageKeypointLiftedModelResultConverter() {
    }

    public static ImageKeypointLiftedObjectBO convert(
            ApiResult<List<ImageKeypointLiftedDetectionRespDTO>> apiResult,
            Map<String, ModelClass> modelClassMap,
            PreModelParamDTO filterCondition) {
        ImageKeypointLiftedObjectBO.ImageKeypointLiftedObjectBOBuilder<?, ?> builder =
                ImageKeypointLiftedObjectBO.builder();
        if (apiResult.getCode() != UsecaseCode.OK || apiResult.getData() == null || apiResult.getData().isEmpty()) {
            return builder.code(UsecaseCode.ERROR.getCode()).message(apiResult.getMessage()).build();
        }

        ImageKeypointLiftedDetectionRespDTO response = apiResult.getData().get(0);
        builder.dataId(response.getId()).code(response.getCode()).message(response.getMessage());
        if (!UsecaseCode.OK.getCode().equals(response.getCode())) {
            return builder.build();
        }

        List<ImageKeypointLiftedObjectBO.ObjectBO> objects = new ArrayList<>();
        if (response.getObjects() != null) {
            for (int index = 0; index < response.getObjects().size(); index++) {
                ImageKeypointLiftedDetectionRespDTO.ObjectDTO object = response.getObjects().get(index);
                String validationError = validateObject(object, modelClassMap);
                if (validationError != null) {
                    return ImageKeypointLiftedObjectBO.builder()
                            .dataId(response.getId())
                            .code(UsecaseCode.ERROR.getCode())
                            .message("remote object[" + index + "] " + validationError)
                            .build();
                }
                if (matchesFilter(object, filterCondition)) {
                    objects.add(convertObject(object, modelClassMap));
                }
            }
        }
        return builder.objects(objects).build();
    }

    private static String validateObject(
            ImageKeypointLiftedDetectionRespDTO.ObjectDTO object,
            Map<String, ModelClass> modelClassMap) {
        if (object == null || object.getModelClass() == null || modelClassMap.get(object.getModelClass()) == null
                || object.getConfidence() == null || object.getConfidence().compareTo(BigDecimal.ZERO) < 0
                || object.getConfidence().compareTo(BigDecimal.ONE) > 0) {
            return "has invalid class or confidence";
        }
        if ("3D_BOX".equals(object.getObjType())) {
            if (!isCompletePoint(object.getCenter3D()) || !isCompletePoint(object.getSize3D())
                || !isCompletePoint(object.getRotation3D())
                || object.getSize3D().getX().compareTo(BigDecimal.ZERO) <= 0
                || object.getSize3D().getY().compareTo(BigDecimal.ZERO) <= 0
                || object.getSize3D().getZ().compareTo(BigDecimal.ZERO) <= 0) {
                return "has incomplete 3D geometry";
            }
        } else if ("GROUND_POLYLINE".equals(object.getObjType())) {
            if (object.getPoints() == null || object.getPoints().size() < 2
                    || object.getPoints().stream().anyMatch(point -> !isCompletePoint(point))) {
                return "has incomplete ground polyline geometry";
            }
        } else if ("GROUND_POLYGON".equals(object.getObjType())) {
            if (object.getPoints() == null || object.getPoints().size() != 4
                    || object.getPoints().stream().anyMatch(point -> !isCompletePoint(point))) {
                return "has incomplete ground polygon geometry";
            }
        } else {
            return "has unsupported object type";
        }
        if (object.getSourceViewIndexes() == null || object.getSourceViewIndexes().isEmpty()
                || object.getSourceKeypoints() == null
                || object.getSourceViewIndexes().size() != object.getSourceKeypoints().size()
                || object.getSourceViewIndexes().stream().anyMatch(viewIndex -> viewIndex == null || viewIndex < 0)
                || new HashSet<>(object.getSourceViewIndexes()).size() != object.getSourceViewIndexes().size()
                || object.getSourceKeypoints().stream().anyMatch(keypoints ->
                keypoints == null
                        || ("3D_BOX".equals(object.getObjType()) ? keypoints.size() != 8
                        : keypoints.size() < 4 || keypoints.size() % 2 != 0)
                        || keypoints.stream().anyMatch(value -> value == null))) {
            return "has incomplete source keypoints";
        }
        return null;
    }

    private static boolean isCompletePoint(PointBO point) {
        return point != null && point.getX() != null && point.getY() != null && point.getZ() != null;
    }

    private static boolean matchesFilter(
            ImageKeypointLiftedDetectionRespDTO.ObjectDTO object,
            PreModelParamDTO filterCondition) {
        if (filterCondition == null) {
            return true;
        }
        if (filterCondition.getClasses() == null || filterCondition.getClasses().isEmpty()) {
            throw new IllegalArgumentException("keypoint-lifted result filter must select at least one class");
        }
        boolean selectedClass = filterCondition.getClasses().stream()
                .anyMatch(selected -> selected.equalsIgnoreCase(object.getModelClass()));
        if (!selectedClass) {
            return false;
        }
        BigDecimal confidence = object.getConfidence();
        if (filterCondition.getMinConfidence() != null
                && confidence.compareTo(filterCondition.getMinConfidence()) < 0) {
            return false;
        }
        return filterCondition.getMaxConfidence() == null
                || confidence.compareTo(filterCondition.getMaxConfidence()) <= 0;
    }

    private static ImageKeypointLiftedObjectBO.ObjectBO convertObject(
            ImageKeypointLiftedDetectionRespDTO.ObjectDTO source,
            Map<String, ModelClass> modelClassMap) {
        ModelClass modelClass = modelClassMap.get(source.getModelClass());
        return ImageKeypointLiftedObjectBO.ObjectBO.builder()
                .type(source.getObjType())
                .modelClass(modelClass == null ? null : modelClass.getName())
                .confidence(source.getConfidence())
                .center3D(source.getCenter3D())
                .size3D(source.getSize3D())
                .rotation3D(source.getRotation3D())
                .viewIndex(primaryViewIndex(source.getSourceViewIndexes()))
                .points(("GROUND_POLYLINE".equals(source.getObjType()) || "GROUND_POLYGON".equals(source.getObjType()))
                        ? polylinePoints(source.getPoints())
                        : primaryKeypoints(source.getSourceKeypoints()))
                .sourceViewIndexes(source.getSourceViewIndexes())
                .sourceKeypoints(source.getSourceKeypoints())
                .build();
    }

    private static List<ImageKeypointLiftedObjectBO.Point> polylinePoints(List<PointBO> points) {
        List<ImageKeypointLiftedObjectBO.Point> result = new ArrayList<>(points.size());
        for (PointBO point : points) {
            result.add(ImageKeypointLiftedObjectBO.Point.builder()
                    .x(point.getX())
                    .y(point.getY())
                    .z(point.getZ())
                    .build());
        }
        return result;
    }

    private static Integer primaryViewIndex(List<Integer> viewIndexes) {
        return viewIndexes == null || viewIndexes.isEmpty() ? 0 : viewIndexes.get(0);
    }

    private static List<ImageKeypointLiftedObjectBO.Point> primaryKeypoints(List<List<BigDecimal>> sourceKeypoints) {
        if (sourceKeypoints == null || sourceKeypoints.isEmpty()) {
            return Collections.emptyList();
        }
        List<BigDecimal> keypoints = sourceKeypoints.get(0);
        List<ImageKeypointLiftedObjectBO.Point> points = new ArrayList<>(keypoints.size() / 2);
        for (int index = 0; index + 1 < keypoints.size(); index += 2) {
            points.add(ImageKeypointLiftedObjectBO.Point.builder()
                    .x(keypoints.get(index))
                    .y(keypoints.get(index + 1))
                    .build());
        }
        return points;
    }
}
