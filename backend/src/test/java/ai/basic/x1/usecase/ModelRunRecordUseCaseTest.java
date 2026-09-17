package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.ModelDatasetResultDAO;
import ai.basic.x1.adapter.port.dao.ModelRunRecordDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelRunRecord;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ModelRunRecordUseCaseTest {

    @Mock
    private ModelRunRecordDAO modelRunRecordDAO;

    @Mock
    private ModelDatasetResultDAO modelDatasetResultDAO;

    @Mock
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    @InjectMocks
    private ModelRunRecordUseCase useCase;

    @Test
    void test_deleteById_removes_standardized_model_annotations() {
        Long runId = 12L;
        when(modelRunRecordDAO.getById(runId))
                .thenReturn(ModelRunRecord.builder().id(runId).modelSerialNo(100L).build());

        useCase.deleteById(runId);

        verify(dataAnnotationObjectDAO).remove(any(LambdaUpdateWrapper.class));
    }
}
