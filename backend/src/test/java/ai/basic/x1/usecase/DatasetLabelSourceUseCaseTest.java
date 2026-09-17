package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.DatasetLabelSnapshotDAO;
import ai.basic.x1.adapter.port.dao.ModelDAO;
import ai.basic.x1.adapter.port.dao.ModelRunRecordDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.DatasetLabelSnapshot;
import ai.basic.x1.adapter.port.dao.mybatis.model.Model;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelRunRecord;
import ai.basic.x1.entity.DatasetLabelSourcesBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.RunStatusEnum;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DatasetLabelSourceUseCaseTest {

    @BeforeAll
    static void initializeMybatisMetadata() {
        MybatisConfiguration configuration = new MybatisConfiguration();
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(configuration, "DataInfoMapper"),
                DataInfo.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(configuration, "DataAnnotationObjectMapper"),
                DataAnnotationObject.class);
    }

    @Mock
    private DataInfoDAO dataInfoDAO;
    @Mock
    private DataAnnotationObjectDAO annotationObjectDAO;
    @Mock
    private DatasetLabelSnapshotDAO snapshotDAO;
    @Mock
    private ModelRunRecordDAO modelRunRecordDAO;
    @Mock
    private ModelDAO modelDAO;

    @InjectMocks
    private DatasetLabelSourceUseCase useCase;

    @Test
    void list_groupsCurrentSnapshotsAndModelRuns() {
        when(dataInfoDAO.list(any())).thenReturn(List.of(
                DataInfo.builder().id(11L).parentId(10L).datasetId(1L).build()));
        when(annotationObjectDAO.list(any())).thenReturn(List.of(
                object(11L, DataAnnotationObjectSourceTypeEnum.DATA_FLOW, -1L),
                object(11L, DataAnnotationObjectSourceTypeEnum.SNAPSHOT, 5L),
                object(11L, DataAnnotationObjectSourceTypeEnum.MODEL, 101L)));
        when(snapshotDAO.list(any())).thenReturn(List.of(
                DatasetLabelSnapshot.builder()
                        .id(5L).datasetId(1L).sceneId(10L).name("old labels").build()));
        when(modelRunRecordDAO.listByIds(List.of(101L))).thenReturn(List.of(
                ModelRunRecord.builder()
                        .id(101L).datasetId(1L).modelId(20L)
                        .status(RunStatusEnum.SUCCESS).build()));
        when(modelDAO.listByIds(List.of(20L))).thenReturn(List.of(
                Model.builder().id(20L).name("BEVFusion").build()));

        DatasetLabelSourcesBO result = useCase.list(1L);

        assertEquals(1L, result.getCurrent().getObjectCount());
        assertEquals(10L, result.getCurrent().getSceneCounts().get(0).getSceneId());
        assertEquals("old labels", result.getSnapshots().get(0).getName());
        assertEquals("BEVFusion", result.getModelRuns().get(0).getModelName());
    }

    private DataAnnotationObject object(
            Long dataId,
            DataAnnotationObjectSourceTypeEnum sourceType,
            Long sourceId) {
        return DataAnnotationObject.builder()
                .datasetId(1L)
                .dataId(dataId)
                .sourceType(sourceType)
                .sourceId(sourceId)
                .build();
    }
}
