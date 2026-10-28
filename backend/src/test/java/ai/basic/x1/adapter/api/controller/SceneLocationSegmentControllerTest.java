package ai.basic.x1.adapter.api.controller;

import ai.basic.x1.adapter.dto.LoggedUserDTO;
import ai.basic.x1.usecase.DataInfoUseCase;
import ai.basic.x1.usecase.exception.UsecaseException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.verifyNoInteractions;

@ExtendWith(MockitoExtension.class)
class SceneLocationSegmentControllerTest {

    @Mock
    private DataInfoUseCase dataInfoUsecase;

    @InjectMocks
    private DataInfoController controller;

    @Test
    void sceneLocationSegments_rejectsMissingSceneId() {
        assertThrows(
                UsecaseException.class,
                () -> controller.getSceneLocationSegments(null, List.of(10L), user()));

        verifyNoInteractions(dataInfoUsecase);
    }

    @Test
    void sceneLocationSegments_rejectsEmptyDataIds() {
        assertThrows(
                UsecaseException.class,
                () -> controller.getSceneLocationSegments(9L, List.of(), user()));

        verifyNoInteractions(dataInfoUsecase);
    }

    private LoggedUserDTO user() {
        return new LoggedUserDTO("user", "password", 7L);
    }
}
