package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.DatasetClassDAO;
import ai.basic.x1.adapter.port.dao.DatasetDAO;
import ai.basic.x1.adapter.port.dao.FileDAO;
import ai.basic.x1.adapter.port.dao.SceneLocationDAO;
import ai.basic.x1.adapter.port.dao.SceneLocationSampleDAO;
import ai.basic.x1.adapter.port.dao.SceneVisibilityRunDAO;
import ai.basic.x1.adapter.port.dao.UserDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.DatasetClass;
import ai.basic.x1.adapter.port.dao.mybatis.model.Dataset;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocation;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocationSample;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneVisibilityRun;
import ai.basic.x1.adapter.port.minio.MinioProp;
import ai.basic.x1.adapter.port.minio.MinioService;
import ai.basic.x1.adapter.port.rpc.SceneVisibilityWorkerHttpCaller;
import ai.basic.x1.adapter.port.rpc.dto.SceneVisibilityManifestDTO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.DatasetTypeEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import ai.basic.x1.entity.enums.UserRoleEnum;
import ai.basic.x1.entity.enums.SceneVisibilityRunStatusEnum;
import ai.basic.x1.entity.enums.SceneVisibilityRunStageEnum;
import ai.basic.x1.entity.enums.SceneVisibilityTaskTypeEnum;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.json.JSONUtil;
import cn.hutool.json.JSONObject;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.google.common.util.concurrent.MoreExecutors;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SceneVisibilityUseCaseTest {

    @BeforeAll
    static void initializeMybatisMetadata() {
        MybatisConfiguration configuration = new MybatisConfiguration();
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(configuration, "DataInfoMapper"),
                DataInfo.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(configuration, "DataAnnotationObjectMapper"),
                DataAnnotationObject.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(configuration, "SceneLocationMapper"),
                SceneLocation.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(configuration, "SceneVisibilityRunMapper"),
                SceneVisibilityRun.class);
    }

    @Mock
    private DataInfoDAO dataInfoDAO;

    @Mock
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;
    @Mock
    private DatasetClassDAO datasetClassDAO;
    @Mock
    private DatasetDAO datasetDAO;

    @Mock
    private FileDAO fileDAO;

    @Mock
    private SceneLocationDAO sceneLocationDAO;

    @Mock
    private SceneLocationSampleDAO sceneLocationSampleDAO;

    @Mock
    private SceneVisibilityRunDAO runDAO;
    @Mock
    private UserDAO userDAO;

    @Mock
    private SceneVisibilityWorkerHttpCaller workerCaller;

    @Mock
    private MinioService minioService;

    @Mock
    private MinioProp minioProp;

    @Test
    void progressUpdateAdvancesRunningRunAtCurrentStage() {
        SceneVisibilityRun running = savedRun();
        running.setStatus(SceneVisibilityRunStatusEnum.RUNNING);
        when(runDAO.getById(7L)).thenReturn(running);
        when(runDAO.update(any(LambdaUpdateWrapper.class))).thenReturn(true);

        useCase().updateProgress(7L, SceneVisibilityRunStageEnum.LIDAR_VISIBILITY, 0);

        verify(runDAO).update(any(LambdaUpdateWrapper.class));
    }

    @Test
    void sceneFrameIdsReturnsFramesInSceneOrder() {
        prepareScene(frameContent(101L, 201L));
        when(userDAO.getById(1L)).thenReturn(
                ai.basic.x1.adapter.port.dao.mybatis.model.User.builder()
                        .id(1L)
                        .role(UserRoleEnum.ADMIN)
                        .build());
        when(dataInfoDAO.list(any())).thenReturn(List.of(
                DataInfo.builder()
                        .id(12L)
                        .datasetId(8L)
                        .parentId(9L)
                        .name("frame-2")
                        .orderName("0002")
                        .type(ItemTypeEnum.SINGLE_DATA)
                        .isDeleted(false)
                        .build(),
                DataInfo.builder()
                        .id(10L)
                        .datasetId(8L)
                        .parentId(9L)
                        .name("frame-1")
                        .orderName("0001")
                        .type(ItemTypeEnum.SINGLE_DATA)
                        .isDeleted(false)
                        .build()));

        List<Long> frameIds = useCase().sceneFrameIds(8L, 9L, 1L);

        assertEquals(List.of(12L, 10L), frameIds);
    }

    @Test
    void ensure_submitsStableManifestAndMarksRunSucceeded() {
        prepareScene(frameContent(101L, 201L));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of(
                annotation(1L, 301L, boxAttributes(1.0))));
        when(datasetClassDAO.list(any())).thenReturn(List.of(DatasetClass.builder()
                .id(301L)
                .datasetId(8L)
                .name("car")
                .build()));
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/frame-1.pcd"),
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(runDAO.getOne(any())).thenReturn(null);
        when(runDAO.save(any())).thenAnswer(invocation -> {
            SceneVisibilityRun run = invocation.getArgument(0);
            run.setId(7L);
            return true;
        });
        when(runDAO.getById(7L)).thenAnswer(invocation -> savedRun());
        when(workerCaller.submit(any())).thenReturn(
                SceneVisibilityManifestDTO.Response.builder()
                        .manifestObjectKey("visibility/8/9/7/manifest.json")
                        .frameCount(1)
                        .timingsMs(Map.of("voxelization", 12.5))
                        .build());
        when(runDAO.update(any())).thenReturn(true);

        SceneVisibilityRun run = useCase().ensure(8L, 9L);

        assertEquals(7L, run.getId());
        ArgumentCaptor<SceneVisibilityManifestDTO.Manifest> captor =
                ArgumentCaptor.forClass(SceneVisibilityManifestDTO.Manifest.class);
        verify(workerCaller).submit(captor.capture());
        SceneVisibilityManifestDTO.Manifest manifest = captor.getValue();
        assertEquals("xtreme-occ-run/v1", manifest.getSchemaVersion());
        assertEquals("OCC", manifest.getTaskType());
        assertEquals("raw/scene/frame-1.pcd",
                manifest.getFrames().get(0).getPointCloudObjectKey());
        assertEquals("raw/scene/camera_config/camera.json",
                manifest.getCameraConfigObjectKey());
        assertTrue(manifest.getAlgorithm().getOccVisibility());
        assertEquals("horizon-v3.8", manifest.getAlgorithm().getClassMapVersion());
        assertEquals(0, manifest.getAlgorithm().getFreeId());
        assertEquals(1, manifest.getAlgorithm().getGeneralObjectId());
        assertEquals(255, manifest.getAlgorithm().getUnknownId());
        assertEquals(List.of(0.0, 0.0, 0.0), manifest.getAlgorithm().getLidarOrigin());
        assertEquals(2, manifest.getAlgorithm().getClassMap().get("301"));
        assertEquals(List.of(6), manifest.getAlgorithm().getGroundClassIds());
        assertTrue(manifest.getAlgorithm().getDropEgoBody());
        assertEquals(4, manifest.getAlgorithm().getMinPointsPerVoxel());
        assertEquals(1, manifest.getAlgorithm().getVoxelCleanupMinNeighbors());
        assertEquals(10L, manifest.getAnnotations().get(0).getDataId());
        assertEquals(1L, manifest.getAnnotations().get(0).getObjectId());
        assertEquals(301L, manifest.getAnnotations().get(0).getClassId());
        assertEquals("3D_BOX", manifest.getAnnotations().get(0)
                .getClassAttributes().getStr("type"));
        assertEquals(64, manifest.getSource().getHash().length());
        ArgumentCaptor<LambdaUpdateWrapper<SceneVisibilityRun>> updatesCaptor =
                ArgumentCaptor.forClass((Class) LambdaUpdateWrapper.class);
        verify(runDAO, atLeastOnce()).update(updatesCaptor.capture());
        assertTrue(updatesCaptor.getAllValues().stream()
                .flatMap(wrapper -> wrapper.getParamNameValuePairs().values().stream())
                .map(String::valueOf)
                .anyMatch(value -> value.contains("\"voxelization\":12.5")));
    }

    @Test
    void ensureVisibility_submitsTaskAgainstSucceededOccRun() {
        prepareRunnableScene();
        when(userDAO.getById(1L)).thenReturn(
                ai.basic.x1.adapter.port.dao.mybatis.model.User.builder()
                        .id(1L)
                        .role(UserRoleEnum.ADMIN)
                        .build());
        SceneVisibilityRun occRun = succeededRun();
        occRun.setTaskType(SceneVisibilityTaskTypeEnum.OCC);
        when(runDAO.getById(7L)).thenReturn(occRun);
        when(runDAO.save(any())).thenAnswer(invocation -> {
            SceneVisibilityRun run = invocation.getArgument(0);
            run.setId(8L);
            return true;
        });
        when(runDAO.getById(8L)).thenReturn(savedRun());
        when(workerCaller.submit(any())).thenReturn(
                SceneVisibilityManifestDTO.Response.builder().frameCount(1).build());
        when(runDAO.update(any())).thenReturn(true);

        SceneVisibilityRun run = useCase().ensureVisibility(7L, List.of(10L), 1L);

        assertEquals(8L, run.getId());
        ArgumentCaptor<SceneVisibilityManifestDTO.Manifest> captor =
                ArgumentCaptor.forClass(SceneVisibilityManifestDTO.Manifest.class);
        verify(workerCaller).submit(captor.capture());
        assertEquals("VISIBILITY", captor.getValue().getTaskType());
        assertEquals("visibility/8/9/7", captor.getValue().getOccOutputPrefix());
    }

    @Test
    void ensure_initializesRunTimestampsBeforeSaving() {
        prepareRunnableScene();
        when(runDAO.getOne(any())).thenReturn(null);
        ArgumentCaptor<SceneVisibilityRun> runCaptor =
                ArgumentCaptor.forClass(SceneVisibilityRun.class);
        when(runDAO.save(runCaptor.capture())).thenReturn(true);

        useCase().ensure(8L, 9L);

        SceneVisibilityRun savedRun = runCaptor.getValue();
        assertNotNull(savedRun.getCreatedAt());
        assertNotNull(savedRun.getUpdatedAt());
        assertEquals(savedRun.getCreatedAt(), savedRun.getUpdatedAt());
    }

    @Test
    void ensure_normalizesLegacyMapContentWithNestedFilesBeforeSubmittingManifest() {
        prepareScene(legacyMapContent());
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of(
                annotation(1L, 301L, boxAttributes(1.0))));
        when(datasetClassDAO.list(any())).thenReturn(List.of(DatasetClass.builder()
                .id(301L)
                .datasetId(8L)
                .name("car")
                .build()));
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/frame-1.pcd"),
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(runDAO.getOne(any())).thenReturn(null);
        when(runDAO.save(any())).thenAnswer(invocation -> {
            SceneVisibilityRun run = invocation.getArgument(0);
            run.setId(7L);
            return true;
        });
        when(runDAO.getById(7L)).thenAnswer(invocation -> savedRun());
        when(workerCaller.submit(any())).thenReturn(
                SceneVisibilityManifestDTO.Response.builder()
                        .manifestObjectKey("visibility/8/9/7/manifest.json")
                        .frameCount(1)
                        .build());
        when(runDAO.update(any())).thenReturn(true);

        SceneVisibilityRun run = useCase().ensure(8L, 9L);

        assertEquals(7L, run.getId());
        ArgumentCaptor<SceneVisibilityManifestDTO.Manifest> captor =
                ArgumentCaptor.forClass(SceneVisibilityManifestDTO.Manifest.class);
        verify(workerCaller).submit(captor.capture());
        assertEquals("raw/scene/frame-1.pcd",
                captor.getValue().getFrames().get(0).getPointCloudObjectKey());
        assertEquals("raw/scene/camera_config/camera.json",
                captor.getValue().getCameraConfigObjectKey());
    }

    @Test
    void ensure_resolvesSceneCameraConfigBesideLegacyPointCloud() {
        prepareScene(frameContentWithoutCameraConfig(101L));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of(
                annotation(1L, 301L, boxAttributes(1.0))));
        when(datasetClassDAO.list(any())).thenReturn(List.of(DatasetClass.builder()
                .id(301L)
                .datasetId(8L)
                .name("car")
                .build()));
        when(fileDAO.listByIds(List.of(101L))).thenReturn(List.of(
                file(101L, "raw/scene/lidar_point_cloud/frame-1.pcd")));
        when(fileDAO.list(any())).thenReturn(List.of(
                file(201L, "raw/scene/camera_config/camera_config.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(runDAO.getOne(any())).thenReturn(null);
        when(runDAO.save(any())).thenAnswer(invocation -> {
            SceneVisibilityRun run = invocation.getArgument(0);
            run.setId(7L);
            return true;
        });
        when(runDAO.getById(7L)).thenAnswer(invocation -> savedRun());
        when(workerCaller.submit(any())).thenReturn(
                SceneVisibilityManifestDTO.Response.builder()
                        .manifestObjectKey("visibility/8/9/7/manifest.json")
                        .frameCount(1)
                        .build());
        when(runDAO.update(any())).thenReturn(true);

        useCase().ensure(8L, 9L);

        ArgumentCaptor<SceneVisibilityManifestDTO.Manifest> captor =
                ArgumentCaptor.forClass(SceneVisibilityManifestDTO.Manifest.class);
        verify(workerCaller).submit(captor.capture());
        assertEquals("raw/scene/camera_config/camera_config.json",
                captor.getValue().getCameraConfigObjectKey());
    }

    @Test
    void ensure_interpolatesLegacyLocationSamplesWhenFramePoseIsMissing() {
        prepareScene(frameContent(101L, 201L));
        when(dataInfoDAO.list(any())).thenReturn(List.of(DataInfo.builder()
                .id(10L)
                .datasetId(8L)
                .parentId(9L)
                .name("frame_1_1.pcd")
                .orderName("0001")
                .type(ItemTypeEnum.SINGLE_DATA)
                .isDeleted(false)
                .content(frameContent(101L, 201L))
                .build()));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of(
                annotation(1L, 301L, boxAttributes(1.0))));
        when(datasetClassDAO.list(any())).thenReturn(List.of(DatasetClass.builder()
                .id(301L)
                .datasetId(8L)
                .name("car")
                .build()));
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/lidar_point_cloud/frame_1_1.pcd"),
                file(201L, "raw/scene/camera_config/camera_config.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of());
        when(sceneLocationSampleDAO.list(any())).thenReturn(List.of(
                SceneLocationSample.builder()
                        .sceneId(9L)
                        .timestampNs(1_000_000_001L)
                        .posX(1.0)
                        .posY(2.0)
                        .posZ(3.0)
                        .yaw(0.5)
                        .build()));
        when(runDAO.getOne(any())).thenReturn(null);
        when(runDAO.save(any())).thenAnswer(invocation -> {
            SceneVisibilityRun run = invocation.getArgument(0);
            run.setId(7L);
            return true;
        });
        when(runDAO.getById(7L)).thenAnswer(invocation -> savedRun());
        when(workerCaller.submit(any())).thenReturn(
                SceneVisibilityManifestDTO.Response.builder()
                        .manifestObjectKey("visibility/8/9/7/manifest.json")
                        .frameCount(1)
                        .build());
        when(runDAO.update(any())).thenReturn(true);

        useCase().ensure(8L, 9L);

        ArgumentCaptor<SceneVisibilityManifestDTO.Manifest> captor =
                ArgumentCaptor.forClass(SceneVisibilityManifestDTO.Manifest.class);
        verify(workerCaller).submit(captor.capture());
        assertEquals(1.0, captor.getValue().getFrames().get(0).getPose().getX());
        assertEquals(0.5, captor.getValue().getFrames().get(0).getPose().getYaw());
    }

    @Test
    void ensure_rejectsSelectedFrameOutsideScene() {
        prepareScene(frameContent(101L, 201L));

        UsecaseException exception = assertThrows(
                UsecaseException.class,
                () -> useCase().ensure(8L, 9L, List.of(11L)));

        assertTrue(exception.getMessage().contains("Selected frame does not belong to scene"));
    }

    @Test
    void status_rejectsUserWithoutDatasetAccess() {
        when(runDAO.getById(7L)).thenReturn(savedRun());
        when(datasetDAO.getById(8L)).thenReturn(Dataset.builder().id(8L).createdBy(1L).build());
        when(userDAO.getById(2L)).thenReturn(ai.basic.x1.adapter.port.dao.mybatis.model.User.builder()
                .id(2L)
                .role(UserRoleEnum.ANNOTATOR)
                .build());

        UsecaseException exception = assertThrows(
                UsecaseException.class,
                () -> useCase().status(7L, 2L));

        assertTrue(exception.getMessage().contains("not authorized"));
    }

    @Test
    void ensure_sourceHashUsesCanonicalAnnotationSnapshot() {
        prepareScene(List.of(DataInfo.FileNode.builder()
                .name("camera_config")
                .type("file")
                .fileId(201L)
                .build()));
        when(fileDAO.listByIds(List.of(201L))).thenReturn(List.of(
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(
                List.of(annotation(2L, 302L, "{\"contour\":{\"z\":2,\"a\":1}}"),
                        annotation(1L, 301L, "{\"type\":\"car\"}")),
                List.of(annotation(1L, 301L, "{\"type\":\"car\"}"),
                        annotation(2L, 302L, "{\"contour\":{\"a\":1,\"z\":2}}")),
                List.of(annotation(1L, 301L, "{\"type\":\"truck\"}"),
                        annotation(2L, 302L, "{\"contour\":{\"a\":1,\"z\":2}}")));
        when(runDAO.getOne(any())).thenReturn(null);
        ArgumentCaptor<SceneVisibilityRun> runCaptor =
                ArgumentCaptor.forClass(SceneVisibilityRun.class);
        when(runDAO.save(runCaptor.capture())).thenReturn(true);

        useCase().ensure(8L, 9L);
        useCase().ensure(8L, 9L);
        useCase().ensure(8L, 9L);

        List<SceneVisibilityRun> runs = runCaptor.getAllValues();
        assertEquals(runs.get(0).getSourceHash(), runs.get(1).getSourceHash());
        assertNotEquals(runs.get(1).getSourceHash(), runs.get(2).getSourceHash());
    }

    @Test
    void ensure_reusesRunWithSameSourceHash() {
        prepareScene(frameContent(101L, 201L));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of());
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/frame-1.pcd"),
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        SceneVisibilityRun existing = savedRun();
        when(runDAO.getOne(any())).thenReturn(existing);

        SceneVisibilityRun result = useCase().ensure(8L, 9L);

        assertEquals(existing, result);
        verify(runDAO, never()).save(any());
        verify(workerCaller, never()).submit(any());
    }

    @Test
    void ensure_changesSourceHashWhenFileAtSamePathIsReplaced() {
        prepareScene(List.of(DataInfo.FileNode.builder()
                .name("camera_config")
                .type("file")
                .fileId(201L)
                .build()));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of());
        when(fileDAO.listByIds(List.of(201L))).thenReturn(
                List.of(file(201L, "raw/scene/camera_config/camera.json", 100L)),
                List.of(file(201L, "raw/scene/camera_config/camera.json", 200L)));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(runDAO.getOne(any())).thenReturn(null);
        ArgumentCaptor<SceneVisibilityRun> runCaptor =
                ArgumentCaptor.forClass(SceneVisibilityRun.class);
        when(runDAO.save(runCaptor.capture())).thenReturn(true);

        useCase().ensure(8L, 9L);
        useCase().ensure(8L, 9L);

        List<SceneVisibilityRun> runs = runCaptor.getAllValues();
        assertNotEquals(runs.get(0).getSourceHash(), runs.get(1).getSourceHash());
    }

    @Test
    void ensure_requeuesFailedRunWithSameSourceHash() {
        prepareScene(frameContent(101L, 201L));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of(
                annotation(1L, 301L, boxAttributes(1.0))));
        when(datasetClassDAO.list(any())).thenReturn(List.of(DatasetClass.builder()
                .id(301L)
                .datasetId(8L)
                .name("car")
                .build()));
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/frame-1.pcd"),
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        SceneVisibilityRun failedRun = savedRun();
        failedRun.setStatus(SceneVisibilityRunStatusEnum.FAILED);
        failedRun.setError("temporary worker failure");
        when(runDAO.getOne(any())).thenReturn(failedRun);
        when(runDAO.getById(7L)).thenReturn(failedRun);
        when(workerCaller.submit(any())).thenReturn(
                SceneVisibilityManifestDTO.Response.builder()
                        .manifestObjectKey("visibility/8/9/7/manifest.json")
                        .frameCount(1)
                        .build());
        when(runDAO.update(any())).thenReturn(true);

        SceneVisibilityRun result = useCase().ensure(8L, 9L);

        assertEquals(SceneVisibilityRunStatusEnum.QUEUED, result.getStatus());
        verify(runDAO, never()).save(any());
        verify(workerCaller).submit(any());
        verify(runDAO, atLeastOnce()).update(any());
    }

    @Test
    void ensure_concurrentFailedRunRequeuesSubmitOnlyOnce() throws Exception {
        prepareRunnableScene();
        SceneVisibilityRun failedRun = failedRun();
        SceneVisibilityRun queuedRun = savedRun();
        queuedRun.setStatus(SceneVisibilityRunStatusEnum.QUEUED);
        AtomicInteger reads = new AtomicInteger();
        CyclicBarrier firstReads = new CyclicBarrier(2);
        when(runDAO.getOne(any())).thenAnswer(invocation -> {
            if (reads.incrementAndGet() <= 2) {
                firstReads.await(5, TimeUnit.SECONDS);
                return failedRun;
            }
            return queuedRun;
        });
        AtomicInteger updates = new AtomicInteger();
        when(runDAO.update(any())).thenAnswer(invocation -> updates.incrementAndGet() != 2);
        when(runDAO.getById(7L)).thenReturn(queuedRun);
        when(workerCaller.submit(any())).thenReturn(
                SceneVisibilityManifestDTO.Response.builder()
                        .manifestObjectKey("visibility/8/9/7/manifest.json")
                        .frameCount(1)
                        .build());
        QueuedExecutorService executor = new QueuedExecutorService();
        ExecutorService callers = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            java.util.concurrent.Future<SceneVisibilityRun> first =
                    callers.submit(() -> useCase(executor).ensure(8L, 9L));
            java.util.concurrent.Future<SceneVisibilityRun> second =
                    callers.submit(() -> useCase(executor).ensure(8L, 9L));
            first.get(5, TimeUnit.SECONDS);
            second.get(5, TimeUnit.SECONDS);
            executor.runAll();
        } finally {
            callers.shutdownNow();
            executor.shutdownNow();
        }

        assertEquals(1, executor.executedTaskCount());
        verify(workerCaller, times(1)).submit(any());
    }

    @Test
    void ensure_failedRequeueLoserRereadsSuccessfulRunWithoutSubmitting() {
        prepareRunnableScene();
        SceneVisibilityRun failedRun = failedRun();
        SceneVisibilityRun succeededRun = succeededRun();
        when(runDAO.getOne(any())).thenReturn(failedRun, succeededRun);
        when(runDAO.update(any())).thenReturn(false);

        SceneVisibilityRun result = useCase().ensure(8L, 9L);

        assertEquals(SceneVisibilityRunStatusEnum.SUCCEEDED, result.getStatus());
        verify(workerCaller, never()).submit(any());
    }

    @Test
    void ensure_failedWorkerCannotOverwriteSuccessfulRun() {
        prepareRunnableScene();
        SceneVisibilityRun failedRun = failedRun();
        AtomicReference<SceneVisibilityRunStatusEnum> persistedStatus =
                new AtomicReference<>(SceneVisibilityRunStatusEnum.FAILED);
        AtomicInteger updates = new AtomicInteger();
        ArgumentCaptor<LambdaUpdateWrapper<SceneVisibilityRun>> updatesCaptor =
                ArgumentCaptor.forClass((Class) LambdaUpdateWrapper.class);
        when(runDAO.getOne(any())).thenReturn(failedRun);
        when(runDAO.getById(7L)).thenReturn(savedRun());
        when(runDAO.update(any())).thenAnswer(invocation -> {
            int updateNumber = updates.incrementAndGet();
            if (updateNumber == 1) {
                persistedStatus.set(SceneVisibilityRunStatusEnum.QUEUED);
                return true;
            }
            if (updateNumber == 2) {
                persistedStatus.set(SceneVisibilityRunStatusEnum.RUNNING);
                return true;
            }
            return false;
        });
        when(workerCaller.submit(any())).thenAnswer(invocation -> {
            persistedStatus.set(SceneVisibilityRunStatusEnum.SUCCEEDED);
            throw new UsecaseException("worker response disconnected after completion");
        });

        useCase().ensure(8L, 9L);

        assertEquals(SceneVisibilityRunStatusEnum.SUCCEEDED, persistedStatus.get());
        verify(runDAO, times(3)).update(updatesCaptor.capture());
        String failureConditions = updatesCaptor.getAllValues().get(2)
                .getExpression().getNormal().getSqlSegment();
        assertTrue(failureConditions.contains("status"),
                "failure transition must require RUNNING state: " + failureConditions);
    }

    @Test
    void ensure_reusesUnchangedManifestAndRerunsAfterAnnotationGeometryChanges() {
        prepareScene(frameContent(101L, 201L));
        long[] nextRunId = {7L};
        when(dataAnnotationObjectDAO.list(any())).thenReturn(
                List.of(annotation(1L, 301L, boxAttributes(1.0))),
                List.of(annotation(1L, 301L, boxAttributes(1.0))),
                List.of(annotation(1L, 301L, boxAttributes(2.0))));
        when(datasetClassDAO.list(any())).thenReturn(List.of(DatasetClass.builder()
                .id(301L)
                .datasetId(8L)
                .name("car")
                .build()));
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/frame-1.pcd"),
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(runDAO.getOne(any())).thenReturn(null, savedRun(), null);
        when(runDAO.save(any())).thenAnswer(invocation -> {
            SceneVisibilityRun run = invocation.getArgument(0);
            run.setId(nextRunId[0]++);
            return true;
        });
        when(runDAO.getById(any())).thenAnswer(invocation -> SceneVisibilityRun.builder()
                .id(invocation.getArgument(0))
                .datasetId(8L)
                .sceneId(9L)
                .sourceHash("a".repeat(64))
                .algorithmVersion("xtreme-occ-v1")
                .status(SceneVisibilityRunStatusEnum.QUEUED)
                .totalFrames(1)
                .build());
        when(workerCaller.submit(any())).thenReturn(
                SceneVisibilityManifestDTO.Response.builder()
                        .manifestObjectKey("visibility/8/9/7/manifest.json")
                        .frameCount(1)
                        .build());
        when(runDAO.update(any())).thenReturn(true);

        SceneVisibilityRun first = useCase().ensure(8L, 9L);
        SceneVisibilityRun reused = useCase().ensure(8L, 9L);
        SceneVisibilityRun regenerated = useCase().ensure(8L, 9L);

        assertEquals(first.getId(), reused.getId());
        assertNotEquals(first.getSourceHash(), regenerated.getSourceHash());
        assertNotEquals(first.getId(), regenerated.getId());
        verify(workerCaller, times(2)).submit(any());
    }

    @Test
    void force_createsNonDefaultGenerationForTheSameInput() {
        prepareRunnableScene();
        when(datasetDAO.getById(8L)).thenReturn(Dataset.builder()
                .id(8L)
                .createdBy(1L)
                .type(DatasetTypeEnum.LIDAR_FUSION)
                .build());
        when(userDAO.getById(1L)).thenReturn(ai.basic.x1.adapter.port.dao.mybatis.model.User.builder()
                .id(1L)
                .role(UserRoleEnum.ANNOTATOR)
                .build());
        when(runDAO.getOne(any())).thenReturn(null);
        List<SceneVisibilityRun> savedRuns = new java.util.ArrayList<>();
        when(runDAO.save(any())).thenAnswer(invocation -> {
            SceneVisibilityRun run = invocation.getArgument(0);
            run.setId((long) savedRuns.size() + 7L);
            savedRuns.add(run);
            return true;
        });

        SceneVisibilityUseCase useCase = useCase(new QueuedExecutorService());
        useCase.ensure(8L, 9L);
        useCase.force(8L, 9L, null, 1L);

        assertEquals(savedRuns.get(0).getSourceHash(), savedRuns.get(1).getSourceHash());
        assertNotEquals("", savedRuns.get(1).getGenerationToken());
        assertFalse(savedRuns.get(1).getIsDefault());
    }

    @Test
    void ensure_recordsFailedRunWhenPointCloudIsMissing() {
        prepareScene(List.of(DataInfo.FileNode.builder()
                .name("camera_config")
                .type("file")
                .fileId(201L)
                .build()));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of());
        when(fileDAO.listByIds(List.of(201L))).thenReturn(List.of(
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(runDAO.getOne(any())).thenReturn(null);
        ArgumentCaptor<SceneVisibilityRun> runCaptor =
                ArgumentCaptor.forClass(SceneVisibilityRun.class);
        when(runDAO.save(runCaptor.capture())).thenReturn(true);

        SceneVisibilityRun result = useCase().ensure(8L, 9L);

        assertEquals(SceneVisibilityRunStatusEnum.FAILED, result.getStatus());
        assertTrue(result.getError().contains("point cloud"));
        assertEquals(SceneVisibilityRunStatusEnum.FAILED, runCaptor.getValue().getStatus());
        verify(workerCaller, never()).submit(any());
    }

    @Test
    void ensure_reportsUnknownDatasetClassMappingWithActionableMetadata() {
        prepareSemanticMappingFailure();

        org.mockito.Mockito.lenient().when(datasetClassDAO.list(any())).thenReturn(List.of(DatasetClass.builder()
                .id(301L)
                .datasetId(8L)
                .name("unknown_label")
                .build()));

        useCase().ensure(8L, 9L);

        assertFailedMappingError("classId=301", "name=unknown_label", "horizon-v3.8");
        verify(workerCaller, never()).submit(any());
    }

    @Test
    void ensure_reportsMissingDatasetClassMetadataWithActionableMetadata() {
        prepareSemanticMappingFailure();

        when(datasetClassDAO.list(any())).thenReturn(List.of());

        useCase().ensure(8L, 9L);

        assertFailedMappingError("classId=301", "name=null", "horizon-v3.8");
        verify(workerCaller, never()).submit(any());
    }

    @Test
    void ensure_ignoresParkingSpaceGroundPolygonWithoutSemanticMapping() {
        prepareScene(frameContent(101L, 201L));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of(
                annotation(1L, 8L, "{\"type\":\"GROUND_POLYGON\","
                        + "\"className\":\"parkingspace\","
                        + "\"contour\":{\"points\":[]}}")));
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/frame-1.pcd"),
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(runDAO.getOne(any())).thenReturn(null);
        when(runDAO.save(any())).thenAnswer(invocation -> {
            SceneVisibilityRun run = invocation.getArgument(0);
            run.setId(7L);
            return true;
        });
        when(runDAO.getById(7L)).thenAnswer(invocation -> savedRun());
        when(workerCaller.submit(any())).thenReturn(
                SceneVisibilityManifestDTO.Response.builder()
                        .manifestObjectKey("visibility/8/9/7/manifest.json")
                        .frameCount(1)
                        .build());
        when(runDAO.update(any())).thenReturn(true);

        useCase().ensure(8L, 9L);

        ArgumentCaptor<SceneVisibilityManifestDTO.Manifest> captor =
                ArgumentCaptor.forClass(SceneVisibilityManifestDTO.Manifest.class);
        verify(workerCaller).submit(captor.capture());
        assertTrue(captor.getValue().getAlgorithm().getClassMap().isEmpty());
    }

    @Test
    void frameResult_readsSidecarForSucceededRunFrame() {
        when(runDAO.getById(7L)).thenReturn(succeededRun());
        when(dataInfoDAO.getById(10L)).thenReturn(frame());
        when(minioProp.getBucketName()).thenReturn("xtreme1");
        String objectKey = "visibility/8/9/7/visibility/10.json";
        when(minioService.objectExists("xtreme1", objectKey)).thenReturn(true);
        when(minioService.readObjectAsString("xtreme1", objectKey))
                .thenReturn("{\"schemaVersion\":\"xtreme-visibility/v1\",\"dataId\":\"10\"}");

        JSONObject result = useCase().frameResult(7L, 10L);

        assertEquals("xtreme-visibility/v1", result.getStr("schemaVersion"));
        assertEquals("10", result.getStr("dataId"));
        verify(dataAnnotationObjectDAO, never()).save(any());
        verify(dataAnnotationObjectDAO, never()).update(any());
    }

    @Test
    void frameResult_rejectsRunThatHasNotSucceeded() {
        when(runDAO.getById(7L)).thenReturn(savedRun());

        UsecaseException exception = assertThrows(
                UsecaseException.class,
                () -> useCase().frameResult(7L, 10L));

        assertTrue(exception.getMessage().contains("must be SUCCEEDED"));
        verify(minioService, never()).readObjectAsString(any(), any());
    }

    @Test
    void requireSucceededRunForDataset_rejectsIncompleteOrForeignRun() {
        when(runDAO.getById(7L)).thenReturn(savedRun());

        UsecaseException incomplete = assertThrows(
                UsecaseException.class,
                () -> useCase().requireSucceededRunForDataset(7L, 8L));

        assertTrue(incomplete.getMessage().contains("SUCCEEDED for export"));
        when(runDAO.getById(7L)).thenReturn(succeededRun());
        UsecaseException foreign = assertThrows(
                UsecaseException.class,
                () -> useCase().requireSucceededRunForDataset(7L, 99L));
        assertTrue(foreign.getMessage().contains("does not match export"));
    }

    @Test
    void requireCurrentSucceededRunForDataset_rejectsExpiredInputSnapshot() {
        when(dataInfoDAO.list(any())).thenReturn(List.of(DataInfo.builder()
                .id(10L)
                .datasetId(8L)
                .parentId(9L)
                .orderName("0001")
                .type(ItemTypeEnum.SINGLE_DATA)
                .isDeleted(false)
                .content(frameContent(101L, 201L))
                .build()));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of());
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/frame-1.pcd"),
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(runDAO.getById(7L)).thenReturn(succeededRun());

        UsecaseException exception = assertThrows(
                UsecaseException.class,
                () -> useCase().requireCurrentSucceededRunForDataset(7L, 8L));

        assertTrue(exception.getMessage().contains("Visibility run expired"));
        assertTrue(exception.getMessage().contains("ensure again"));
    }

    @Test
    void frameResult_rejectsDataOutsideRunScene() {
        when(runDAO.getById(7L)).thenReturn(succeededRun());
        when(dataInfoDAO.getById(10L)).thenReturn(DataInfo.builder()
                .id(10L)
                .datasetId(8L)
                .parentId(99L)
                .type(ItemTypeEnum.SINGLE_DATA)
                .isDeleted(false)
                .build());

        UsecaseException exception = assertThrows(
                UsecaseException.class,
                () -> useCase().frameResult(7L, 10L));

        assertTrue(exception.getMessage().contains("does not belong"));
        verify(minioService, never()).readObjectAsString(any(), any());
    }

    @Test
    void frameResult_reportsMissingSidecarObjectKey() {
        when(runDAO.getById(7L)).thenReturn(succeededRun());
        when(dataInfoDAO.getById(10L)).thenReturn(frame());
        when(minioProp.getBucketName()).thenReturn("xtreme1");
        String objectKey = "visibility/8/9/7/visibility/10.json";
        when(minioService.objectExists("xtreme1", objectKey)).thenReturn(false);

        UsecaseException exception = assertThrows(
                UsecaseException.class,
                () -> useCase().frameResult(7L, 10L));

        assertEquals("NOT_FOUND", exception.getCode().getCode());
        assertTrue(exception.getMessage().contains(objectKey));
        verify(minioService, never()).readObjectAsString(any(), any());
    }

    @Test
    void occVisualization_proxiesRunOccObjectKey() {
        when(runDAO.getById(7L)).thenReturn(succeededRun());
        when(dataInfoDAO.getById(10L)).thenReturn(frame());
        when(workerCaller.occVisualization(
                "visibility/8/9/7/occ/10/labels.npz", 5000))
                .thenReturn(JSONUtil.parseObj("{\"voxelCount\":12}"));

        JSONObject result = useCase().occVisualization(7L, 10L, 5000);

        assertEquals(12, result.getInt("voxelCount"));
        verify(dataAnnotationObjectDAO, never()).save(any());
        verify(dataAnnotationObjectDAO, never()).update(any());
    }

    @Test
    void occVisualization_proxiesLidarMaskLayer() {
        when(runDAO.getById(7L)).thenReturn(succeededRun());
        when(dataInfoDAO.getById(10L)).thenReturn(frame());
        when(workerCaller.occVisualization(
                "visibility/8/9/7/occ/10/labels.npz", 5000, "lidar-mask"))
                .thenReturn(JSONUtil.parseObj("{\"voxelCount\":12}"));

        JSONObject result = useCase().occVisualization(7L, 10L, 5000, "lidar-mask");

        assertEquals(12, result.getInt("voxelCount"));
    }

    private SceneVisibilityUseCase useCase() {
        return useCase(MoreExecutors.newDirectExecutorService());
    }

    private SceneVisibilityUseCase useCase(ExecutorService executorService) {
        return new SceneVisibilityUseCase(
                dataInfoDAO,
                dataAnnotationObjectDAO,
                datasetClassDAO,
                datasetDAO,
                fileDAO,
                sceneLocationDAO,
                sceneLocationSampleDAO,
                runDAO,
                userDAO,
                workerCaller,
                minioService,
                minioProp,
                executorService,
                "xtreme-occ-v1");
    }

    private void prepareRunnableScene() {
        prepareScene(frameContent(101L, 201L));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of(
                annotation(1L, 301L, boxAttributes(1.0))));
        org.mockito.Mockito.lenient().when(datasetClassDAO.list(any())).thenReturn(List.of(DatasetClass.builder()
                .id(301L)
                .datasetId(8L)
                .name("car")
                .build()));
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/frame-1.pcd"),
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
    }

    private void prepareSemanticMappingFailure() {
        prepareScene(frameContent(101L, 201L));
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of(
                annotation(1L, 301L, boxAttributes(1.0))));
        when(fileDAO.listByIds(List.of(101L, 201L))).thenReturn(List.of(
                file(101L, "raw/scene/frame-1.pcd"),
                file(201L, "raw/scene/camera_config/camera.json")));
        when(sceneLocationDAO.list(any())).thenReturn(List.of(pose()));
        when(runDAO.getOne(any())).thenReturn(null);
        when(runDAO.save(any())).thenAnswer(invocation -> {
            SceneVisibilityRun run = invocation.getArgument(0);
            run.setId(7L);
            return true;
        });
        when(runDAO.getById(7L)).thenReturn(savedRun());
        when(runDAO.update(any())).thenReturn(true);
    }

    @SuppressWarnings("unchecked")
    private void assertFailedMappingError(String... expectedFragments) {
        ArgumentCaptor<LambdaUpdateWrapper<SceneVisibilityRun>> captor =
                ArgumentCaptor.forClass((Class) LambdaUpdateWrapper.class);
        verify(runDAO, atLeast(2)).update(captor.capture());
        String values = captor.getAllValues().stream()
                .flatMap(wrapper -> wrapper.getParamNameValuePairs().values().stream())
                .map(String::valueOf)
                .collect(Collectors.joining(" "));
        for (String expectedFragment : expectedFragments) {
            assertTrue(values.contains(expectedFragment));
        }
    }

    private void prepareScene(List<DataInfo.FileNode> content) {
        when(datasetDAO.getById(8L)).thenReturn(Dataset.builder()
                .id(8L)
                .type(DatasetTypeEnum.LIDAR_FUSION)
                .isDeleted(false)
                .build());
        org.mockito.Mockito.lenient().when(dataInfoDAO.getById(9L)).thenReturn(DataInfo.builder()
                .id(9L)
                .datasetId(8L)
                .type(ItemTypeEnum.SCENE)
                .isDeleted(false)
                .build());
        when(dataInfoDAO.list(any())).thenReturn(List.of(DataInfo.builder()
                .id(10L)
                .datasetId(8L)
                .parentId(9L)
                .name("frame-1")
                .orderName("0001")
                .type(ItemTypeEnum.SINGLE_DATA)
                .isDeleted(false)
                .content(content)
                .build()));
    }

    private static DataAnnotationObject annotation(
            Long id,
            Long classId,
            String classAttributes) {
        return DataAnnotationObject.builder()
                .id(id)
                .datasetId(8L)
                .dataId(10L)
                .classId(classId)
                .classAttributes(JSONUtil.parseObj(classAttributes))
                .sourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW)
                .build();
    }

    private static String boxAttributes(double x) {
        return "{\"type\":\"3D_BOX\",\"contour\":{\"center3D\":{\"x\":" + x
                + ",\"y\":2,\"z\":3},\"size3D\":{\"x\":4,\"y\":5,\"z\":6},"
                + "\"rotation3D\":{\"x\":0,\"y\":0,\"z\":0}}}";
    }

    private static List<DataInfo.FileNode> frameContent(Long pointCloudId, Long cameraConfigId) {
        return List.of(
                DataInfo.FileNode.builder()
                        .name("lidar_point_cloud")
                        .type("file")
                        .fileId(pointCloudId)
                        .build(),
                DataInfo.FileNode.builder()
                        .name("camera_config")
                        .type("file")
                        .fileId(cameraConfigId)
                        .build());
    }

    private static List<DataInfo.FileNode> frameContentWithoutCameraConfig(Long pointCloudId) {
        return List.of(DataInfo.FileNode.builder()
                .name("lidar_point_cloud")
                .type("file")
                .fileId(pointCloudId)
                .build());
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static List<DataInfo.FileNode> legacyMapContent() {
        Map<String, Object> pointCloud = new LinkedHashMap<>();
        pointCloud.put("name", "lidar_point_cloud");
        pointCloud.put("fileId", 101L);
        pointCloud.put("type", "file");
        Map<String, Object> cameraConfig = new LinkedHashMap<>();
        cameraConfig.put("name", "camera.json");
        cameraConfig.put("fileId", "201");
        cameraConfig.put("type", "file");
        Map<String, Object> cameraDirectory = new LinkedHashMap<>();
        cameraDirectory.put("name", "camera_config");
        cameraDirectory.put("type", "directory");
        cameraDirectory.put("files", List.of(cameraConfig));
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("name", "inputs");
        root.put("type", "directory");
        root.put("files", List.of(pointCloud, cameraDirectory));
        return (List) List.of(root);
    }

    private static ai.basic.x1.adapter.port.dao.mybatis.model.File file(Long id, String path) {
        return ai.basic.x1.adapter.port.dao.mybatis.model.File.builder()
                .id(id)
                .path(path)
                .build();
    }

    private static ai.basic.x1.adapter.port.dao.mybatis.model.File file(
            Long id, String path, Long size) {
        return ai.basic.x1.adapter.port.dao.mybatis.model.File.builder()
                .id(id)
                .path(path)
                .size(size)
                .build();
    }

    private static SceneLocation pose() {
        return SceneLocation.builder()
                .dataId(10L)
                .posX(1.0)
                .posY(2.0)
                .posZ(0.0)
                .yaw(0.1)
                .roll(0.0)
                .pitch(0.0)
                .build();
    }

    private static SceneVisibilityRun savedRun() {
        return SceneVisibilityRun.builder()
                .id(7L)
                .datasetId(8L)
                .sceneId(9L)
                .sourceHash("a".repeat(64))
                .algorithmVersion("xtreme-occ-v1")
                .status(SceneVisibilityRunStatusEnum.QUEUED)
                .progress(0.0)
                .totalFrames(1)
                .completedFrames(0)
                .build();
    }

    private static SceneVisibilityRun succeededRun() {
        SceneVisibilityRun run = savedRun();
        run.setStatus(SceneVisibilityRunStatusEnum.SUCCEEDED);
        run.setProgress(1.0);
        run.setCompletedFrames(1);
        return run;
    }

    private static SceneVisibilityRun failedRun() {
        SceneVisibilityRun run = savedRun();
        run.setStatus(SceneVisibilityRunStatusEnum.FAILED);
        run.setError("temporary worker failure");
        return run;
    }

    private static final class QueuedExecutorService extends AbstractExecutorService {
        private final List<Runnable> tasks = new java.util.ArrayList<>();
        private boolean shutdown;
        private int executedTaskCount;

        @Override
        public synchronized void shutdown() {
            shutdown = true;
        }

        @Override
        public synchronized List<Runnable> shutdownNow() {
            shutdown = true;
            List<Runnable> pending = List.copyOf(tasks);
            tasks.clear();
            return pending;
        }

        @Override
        public synchronized boolean isShutdown() {
            return shutdown;
        }

        @Override
        public synchronized boolean isTerminated() {
            return shutdown && tasks.isEmpty();
        }

        @Override
        public boolean awaitTermination(long timeout, TimeUnit unit) {
            return isTerminated();
        }

        @Override
        public synchronized void execute(Runnable command) {
            if (shutdown) {
                throw new IllegalStateException("executor is shut down");
            }
            tasks.add(command);
        }

        private synchronized void runAll() {
            List<Runnable> pending = List.copyOf(tasks);
            tasks.clear();
            for (Runnable task : pending) {
                task.run();
                executedTaskCount++;
            }
        }

        private synchronized int executedTaskCount() {
            return executedTaskCount;
        }
    }

    private static DataInfo frame() {
        return DataInfo.builder()
                .id(10L)
                .datasetId(8L)
                .parentId(9L)
                .type(ItemTypeEnum.SINGLE_DATA)
                .isDeleted(false)
                .build();
    }
}
