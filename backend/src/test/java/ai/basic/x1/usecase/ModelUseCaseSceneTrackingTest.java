package ai.basic.x1.usecase;

import ai.basic.x1.entity.ModelRunFilterDataBO;
import ai.basic.x1.entity.enums.RunStatusEnum;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ModelUseCaseSceneTrackingTest {

    @Test
    void summarizeSceneRunStatus_reportsPartialSuccess() {
        assertEquals(RunStatusEnum.SUCCESS_WITH_ERROR,
                ModelUseCase.summarizeSceneRunStatus(1, 1));
        assertEquals(RunStatusEnum.SUCCESS,
                ModelUseCase.summarizeSceneRunStatus(2, 0));
        assertEquals(RunStatusEnum.FAILURE,
                ModelUseCase.summarizeSceneRunStatus(0, 2));
    }

    @Test
    void requireSceneIds_rejectsEmptySelection() {
        ModelRunFilterDataBO filter = ModelRunFilterDataBO.builder()
                .sceneIds(List.of())
                .build();

        assertThrows(RuntimeException.class, () -> ModelUseCase.requireSceneIds(filter));
    }
}
