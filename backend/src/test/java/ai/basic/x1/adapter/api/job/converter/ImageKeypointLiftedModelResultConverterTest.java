package ai.basic.x1.adapter.api.job.converter;

import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.dto.PreModelParamDTO;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelClass;
import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionRespDTO;
import ai.basic.x1.entity.ImageKeypointLiftedObjectBO;
import ai.basic.x1.entity.PointBO;
import ai.basic.x1.usecase.exception.UsecaseCode;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ImageKeypointLiftedModelResultConverterTest {

    @Test
    void convert_preservesFourVertexGroundPolygon() {
        ImageKeypointLiftedDetectionRespDTO.ObjectDTO object = ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                .objType("GROUND_POLYGON").modelClass("parkinglot").confidence(BigDecimal.valueOf(0.8))
                .points(List.of(
                        PointBO.builder().x(BigDecimal.ZERO).y(BigDecimal.ZERO).z(BigDecimal.valueOf(-0.3)).build(),
                        PointBO.builder().x(BigDecimal.ONE).y(BigDecimal.ZERO).z(BigDecimal.valueOf(-0.3)).build(),
                        PointBO.builder().x(BigDecimal.ONE).y(BigDecimal.ONE).z(BigDecimal.valueOf(-0.3)).build(),
                        PointBO.builder().x(BigDecimal.ZERO).y(BigDecimal.ONE).z(BigDecimal.valueOf(-0.3)).build()))
                .sourceViewIndexes(List.of(0)).sourceKeypoints(List.of(List.of(
                        BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ONE, BigDecimal.ZERO,
                        BigDecimal.ONE, BigDecimal.ONE, BigDecimal.ZERO, BigDecimal.ONE))).build();
        ImageKeypointLiftedObjectBO result = ImageKeypointLiftedModelResultConverter.convert(
                new ApiResult<>(UsecaseCode.OK, "", List.of(ImageKeypointLiftedDetectionRespDTO.builder()
                        .id(42L).code("OK").objects(List.of(object)).build())),
                Map.of("parkinglot", ModelClass.builder().name("Parking slot").code("parkinglot").build()), null);

        assertEquals("GROUND_POLYGON", result.getObjects().get(0).getType());
        assertEquals(4, result.getObjects().get(0).getPoints().size());
        assertEquals(BigDecimal.valueOf(-0.3), result.getObjects().get(0).getPoints().get(0).getZ());
    }

    @Test
    void convert_preservesGroundPolylineAndVariableSourcePoints() {
        ImageKeypointLiftedDetectionRespDTO.ObjectDTO responseObject =
                ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                        .objType("GROUND_POLYLINE")
                        .modelClass("curb")
                        .confidence(BigDecimal.valueOf(0.8))
                        .points(List.of(
                                PointBO.builder().x(BigDecimal.ONE).y(BigDecimal.valueOf(2))
                                        .z(BigDecimal.valueOf(-0.332284)).build(),
                                PointBO.builder().x(BigDecimal.valueOf(3)).y(BigDecimal.valueOf(4))
                                        .z(BigDecimal.valueOf(-0.332284)).build()))
                        .sourceViewIndexes(List.of(0))
                        .sourceKeypoints(List.of(List.of(
                                BigDecimal.TEN, BigDecimal.valueOf(20),
                                BigDecimal.valueOf(30), BigDecimal.valueOf(40))))
                        .build();
        ImageKeypointLiftedDetectionRespDTO frame = ImageKeypointLiftedDetectionRespDTO.builder()
                .id(42L).code("OK").objects(List.of(responseObject)).build();

        ImageKeypointLiftedObjectBO result = ImageKeypointLiftedModelResultConverter.convert(
                new ApiResult<>(UsecaseCode.OK, "", List.of(frame)),
                Map.of("curb", ModelClass.builder().name("curb").code("curb").build()),
                null);

        ImageKeypointLiftedObjectBO.ObjectBO candidate = result.getObjects().get(0);
        assertEquals("GROUND_POLYLINE", candidate.getType());
        assertEquals(2, candidate.getPoints().size());
        assertEquals(BigDecimal.valueOf(-0.332284), candidate.getPoints().get(0).getZ());
        assertEquals(List.of(0), candidate.getSourceViewIndexes());
    }

    @Test
    void convert_preservesThreeDimensionalBoxAndSourceKeypoints() {
        ImageKeypointLiftedDetectionRespDTO.ObjectDTO responseObject =
                ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                        .objType("3D_BOX")
                        .modelClass("car")
                        .confidence(BigDecimal.valueOf(0.92))
                        .center3D(PointBO.builder().x(BigDecimal.ONE).y(BigDecimal.TEN).z(BigDecimal.valueOf(2)).build())
                        .size3D(PointBO.builder().x(BigDecimal.valueOf(4)).y(BigDecimal.valueOf(2)).z(BigDecimal.valueOf(1.5)).build())
                        .rotation3D(PointBO.builder().x(BigDecimal.ZERO).y(BigDecimal.ZERO).z(BigDecimal.valueOf(1.57)).build())
                        .sourceViewIndexes(List.of(2))
                        .sourceKeypoints(List.of(List.of(
                                BigDecimal.ONE, BigDecimal.valueOf(2),
                                BigDecimal.valueOf(3), BigDecimal.valueOf(4),
                                BigDecimal.valueOf(5), BigDecimal.valueOf(6),
                                BigDecimal.valueOf(7), BigDecimal.valueOf(8))))
                        .build();
        ImageKeypointLiftedDetectionRespDTO frame = ImageKeypointLiftedDetectionRespDTO.builder()
                .id(42L)
                .code("OK")
                .objects(List.of(responseObject))
                .build();

        ImageKeypointLiftedObjectBO result = ImageKeypointLiftedModelResultConverter.convert(
                new ApiResult<>(UsecaseCode.OK, "", List.of(frame)),
                Map.of("car", ModelClass.builder().name("Car").code("car").build()),
                null);

        assertEquals("OK", result.getCode());
        assertEquals(42L, result.getDataId());
        assertEquals(1, result.getObjects().size());
        ImageKeypointLiftedObjectBO.ObjectBO candidate = result.getObjects().get(0);
        assertEquals("3D_BOX", candidate.getType());
        assertEquals("Car", candidate.getModelClass());
        assertEquals(BigDecimal.ONE, candidate.getCenter3D().getX());
        assertEquals(BigDecimal.valueOf(1.5), candidate.getSize3D().getZ());
        assertEquals(BigDecimal.valueOf(1.57), candidate.getRotation3D().getZ());
        assertEquals(2, candidate.getViewIndex());
        assertEquals(4, candidate.getPoints().size());
        assertEquals(BigDecimal.ONE, candidate.getPoints().get(0).getX());
        assertEquals(BigDecimal.valueOf(2), candidate.getPoints().get(0).getY());
        assertEquals(List.of(2), candidate.getSourceViewIndexes());
        assertEquals(1, candidate.getSourceKeypoints().size());
    }

    @Test
    void convert_rejectsIncompleteRemoteGeometryBeforeItCanBePersisted() {
        ImageKeypointLiftedDetectionRespDTO.ObjectDTO responseObject =
                ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                        .objType("3D_BOX")
                        .modelClass("car")
                        .confidence(BigDecimal.valueOf(0.92))
                        .center3D(PointBO.builder().x(BigDecimal.ONE).y(BigDecimal.TEN).z(BigDecimal.valueOf(2)).build())
                        .size3D(PointBO.builder().x(BigDecimal.valueOf(4)).y(BigDecimal.valueOf(2)).z(BigDecimal.valueOf(1.5)).build())
                        .sourceViewIndexes(List.of(2))
                        .sourceKeypoints(List.of(List.of(
                                BigDecimal.ONE, BigDecimal.valueOf(2),
                                BigDecimal.valueOf(3), BigDecimal.valueOf(4))))
                        .build();
        ImageKeypointLiftedDetectionRespDTO frame = ImageKeypointLiftedDetectionRespDTO.builder()
                .id(42L)
                .code("OK")
                .objects(List.of(responseObject))
                .build();

        ImageKeypointLiftedObjectBO result = ImageKeypointLiftedModelResultConverter.convert(
                new ApiResult<>(UsecaseCode.OK, "", List.of(frame)),
                Map.of("car", ModelClass.builder().name("Car").code("car").build()),
                null);

        assertEquals("ERROR", result.getCode());
        assertEquals("remote object[0] has incomplete 3D geometry", result.getMessage());
    }

    @Test
    void convert_rejectsRemoteObjectWithIncompleteKeypoints() {
        ImageKeypointLiftedDetectionRespDTO.ObjectDTO responseObject =
                ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                        .objType("3D_BOX")
                        .modelClass("car")
                        .confidence(BigDecimal.valueOf(0.92))
                        .center3D(PointBO.builder().x(BigDecimal.ONE).y(BigDecimal.TEN).z(BigDecimal.valueOf(2)).build())
                        .size3D(PointBO.builder().x(BigDecimal.valueOf(4)).y(BigDecimal.valueOf(2)).z(BigDecimal.valueOf(1.5)).build())
                        .rotation3D(PointBO.builder().x(BigDecimal.ZERO).y(BigDecimal.ZERO).z(BigDecimal.valueOf(1.57)).build())
                        .sourceViewIndexes(List.of(2))
                        .sourceKeypoints(List.of(List.of(BigDecimal.ONE, BigDecimal.valueOf(2))))
                        .build();
        ImageKeypointLiftedDetectionRespDTO frame = ImageKeypointLiftedDetectionRespDTO.builder()
                .id(42L)
                .code("OK")
                .objects(List.of(responseObject))
                .build();

        ImageKeypointLiftedObjectBO result = ImageKeypointLiftedModelResultConverter.convert(
                new ApiResult<>(UsecaseCode.OK, "", List.of(frame)),
                Map.of("car", ModelClass.builder().name("Car").code("car").build()),
                null);

        assertEquals("ERROR", result.getCode());
        assertEquals("remote object[0] has incomplete source keypoints", result.getMessage());
    }

    @Test
    void convert_appliesSelectedClassesAndConfidenceBounds() {
        ImageKeypointLiftedDetectionRespDTO.ObjectDTO responseObject =
                ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                        .objType("3D_BOX")
                        .modelClass("car")
                        .confidence(BigDecimal.valueOf(0.92))
                        .center3D(PointBO.builder().x(BigDecimal.ONE).y(BigDecimal.TEN).z(BigDecimal.valueOf(2)).build())
                        .size3D(PointBO.builder().x(BigDecimal.valueOf(4)).y(BigDecimal.valueOf(2)).z(BigDecimal.valueOf(1.5)).build())
                        .rotation3D(PointBO.builder().x(BigDecimal.ZERO).y(BigDecimal.ZERO).z(BigDecimal.valueOf(1.57)).build())
                        .sourceViewIndexes(List.of(2))
                        .sourceKeypoints(List.of(List.of(
                                BigDecimal.ONE, BigDecimal.valueOf(2),
                                BigDecimal.valueOf(3), BigDecimal.valueOf(4),
                                BigDecimal.valueOf(5), BigDecimal.valueOf(6),
                                BigDecimal.valueOf(7), BigDecimal.valueOf(8))))
                        .build();
        ImageKeypointLiftedDetectionRespDTO frame = ImageKeypointLiftedDetectionRespDTO.builder()
                .id(42L)
                .code("OK")
                .objects(List.of(responseObject))
                .build();
        ApiResult<List<ImageKeypointLiftedDetectionRespDTO>> response =
                new ApiResult<>(UsecaseCode.OK, "", List.of(frame));
        Map<String, ModelClass> modelClasses =
                Map.of("car", ModelClass.builder().name("Car").code("car").build());

        ImageKeypointLiftedObjectBO excludedByClass = ImageKeypointLiftedModelResultConverter.convert(
                response, modelClasses, PreModelParamDTO.builder().classes(List.of("bus")).build());
        ImageKeypointLiftedObjectBO excludedByConfidence =
                ImageKeypointLiftedModelResultConverter.convert(
                        response,
                        modelClasses,
                        PreModelParamDTO.builder()
                                .classes(List.of("car"))
                                .minConfidence(BigDecimal.valueOf(0.95))
                                .build());
        ImageKeypointLiftedObjectBO included = ImageKeypointLiftedModelResultConverter.convert(
                response,
                modelClasses,
                PreModelParamDTO.builder()
                        .classes(List.of("CAR"))
                        .minConfidence(BigDecimal.valueOf(0.9))
                        .maxConfidence(BigDecimal.valueOf(0.93))
                        .build());

        assertEquals(List.of(), excludedByClass.getObjects());
        assertEquals(List.of(), excludedByConfidence.getObjects());
        assertEquals(1, included.getObjects().size());
    }
}
