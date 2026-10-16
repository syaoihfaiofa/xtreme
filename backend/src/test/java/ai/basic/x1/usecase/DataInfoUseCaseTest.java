package ai.basic.x1.usecase;

import ai.basic.x1.entity.DataAnnotationObjectBO;
import ai.basic.x1.entity.DataAnnotationResultObjectBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.ObjectTypeEnum;
import cn.hutool.json.JSONUtil;
import cn.hutool.json.JSONObject;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DataInfoUseCaseTest {

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
