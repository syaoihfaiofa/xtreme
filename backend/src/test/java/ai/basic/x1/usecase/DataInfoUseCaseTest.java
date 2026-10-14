package ai.basic.x1.usecase;

import ai.basic.x1.entity.DataAnnotationObjectBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import cn.hutool.json.JSONObject;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;

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
