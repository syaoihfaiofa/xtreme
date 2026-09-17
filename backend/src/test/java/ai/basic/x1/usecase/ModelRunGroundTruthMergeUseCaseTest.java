package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.ModelDAO;
import ai.basic.x1.adapter.port.dao.ModelRunRecordDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.Model;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelRunRecord;
import ai.basic.x1.entity.CompletedSceneModelRunBO;
import ai.basic.x1.entity.MergeModelRunsToGtBO;
import ai.basic.x1.entity.MergeModelRunsToGtResultBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import ai.basic.x1.entity.enums.ModelRunMergeModeEnum;
import ai.basic.x1.entity.enums.ModelCodeEnum;
import ai.basic.x1.entity.enums.RunStatusEnum;
import ai.basic.x1.usecase.exception.UsecaseException;
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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ModelRunGroundTruthMergeUseCaseTest {

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
    private ModelRunRecordDAO modelRunRecordDAO;

    @Mock
    private ModelDAO modelDAO;

    @Mock
    private DataInfoDAO dataInfoDAO;

    @Mock
    private DataAnnotationObjectDAO annotationObjectDAO;

    @Mock
    private DatasetLabelSnapshotUseCase snapshotUseCase;

    @InjectMocks
    private ModelRunGroundTruthMergeUseCase useCase;

    @Test
    void merge_acceptsSingleRunAndWritesOnlyCurrentScene() {
        prepareScene();
        when(modelRunRecordDAO.listByIds(List.of(101L))).thenReturn(List.of(run(101L)));
        when(annotationObjectDAO.list(any()))
                .thenReturn(List.of(box(1L, 11L, 101L, 0.9, 0.0)))
                .thenReturn(List.of());

        MergeModelRunsToGtResultBO result = useCase.merge(
                request(List.of(101L), ModelRunMergeModeEnum.APPEND), 7L);

        assertEquals(1L, result.getWrittenObjectCount());
        assertEquals(List.of(12L), result.getSkippedFrames());
        ArgumentCaptor<Collection<DataAnnotationObject>> captor =
                ArgumentCaptor.forClass(Collection.class);
        verify(annotationObjectDAO).saveBatch(captor.capture());
        DataAnnotationObject written = captor.getValue().iterator().next();
        assertEquals(11L, written.getDataId());
        assertEquals(DataAnnotationObjectSourceTypeEnum.DATA_FLOW, written.getSourceType());
        assertEquals(-1L, written.getSourceId());
        assertEquals("DATA_FLOW", written.getClassAttributes().getStr("sourceType"));
        assertEquals(-1L, written.getClassAttributes().getLong("sourceId"));
        verify(annotationObjectDAO).remove(any());
        verify(modelRunRecordDAO, never()).removeById(org.mockito.ArgumentMatchers.<Long>any());
    }

    @Test
    void merge_deletesSelectedRunPredictionsInCurrentSceneOnly() {
        prepareScene();
        when(modelRunRecordDAO.listByIds(List.of(101L))).thenReturn(List.of(run(101L)));
        when(annotationObjectDAO.list(any()))
                .thenReturn(List.of(box(1L, 11L, 101L, 0.9, 0.0)))
                .thenReturn(List.of());

        useCase.merge(request(List.of(101L), ModelRunMergeModeEnum.APPEND), 7L);

        verify(annotationObjectDAO).saveBatch(any());
        verify(annotationObjectDAO, times(1)).remove(any());
        verify(modelRunRecordDAO, never()).removeById(org.mockito.ArgumentMatchers.<Long>any());
    }

    @Test
    void merge_deduplicatesCuboidsAcrossRunsButKeepsGroundPolygons() {
        prepareScene();
        when(modelRunRecordDAO.listByIds(List.of(101L, 102L)))
                .thenReturn(List.of(run(102L), run(101L)));
        when(annotationObjectDAO.list(any()))
                .thenReturn(List.of(
                        box(1L, 11L, 101L, 0.9, 0.0),
                        box(2L, 11L, 102L, 0.8, 0.1),
                        polygon(3L, 11L, 102L)))
                .thenReturn(List.of());

        MergeModelRunsToGtResultBO result = useCase.merge(
                request(List.of(101L, 102L), ModelRunMergeModeEnum.APPEND), 7L);

        assertEquals(2L, result.getWrittenObjectCount());
        ArgumentCaptor<Collection<DataAnnotationObject>> captor =
                ArgumentCaptor.forClass(Collection.class);
        verify(annotationObjectDAO).saveBatch(captor.capture());
        assertEquals(2, captor.getValue().size());
    }

    @Test
    void merge_replaceBacksUpBeforeRemovingCurrentLayer() {
        prepareScene();
        when(modelRunRecordDAO.listByIds(List.of(101L))).thenReturn(List.of(run(101L)));
        when(annotationObjectDAO.list(any()))
                .thenReturn(List.of(box(1L, 11L, 101L, 0.9, 0.0)));
        when(snapshotUseCase.backupCurrentLayer(1L, 10L, 7L)).thenReturn(5L);

        MergeModelRunsToGtResultBO result = useCase.merge(
                request(List.of(101L), ModelRunMergeModeEnum.REPLACE), 7L);

        assertEquals(5L, result.getSnapshotId());
        verify(snapshotUseCase).backupCurrentLayer(1L, 10L, 7L);
        verify(annotationObjectDAO, times(2)).remove(any());
        verify(annotationObjectDAO).saveBatch(any());
        verify(modelRunRecordDAO, never()).removeById(org.mockito.ArgumentMatchers.<Long>any());
    }

    @Test
    void merge_rejectsEmptyRunSelectionWithoutWrites() {
        UsecaseException exception = assertThrows(
                UsecaseException.class,
                () -> useCase.merge(
                        request(List.of(), ModelRunMergeModeEnum.APPEND), 7L));

        assertEquals(
                "At least one Model Run is required: datasetId=1, sceneId=10",
                exception.getMessage());
        verify(annotationObjectDAO, never()).saveBatch(any());
    }

    @Test
    void listCompletedRuns_countsOnlyRequestedScene() {
        prepareScene();
        when(annotationObjectDAO.list(any())).thenReturn(List.of(
                box(1L, 11L, 101L, 0.9, 0.0),
                box(2L, 12L, 101L, 0.8, 3.0)));
        when(modelRunRecordDAO.listByIds(List.of(101L))).thenReturn(List.of(
                ModelRunRecord.builder()
                        .id(101L)
                        .modelId(20L)
                        .datasetId(1L)
                        .status(RunStatusEnum.SUCCESS)
                        .isDeleted(false)
                        .build()));
        when(modelDAO.listByIds(List.of(20L))).thenReturn(List.of(
                Model.builder()
                        .id(20L)
                        .name("BEVFusion")
                        .modelCode(ModelCodeEnum.LIDAR_DETECTION)
                        .build()));

        List<CompletedSceneModelRunBO> runs = useCase.listCompletedRuns(10L);

        assertEquals(1, runs.size());
        assertEquals(101L, runs.get(0).getRecordId());
        assertEquals(2L, runs.get(0).getFrameCount());
        assertEquals(2L, runs.get(0).getObjectCount());
    }

    private void prepareScene() {
        when(dataInfoDAO.getById(10L)).thenReturn(DataInfo.builder()
                .id(10L)
                .datasetId(1L)
                .type(ItemTypeEnum.SCENE)
                .isDeleted(false)
                .build());
        when(dataInfoDAO.list(any())).thenReturn(List.of(
                DataInfo.builder().id(11L).datasetId(1L).parentId(10L).isDeleted(false).build(),
                DataInfo.builder().id(12L).datasetId(1L).parentId(10L).isDeleted(false).build()));
    }

    private ModelRunRecord run(Long id) {
        return ModelRunRecord.builder()
                .id(id)
                .datasetId(1L)
                .status(RunStatusEnum.SUCCESS)
                .isDeleted(false)
                .build();
    }

    private MergeModelRunsToGtBO request(
            List<Long> runIds,
            ModelRunMergeModeEnum mode) {
        return MergeModelRunsToGtBO.builder()
                .datasetId(1L)
                .sceneId(10L)
                .modelRunRecordIds(runIds)
                .mode(mode)
                .build();
    }

    private DataAnnotationObject box(
            Long id,
            Long dataId,
            Long runId,
            double confidence,
            double x) {
        String attributes = "{\"type\":\"CUBOID\",\"confidence\":" + confidence
                + ",\"sourceType\":\"MODEL\",\"sourceId\":" + runId
                + ",\"contour\":{\"center3D\":{\"x\":" + x
                + ",\"y\":0,\"z\":0},\"size3D\":{\"x\":4,\"y\":2,\"z\":1.5},"
                + "\"rotation3D\":{\"x\":0,\"y\":0,\"z\":0}}}";
        return DataAnnotationObject.builder()
                .id(id)
                .datasetId(1L)
                .dataId(dataId)
                .classId(3L)
                .sourceType(DataAnnotationObjectSourceTypeEnum.MODEL)
                .sourceId(runId)
                .classAttributes(JSONUtil.parseObj(attributes))
                .build();
    }

    private DataAnnotationObject polygon(Long id, Long dataId, Long runId) {
        return DataAnnotationObject.builder()
                .id(id)
                .datasetId(1L)
                .dataId(dataId)
                .classId(4L)
                .sourceType(DataAnnotationObjectSourceTypeEnum.MODEL)
                .sourceId(runId)
                .classAttributes(JSONUtil.parseObj(
                        "{\"type\":\"GROUND_POLYGON\",\"contour\":{\"points\":[]}}"))
                .build();
    }
}
