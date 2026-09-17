package ai.basic.x1.adapter.api.controller;

import ai.basic.x1.adapter.dto.LoggedUserDTO;
import ai.basic.x1.adapter.dto.request.MergeModelRunsToGtDTO;
import ai.basic.x1.adapter.dto.response.MergeModelRunsToGtResultDTO;
import ai.basic.x1.entity.MergeModelRunsToGtResultBO;
import ai.basic.x1.entity.enums.ModelRunMergeModeEnum;
import ai.basic.x1.usecase.ModelRunGroundTruthMergeUseCase;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ModelRunGroundTruthControllerTest {

    @Mock
    private ModelRunGroundTruthMergeUseCase mergeUseCase;

    @InjectMocks
    private DataInfoController controller;

    @Test
    void mergeModelRunsToGt_acceptsSingleRun() {
        MergeModelRunsToGtDTO request = MergeModelRunsToGtDTO.builder()
                .datasetId(1L)
                .sceneId(10L)
                .modelRunRecordIds(List.of(101L))
                .mode(ModelRunMergeModeEnum.APPEND)
                .build();
        LoggedUserDTO user = new LoggedUserDTO("user", "password", 7L);
        when(mergeUseCase.merge(any(), any())).thenReturn(
                MergeModelRunsToGtResultBO.builder()
                        .writtenObjectCount(8L)
                        .frameCount(3L)
                        .skippedFrames(List.of(12L))
                        .build());

        MergeModelRunsToGtResultDTO result =
                controller.mergeModelRunsToGt(request, user);

        assertEquals(8L, result.getWrittenObjectCount());
        assertEquals(List.of(12L), result.getSkippedFrames());
        verify(mergeUseCase).merge(any(), any());
    }
}
