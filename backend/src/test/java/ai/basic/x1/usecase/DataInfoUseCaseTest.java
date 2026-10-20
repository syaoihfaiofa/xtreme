package ai.basic.x1.usecase;

import ai.basic.x1.entity.DataAnnotationObjectBO;
import ai.basic.x1.entity.DataAnnotationResultObjectBO;
import ai.basic.x1.entity.DataInfoQueryBO;
import ai.basic.x1.entity.DataInfoBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.DatasetTypeEnum;
import ai.basic.x1.entity.enums.ObjectTypeEnum;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.json.JSONUtil;
import cn.hutool.json.JSONObject;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class DataInfoUseCaseTest {

    @Test
    void processData_revalidatesVisibilityRunImmediatelyBeforeSidecarMerge() {
        DataInfoUseCase useCase = new DataInfoUseCase();
        SceneVisibilityUseCase visibilityUseCase = mock(SceneVisibilityUseCase.class);
        DataAnnotationObjectUseCase objectUseCase = mock(DataAnnotationObjectUseCase.class);
        DataAnnotationClassificationUseCase classificationUseCase =
                mock(DataAnnotationClassificationUseCase.class);
        ReflectionTestUtils.setField(useCase, "sceneVisibilityUseCase", visibilityUseCase);
        ReflectionTestUtils.setField(useCase, "dataAnnotationObjectUseCase", objectUseCase);
        ReflectionTestUtils.setField(
                useCase, "dataAnnotationClassificationUseCase", classificationUseCase);
        when(classificationUseCase.findByDataIds(any())).thenReturn(List.of());
        when(objectUseCase.findByDataIds(any(), any(), any())).thenReturn(List.of());
        when(visibilityUseCase.requireCurrentSucceededRunForDataset(7L, 8L))
                .thenThrow(new UsecaseException("Visibility run expired after export submission"));
        DataInfoQueryBO query = DataInfoQueryBO.builder()
                .datasetId(8L)
                .visibilityRunId(7L)
                .build();

        UsecaseException error = assertThrows(
                UsecaseException.class,
                () -> useCase.processData(List.of(10L), query, java.util.Map.of(), java.util.Map.of()));

        assertTrue(error.getMessage().contains("expired"));
    }

    @Test
    void processData_mergesSidecarFieldsThroughExportPipeline() {
        SceneVisibilityUseCase visibilityUseCase = mock(SceneVisibilityUseCase.class);
        DataAnnotationObjectUseCase objectUseCase = mock(DataAnnotationObjectUseCase.class);
        DataAnnotationClassificationUseCase classificationUseCase =
                mock(DataAnnotationClassificationUseCase.class);
        DataAnnotationObjectBO source = annotationObject(
                101L, DataAnnotationObjectSourceTypeEnum.DATA_FLOW, -1L,
                "display-track", "3D_BOX");
        source.setDataId(10L);
        source.setClassId(1L);
        DataInfoUseCase useCase = new DataInfoUseCase() {
            @Override
            public List<DataInfoBO> listByIds(List<Long> ids, Boolean includeDeleted) {
                return List.of(DataInfoBO.builder()
                        .id(10L)
                        .datasetId(8L)
                        .content(List.of())
                        .build());
            }
        };
        ReflectionTestUtils.setField(useCase, "sceneVisibilityUseCase", visibilityUseCase);
        ReflectionTestUtils.setField(useCase, "dataAnnotationObjectUseCase", objectUseCase);
        ReflectionTestUtils.setField(
                useCase, "dataAnnotationClassificationUseCase", classificationUseCase);
        when(classificationUseCase.findByDataIds(any())).thenReturn(List.of());
        when(objectUseCase.findByDataIds(any(), any(), org.mockito.ArgumentMatchers.isNull()))
                .thenReturn(List.of(source));
        when(visibilityUseCase.frameResult(7L, 10L)).thenReturn(JSONUtil.parseObj("{"
                + "\"objects\":{\"10:101\":{\"autoVisibleRatio\":0.8,"
                + "\"autoVisibleRatioByView\":{\"0\":0.8},\"autoOccluded\":false}},"
                + "\"polylines\":{}}"));
        DataInfoQueryBO query = DataInfoQueryBO.builder()
                .datasetId(8L)
                .datasetType(DatasetTypeEnum.LIDAR_BASIC)
                .visibilityRunId(7L)
                .isAllResult(false)
                .build();

        List<ai.basic.x1.entity.DataExportBO> exported =
                useCase.processData(List.of(10L), query, java.util.Map.of(1L, "car"),
                        java.util.Map.of(-1L, "Ground Truth"));

        assertEquals(0, new BigDecimal("0.8").compareTo(
                exported.get(0).getResult().get(0).getObjects().get(0)
                        .getAutoVisibleRatio()));
    }

    @Test
    void mergeVisibilityForExport_copiesOnlyAutoFieldsWithoutMutatingSource() {
        DataAnnotationObjectBO source = annotationObject(
                101L,
                DataAnnotationObjectSourceTypeEnum.DATA_FLOW,
                -1L,
                "display-track-not-a-sidecar-key",
                "3D_BOX");
        source.getClassAttributes().set("custom", "keep");
        JSONObject sidecar = JSONUtil.parseObj("{"
                + "\"objects\":{\"10:101\":{"
                + "\"autoVisibleRatio\":0.75,"
                + "\"autoVisibleRatioByView\":{\"0\":0.25,\"1\":0.75,\"2\":0.0,\"3\":0.0},"
                + "\"autoOccluded\":false,"
                + "\"visibleRatio\":0.75"
                + "}},"
                + "\"polylines\":{}"
                + "}");

        List<DataAnnotationObjectBO> result = DataInfoUseCase.mergeVisibilityForExport(
                List.of(source), 10L, sidecar);

        assertEquals(1, result.size());
        assertEquals(0.75, result.get(0).getClassAttributes().getDouble("autoVisibleRatio"));
        assertEquals(false, result.get(0).getClassAttributes().getBool("autoOccluded"));
        assertEquals("keep", result.get(0).getClassAttributes().getStr("custom"));
        assertTrue(!source.getClassAttributes().containsKey("autoVisibleRatio"));
        assertTrue(!source.getClassAttributes().containsKey("visibleRatio"));
    }

    @Test
    void mergeVisibilityForExport_copiesPolylineAutoFields() {
        DataAnnotationObjectBO source = annotationObject(
                202L,
                DataAnnotationObjectSourceTypeEnum.DATA_FLOW,
                -1L,
                "display-line-not-a-sidecar-key",
                "GROUND_POLYLINE");
        JSONObject sidecar = JSONUtil.parseObj("{"
                + "\"objects\":{},"
                + "\"polylines\":{\"10:202\":{"
                + "\"autoSegmentVisibilityByView\":{\"bev\":[{\"index\":0,\"visible\":true}]},"
                + "\"autoSegmentMeta\":{\"numSegments\":1,\"segmentLength\":0.5}"
                + "}}"
                + "}");

        DataAnnotationObjectBO result = DataInfoUseCase.mergeVisibilityForExport(
                List.of(source), 10L, sidecar).get(0);

        assertEquals(1, result.getClassAttributes()
                .getJSONObject("autoSegmentMeta").getInt("numSegments"));
        assertEquals(true, result.getClassAttributes()
                .getJSONObject("autoSegmentVisibilityByView")
                .getJSONArray("bev").getJSONObject(0).getBool("visible"));
        assertTrue(!source.getClassAttributes().containsKey("autoSegmentMeta"));
    }

    @Test
    void dedupeObjectsForExport_keepsFirstObjectForMatchingDisplayKey() {
        DataAnnotationObjectBO first = annotationObject(
                101L,
                DataAnnotationObjectSourceTypeEnum.DATA_FLOW,
                -1L,
                "track-1",
                "3D_BOX");
        DataAnnotationObjectBO duplicate = annotationObject(
                102L,
                DataAnnotationObjectSourceTypeEnum.DATA_FLOW,
                -1L,
                "track-1",
                "3D_BOX");

        List<DataAnnotationObjectBO> result = DataInfoUseCase.dedupeObjectsForExport(
                List.of(first, duplicate));

        assertEquals(List.of(101L), result.stream()
                .map(DataAnnotationObjectBO::getId)
                .collect(Collectors.toList()));
    }

    @Test
    void dedupeObjectsForExport_keepsObjectsFromDifferentSources() {
        DataAnnotationObjectBO dataFlow = annotationObject(
                101L,
                DataAnnotationObjectSourceTypeEnum.DATA_FLOW,
                -1L,
                "track-1",
                "3D_BOX");
        DataAnnotationObjectBO snapshot = annotationObject(
                102L,
                DataAnnotationObjectSourceTypeEnum.SNAPSHOT,
                -1L,
                "track-1",
                "3D_BOX");

        List<DataAnnotationObjectBO> result = DataInfoUseCase.dedupeObjectsForExport(
                List.of(dataFlow, snapshot));

        assertEquals(List.of(101L, 102L), result.stream()
                .map(DataAnnotationObjectBO::getId)
                .collect(Collectors.toList()));
    }

    @Test
    void sceneResultImport_supportsAllThreeDimensionalEditorObjectTypes() {
        Set<String> importableTypes = Arrays.stream(ObjectTypeEnum.values())
                .map(ObjectTypeEnum::getValue)
                .collect(Collectors.toSet());

        assertTrue(importableTypes.containsAll(Set.of(
                "GROUND_POLYGON",
                "GROUND_POLYLINE",
                "IRREGULAR_WALL",
                "2D_GROUND_POLYGON",
                "2D_GROUND_POLYLINE"
        )));
    }

    @Test
    void sceneResultImport_preservesGroundPolylineWallHeight() {
        DataAnnotationResultObjectBO object = JSONUtil.toBean(
                "{\"type\":\"GROUND_POLYLINE\",\"wallHeight\":3.5}",
                DataAnnotationResultObjectBO.class);

        assertEquals(new BigDecimal("3.5"), object.getWallHeight());
    }

    private static DataAnnotationObjectBO annotationObject(
            Long id,
            DataAnnotationObjectSourceTypeEnum sourceType,
            Long sourceId,
            String trackId,
            String type) {
        return DataAnnotationObjectBO.builder()
                .id(id)
                .sourceType(sourceType)
                .sourceId(sourceId)
                .classAttributes(new JSONObject()
                        .set("trackId", trackId)
                        .set("type", type))
                .build();
    }
}
