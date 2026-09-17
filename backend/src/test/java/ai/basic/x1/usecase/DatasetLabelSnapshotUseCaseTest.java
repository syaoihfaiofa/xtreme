package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.DatasetLabelSnapshotDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.DatasetLabelSnapshot;
import ai.basic.x1.entity.LabelSnapshotRestoreBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Collection;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DatasetLabelSnapshotUseCaseTest {

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
    private DatasetLabelSnapshotDAO snapshotDAO;

    @Mock
    private DataAnnotationObjectDAO annotationObjectDAO;

    @Mock
    private DataInfoDAO dataInfoDAO;

    @InjectMocks
    private DatasetLabelSnapshotUseCase useCase;

    @Test
    void backupCurrentLayer_copiesOnlyCurrentSceneAsSnapshot() {
        prepareScene();
        when(annotationObjectDAO.list(any())).thenReturn(List.of(
                annotation(100L, 11L, DataAnnotationObjectSourceTypeEnum.DATA_FLOW, -1L)));
        when(snapshotDAO.save(any())).thenAnswer(invocation -> {
            DatasetLabelSnapshot snapshot = invocation.getArgument(0);
            snapshot.setId(5L);
            return true;
        });

        Long snapshotId = useCase.backupCurrentLayer(1L, 10L, 7L);

        assertEquals(5L, snapshotId);
        ArgumentCaptor<Collection<DataAnnotationObject>> captor =
                ArgumentCaptor.forClass(Collection.class);
        verify(annotationObjectDAO).saveBatch(captor.capture());
        DataAnnotationObject copy = captor.getValue().iterator().next();
        assertNull(copy.getId());
        assertEquals(11L, copy.getDataId());
        assertEquals(DataAnnotationObjectSourceTypeEnum.SNAPSHOT, copy.getSourceType());
        assertEquals(5L, copy.getSourceId());
        assertEquals("CUBOID", copy.getClassAttributes().getStr("type"));
        assertEquals("SNAPSHOT", copy.getClassAttributes().getStr("sourceType"));
        assertEquals(5L, copy.getClassAttributes().getLong("sourceId"));
    }

    @Test
    void backupCurrentLayer_doesNotCreateEmptySnapshot() {
        prepareScene();
        when(annotationObjectDAO.list(any())).thenReturn(List.of());

        Long snapshotId = useCase.backupCurrentLayer(1L, 10L, 7L);

        assertNull(snapshotId);
        verify(snapshotDAO, never()).save(any());
        verify(annotationObjectDAO, never()).saveBatch(any());
    }

    @Test
    void restore_backsUpAndReplacesOnlySnapshotScene() {
        prepareScene();
        when(snapshotDAO.getById(5L)).thenReturn(DatasetLabelSnapshot.builder()
                .id(5L)
                .datasetId(1L)
                .sceneId(10L)
                .name("old labels")
                .build());
        when(snapshotDAO.save(any())).thenAnswer(invocation -> {
            DatasetLabelSnapshot snapshot = invocation.getArgument(0);
            snapshot.setId(6L);
            return true;
        });
        when(annotationObjectDAO.list(any()))
                .thenReturn(List.of(annotation(
                        100L, 11L, DataAnnotationObjectSourceTypeEnum.DATA_FLOW, -1L)))
                .thenReturn(List.of(annotation(
                        200L, 11L, DataAnnotationObjectSourceTypeEnum.SNAPSHOT, 5L)));

        LabelSnapshotRestoreBO result = useCase.restore(1L, 5L, 7L);

        assertEquals(6L, result.getNewSnapshotId());
        assertEquals(1L, result.getWrittenObjectCount());
        verify(annotationObjectDAO).remove(any());
        ArgumentCaptor<Collection<DataAnnotationObject>> captor =
                ArgumentCaptor.forClass(Collection.class);
        verify(annotationObjectDAO, times(2)).saveBatch(captor.capture());
        DataAnnotationObject restored = captor.getAllValues().get(1).iterator().next();
        assertEquals(DataAnnotationObjectSourceTypeEnum.DATA_FLOW, restored.getSourceType());
        assertEquals(-1L, restored.getSourceId());
        assertEquals(11L, restored.getDataId());
        assertEquals("DATA_FLOW", restored.getClassAttributes().getStr("sourceType"));
        assertEquals(-1L, restored.getClassAttributes().getLong("sourceId"));
    }

    private void prepareScene() {
        when(dataInfoDAO.getById(10L)).thenReturn(DataInfo.builder()
                .id(10L)
                .datasetId(1L)
                .type(ItemTypeEnum.SCENE)
                .isDeleted(false)
                .build());
        when(dataInfoDAO.list(any())).thenReturn(List.of(
                DataInfo.builder()
                        .id(11L)
                        .datasetId(1L)
                        .parentId(10L)
                        .isDeleted(false)
                        .build()));
    }

    private DataAnnotationObject annotation(
            Long id,
            Long dataId,
            DataAnnotationObjectSourceTypeEnum sourceType,
            Long sourceId) {
        return DataAnnotationObject.builder()
                .id(id)
                .datasetId(1L)
                .dataId(dataId)
                .classId(3L)
                .classAttributes(JSONUtil.parseObj(
                        "{\"type\":\"CUBOID\",\"sourceType\":\"DATA_FLOW\",\"sourceId\":-1}"))
                .sourceType(sourceType)
                .sourceId(sourceId)
                .build();
    }
}
