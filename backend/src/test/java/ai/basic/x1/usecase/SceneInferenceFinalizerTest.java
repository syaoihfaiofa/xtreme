package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.rpc.dto.SceneInferenceTrackingDTO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SceneInferenceFinalizerTest {

    @Test
    void isThisModelRun_matchesModelSourceIdOnly() {
        DataAnnotationObject object = DataAnnotationObject.builder()
                .sourceType(DataAnnotationObjectSourceTypeEnum.MODEL)
                .sourceId(44L)
                .build();

        assertTrue(SceneInferenceFinalizer.isThisModelRun(object, 44L));
        assertFalse(SceneInferenceFinalizer.isThisModelRun(object, 45L));

        object.setSourceType(DataAnnotationObjectSourceTypeEnum.INFERENCE);
        assertFalse(SceneInferenceFinalizer.isThisModelRun(object, 44L));
    }

    @Test
    void isDuplicate_matchesThinBoxesByCenterDistance() {
        SceneInferenceFinalizer.Box first =
                new SceneInferenceFinalizer.Box(5.0, 0.0, 0.1, 0.1, 0.0);
        SceneInferenceFinalizer.Box second =
                new SceneInferenceFinalizer.Box(5.3, 0.0, 0.1, 0.1, 0.0);

        assertTrue(SceneInferenceFinalizer.isDuplicate(first, second, 0.3, 0.5));
        assertFalse(SceneInferenceFinalizer.isDuplicate(first, second, 0.3, 0.2));
    }

    @Test
    void isOutsideSyncDistance_dropsOnlyBoxesBeyondBoundary() {
        SceneInferenceTrackingDTO.Object atBoundary =
                SceneInferenceTrackingDTO.Object.builder().x(12.0).y(0.0).build();
        SceneInferenceTrackingDTO.Object outside =
                SceneInferenceTrackingDTO.Object.builder().x(12.01).y(0.0).build();

        assertFalse(SceneInferenceFinalizer.isOutsideSyncDistance(atBoundary, 12.0));
        assertTrue(SceneInferenceFinalizer.isOutsideSyncDistance(outside, 12.0));
    }
}
