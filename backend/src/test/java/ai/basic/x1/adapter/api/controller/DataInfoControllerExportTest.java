package ai.basic.x1.adapter.api.controller;

import ai.basic.x1.adapter.dto.DataInfoQueryDTO;
import ai.basic.x1.adapter.dto.LoggedUserDTO;
import ai.basic.x1.entity.DataInfoQueryBO;
import ai.basic.x1.usecase.DataInfoUseCase;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DataInfoControllerExportTest {

    @Test
    void export_passesCurrentUserToUseCaseForPermissionValidation() {
        DataInfoUseCase useCase = mock(DataInfoUseCase.class);
        DataInfoController controller = new DataInfoController();
        ReflectionTestUtils.setField(controller, "dataInfoUsecase", useCase);
        DataInfoQueryDTO request = DataInfoQueryDTO.builder().datasetId(9L).build();
        LoggedUserDTO user = new LoggedUserDTO("exporter", "unused", 17L);
        when(useCase.export(any(DataInfoQueryBO.class), eq(17L))).thenReturn(123L);

        String serialNumber = controller.export(request, user);

        assertEquals("123", serialNumber);
        verify(useCase).export(any(DataInfoQueryBO.class), eq(17L));
    }
}
