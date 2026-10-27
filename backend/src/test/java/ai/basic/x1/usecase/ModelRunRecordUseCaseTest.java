package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.ModelDatasetResultDAO;
import ai.basic.x1.adapter.port.dao.ModelRunRecordDAO;
import ai.basic.x1.adapter.port.dao.mybatis.mapper.ModelRunRecordMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelRunRecord;
import ai.basic.x1.entity.enums.RunStatusEnum;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
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
class ModelRunRecordUseCaseTest {

    @Mock
    private ModelRunRecordDAO modelRunRecordDAO;

    @Mock
    private ModelDatasetResultDAO modelDatasetResultDAO;

    @Mock
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    @Mock
    private ModelRunRecordMapper modelRunRecordMapper;

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

    @Test
    void findAllModelRunRecord_returnsFullProgressForCompletedRun() {
        ModelRunRecord record = ModelRunRecord.builder()
                .id(1L)
                .status(RunStatusEnum.SUCCESS)
                .dataCount(120L)
                .build();
        when(modelRunRecordDAO.getBaseMapper()).thenReturn(modelRunRecordMapper);
        when(modelRunRecordMapper.selectList(any())).thenReturn(List.of(record));

        var result = useCase.findAllModelRunRecord(
                ai.basic.x1.entity.ModelRunRecordBO.builder().build());

        assertEquals(120L, result.get(0).getCompletedCount());
        assertEquals(120L, result.get(0).getTotalCount());
    }
}
