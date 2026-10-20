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
import ai.basic.x1.adapter.port.dao.mybatis.model.File;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocation;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocationSample;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneVisibilityRun;
import ai.basic.x1.adapter.port.dao.mybatis.model.User;
import ai.basic.x1.adapter.port.minio.MinioProp;
import ai.basic.x1.adapter.port.minio.MinioService;
import ai.basic.x1.adapter.port.rpc.SceneVisibilityWorkerHttpCaller;
import ai.basic.x1.adapter.port.rpc.dto.SceneVisibilityManifestDTO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.DatasetTypeEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import ai.basic.x1.entity.enums.SceneVisibilityRunStatusEnum;
import ai.basic.x1.entity.enums.SceneVisibilityRunStageEnum;
import ai.basic.x1.entity.enums.SceneVisibilityTaskTypeEnum;
import ai.basic.x1.entity.enums.UserRoleEnum;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.json.JSONUtil;
import cn.hutool.json.JSONObject;
import com.alibaba.ttl.TtlRunnable;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.stream.Collectors;

@Slf4j
public class SceneVisibilityUseCase {

    private static final String SCHEMA_VERSION = "xtreme-occ-run/v1";
    private static final int MAX_ERROR_LENGTH = 8000;
    private static final int OCC_FUSION_WINDOW = 5;
    private static final String OCC_CLASS_MAP_VERSION = "horizon-v3.8";
    private static final Map<String, Integer> OCC_CLASS_IDS = Map.ofEntries(
            Map.entry("car", 2), Map.entry("cone", 3), Map.entry("pillar", 4),
            Map.entry("person", 5), Map.entry("ground", 6), Map.entry("curb", 7),
            Map.entry("wall", 8), Map.entry("fence", 9), Map.entry("wheel_stopper", 10),
            Map.entry("pole", 11), Map.entry("board_no_parking", 12),
            Map.entry("no_parking_board", 12), Map.entry("wall_other", 8),
            Map.entry("parkinglock_locked", 13), Map.entry("parkinglock_unlocked", 14),
            Map.entry("barrier", 15), Map.entry("truck", 16), Map.entry("bus", 17),
            Map.entry("bike", 18), Map.entry("box", 19), Map.entry("handcart", 20),
            Map.entry("speed_bump", 21));

    private final DataInfoDAO dataInfoDAO;
    private final DataAnnotationObjectDAO dataAnnotationObjectDAO;
    private final DatasetClassDAO datasetClassDAO;
    private final DatasetDAO datasetDAO;
    private final FileDAO fileDAO;
    private final SceneLocationDAO sceneLocationDAO;
    private final SceneLocationSampleDAO sceneLocationSampleDAO;
    private final SceneVisibilityRunDAO runDAO;
    private final UserDAO userDAO;
    private final SceneVisibilityWorkerHttpCaller workerCaller;
    private final MinioService minioService;
    private final MinioProp minioProp;
    private final ExecutorService executorService;
    private final String algorithmVersion;

    public SceneVisibilityUseCase(
            DataInfoDAO dataInfoDAO,
            DataAnnotationObjectDAO dataAnnotationObjectDAO,
            DatasetClassDAO datasetClassDAO,
            DatasetDAO datasetDAO,
            FileDAO fileDAO,
            SceneLocationDAO sceneLocationDAO,
            SceneLocationSampleDAO sceneLocationSampleDAO,
            SceneVisibilityRunDAO runDAO,
            UserDAO userDAO,
            SceneVisibilityWorkerHttpCaller workerCaller,
            MinioService minioService,
            MinioProp minioProp,
            ExecutorService executorService,
            String algorithmVersion) {
        this.dataInfoDAO = dataInfoDAO;
        this.dataAnnotationObjectDAO = dataAnnotationObjectDAO;
        this.datasetClassDAO = datasetClassDAO;
        this.datasetDAO = datasetDAO;
        this.fileDAO = fileDAO;
        this.sceneLocationDAO = sceneLocationDAO;
        this.sceneLocationSampleDAO = sceneLocationSampleDAO;
        this.runDAO = runDAO;
        this.userDAO = userDAO;
        this.workerCaller = workerCaller;
        this.minioService = minioService;
        this.minioProp = minioProp;
        this.executorService = executorService;
        if (!hasText(algorithmVersion)) {
            throw new IllegalArgumentException("visibility.algorithm.version must not be blank");
        }
        this.algorithmVersion = algorithmVersion;
    }

    public SceneVisibilityRun ensure(Long datasetId, Long sceneId) {
        return ensure(datasetId, sceneId, null);
    }

    public SceneVisibilityRun ensure(
            Long datasetId,
            Long sceneId,
            List<Long> selectedDataIds) {
        return createRun(datasetId, sceneId, selectedDataIds, false);
    }

    public SceneVisibilityRun force(
            Long datasetId,
            Long sceneId,
            List<Long> selectedDataIds,
            Long userId) {
        requireDatasetAccess(datasetId, userId);
        return createRun(datasetId, sceneId, selectedDataIds, true);
    }

    public SceneVisibilityRun ensureVisibility(
            Long occRunId,
            List<Long> selectedDataIds,
            Long userId) {
        if (occRunId == null) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR, "occRunId is required for a visibility task");
        }
        if (selectedDataIds == null || selectedDataIds.isEmpty()) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "selectedDataIds is required for a visibility task: occRunId=" + occRunId);
        }
        SceneVisibilityRun occRun = status(occRunId);
        requireDatasetAccess(occRun.getDatasetId(), userId);
        if (occRun.getStatus() != SceneVisibilityRunStatusEnum.SUCCEEDED) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "OCC run must be SUCCEEDED before visibility: occRunId=" + occRunId
                            + ", status=" + occRun.getStatus());
        }
        if (occRun.getTaskType() == SceneVisibilityTaskTypeEnum.VISIBILITY) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Visibility task requires an OCC run: occRunId=" + occRunId);
        }
        List<DataInfo> sceneFrames = loadFrames(occRun.getDatasetId(), occRun.getSceneId(), null);
        List<DataInfo> selectedFrames = selectFrames(
                sceneFrames, occRun.getDatasetId(), occRun.getSceneId(), selectedDataIds);
        SceneInput input = buildSceneInput(
                occRun.getDatasetId(),
                occRun.getSceneId(),
                selectedFrames,
                selectedFrames.stream().map(DataInfo::getId).collect(Collectors.toList()));
        OffsetDateTime now = OffsetDateTime.now();
        SceneVisibilityRun run = SceneVisibilityRun.builder()
                .datasetId(occRun.getDatasetId())
                .sceneId(occRun.getSceneId())
                .sourceHash(sourceHash(input))
                .generationToken(UUID.randomUUID().toString())
                .isDefault(false)
                .taskType(SceneVisibilityTaskTypeEnum.VISIBILITY)
                .occRunId(occRunId)
                .algorithmVersion(algorithmVersion)
                .status(input.error == null
                        ? SceneVisibilityRunStatusEnum.QUEUED
                        : SceneVisibilityRunStatusEnum.FAILED)
                .stage(input.error == null
                        ? SceneVisibilityRunStageEnum.QUEUED
                        : SceneVisibilityRunStageEnum.FAILED)
                .progress(0.0)
                .totalFrames(selectedFrames.size())
                .completedFrames(0)
                .error(input.error)
                .createdAt(now)
                .updatedAt(now)
                .build();
        runDAO.save(run);
        if (input.error != null) {
            return run;
        }
        try {
            executorService.execute(Objects.requireNonNull(
                    TtlRunnable.get(() -> executeVisibility(run.getId(), occRun, input))));
        } catch (RuntimeException exception) {
            markFailed(run.getId(), SceneVisibilityRunStatusEnum.QUEUED, exception);
            run.setStatus(SceneVisibilityRunStatusEnum.FAILED);
            run.setError(errorMessage(exception));
        }
        return run;
    }

    public SceneVisibilityRun latestVisibilityTask(Long occRunId, Long userId) {
        SceneVisibilityRun occRun = status(occRunId);
        requireDatasetAccess(occRun.getDatasetId(), userId);
        return runDAO.getOne(Wrappers.lambdaQuery(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getOccRunId, occRunId)
                .eq(SceneVisibilityRun::getTaskType, SceneVisibilityTaskTypeEnum.VISIBILITY)
                .orderByDesc(SceneVisibilityRun::getId)
                .last("limit 1"));
    }

    private SceneVisibilityRun createRun(
            Long datasetId,
            Long sceneId,
            List<Long> selectedDataIds,
            boolean force) {
        validateScene(datasetId, sceneId);
        List<DataInfo> sceneFrames = loadFrames(datasetId, sceneId, null);
        List<DataInfo> selectedFrames = selectFrames(sceneFrames, datasetId, sceneId, selectedDataIds);
        List<DataInfo> contextFrames = fusionContextFrames(sceneFrames, selectedFrames);
        SceneInput input = buildSceneInput(
                datasetId,
                sceneId,
                contextFrames,
                selectedFrames.stream().map(DataInfo::getId).collect(Collectors.toList()));
        String sourceHash = sourceHash(input);
        String generationToken = force ? UUID.randomUUID().toString() : "0";
        if (!force) {
            SceneVisibilityRun existing = findExisting(datasetId, sceneId, sourceHash);
            if (existing != null) {
                if (existing.getStatus() == SceneVisibilityRunStatusEnum.FAILED && input.error == null) {
                    return requeueFailedRun(existing, input);
                }
                return existing;
            }
        }

        OffsetDateTime now = OffsetDateTime.now();
        SceneVisibilityRun run = SceneVisibilityRun.builder()
                .datasetId(datasetId)
                .sceneId(sceneId)
                .sourceHash(sourceHash)
                .generationToken(generationToken)
                .isDefault(!force)
                .taskType(SceneVisibilityTaskTypeEnum.OCC)
                .algorithmVersion(algorithmVersion)
                .status(input.error == null
                        ? SceneVisibilityRunStatusEnum.QUEUED
                        : SceneVisibilityRunStatusEnum.FAILED)
                .stage(input.error == null
                        ? SceneVisibilityRunStageEnum.QUEUED
                        : SceneVisibilityRunStageEnum.FAILED)
                .progress(0.0)
                .totalFrames(selectedFrames.size())
                .completedFrames(0)
                .error(input.error)
                .createdAt(now)
                .updatedAt(now)
                .build();
        try {
            runDAO.save(run);
        } catch (DuplicateKeyException exception) {
            SceneVisibilityRun duplicate = force ? null : findExisting(datasetId, sceneId, sourceHash);
            if (duplicate != null) {
                return duplicate;
            }
            throw exception;
        }
        if (input.error != null) {
            return run;
        }
        try {
            executorService.execute(Objects.requireNonNull(
                    TtlRunnable.get(() -> execute(run.getId(), input))));
        } catch (RuntimeException exception) {
            markFailed(run.getId(), SceneVisibilityRunStatusEnum.QUEUED, exception);
            run.setStatus(SceneVisibilityRunStatusEnum.FAILED);
            run.setError(errorMessage(exception));
        }
        return run;
    }

    public SceneVisibilityRun ensure(
            Long datasetId,
            Long sceneId,
            List<Long> selectedDataIds,
            Long userId) {
        requireDatasetAccess(datasetId, userId);
        return ensure(datasetId, sceneId, selectedDataIds);
    }

    public List<Long> sceneFrameIds(Long datasetId, Long sceneId, Long userId) {
        requireDatasetAccess(datasetId, userId);
        validateScene(datasetId, sceneId);
        return loadFrames(datasetId, sceneId, null).stream()
                .map(DataInfo::getId)
                .collect(Collectors.toList());
    }

    private SceneVisibilityRun requeueFailedRun(SceneVisibilityRun run, SceneInput input) {
        boolean claimed = runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getId, run.getId())
                .eq(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.FAILED)
                .set(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.QUEUED)
                .set(SceneVisibilityRun::getStage, SceneVisibilityRunStageEnum.QUEUED)
                .set(SceneVisibilityRun::getProgress, 0.0)
                .set(SceneVisibilityRun::getCompletedFrames, 0)
                .set(SceneVisibilityRun::getTotalFrames, input.selectedDataIds.size())
                .set(SceneVisibilityRun::getError, null));
        if (!claimed) {
            SceneVisibilityRun current = findExisting(
                    run.getDatasetId(), run.getSceneId(), run.getSourceHash());
            if (current != null) {
                return current;
            }
            throw new IllegalStateException(
                    "Visibility run disappeared while requeueing: runId=" + run.getId());
        }
        run.setStatus(SceneVisibilityRunStatusEnum.QUEUED);
        run.setStage(SceneVisibilityRunStageEnum.QUEUED);
        run.setProgress(0.0);
        run.setCompletedFrames(0);
        run.setTotalFrames(input.selectedDataIds.size());
        run.setError(null);
        try {
            executorService.execute(Objects.requireNonNull(
                    TtlRunnable.get(() -> execute(run.getId(), input))));
        } catch (RuntimeException exception) {
            markFailed(run.getId(), SceneVisibilityRunStatusEnum.QUEUED, exception);
            run.setStatus(SceneVisibilityRunStatusEnum.FAILED);
            run.setError(errorMessage(exception));
        }
        return run;
    }

    public SceneVisibilityRun status(Long runId) {
        SceneVisibilityRun run = runDAO.getById(runId);
        if (run == null) {
            throw new UsecaseException(
                    UsecaseCode.NOT_FOUND,
                    "Visibility run not found: runId=" + runId);
        }
        return run;
    }

    public SceneVisibilityRun status(Long runId, Long userId) {
        SceneVisibilityRun run = status(runId);
        requireDatasetAccess(run.getDatasetId(), userId);
        return run;
    }

    public List<SceneVisibilityRun> listRuns(
            Long datasetId, Long sceneId, Long userId) {
        requireDatasetAccess(datasetId, userId);
        return runDAO.list(Wrappers.lambdaQuery(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getDatasetId, datasetId)
                .eq(SceneVisibilityRun::getSceneId, sceneId)
                .orderByDesc(SceneVisibilityRun::getCreatedAt));
    }

    public SceneVisibilityRun cancel(Long runId, Long userId) {
        SceneVisibilityRun run = status(runId, userId);
        if (run.getStatus() != SceneVisibilityRunStatusEnum.QUEUED
                && run.getStatus() != SceneVisibilityRunStatusEnum.RUNNING) {
            return run;
        }
        runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getId, runId)
                .eq(SceneVisibilityRun::getStatus, run.getStatus())
                .set(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.FAILED)
                .set(SceneVisibilityRun::getStage, SceneVisibilityRunStageEnum.FAILED)
                .set(SceneVisibilityRun::getError, "Cancelled by user")
                .set(SceneVisibilityRun::getIsDefault, false));
        return status(runId);
    }

    public void updateProgress(
            Long runId,
            SceneVisibilityRunStageEnum stage,
            Integer completedFrames) {
        if (stage == null || completedFrames == null || completedFrames < 0) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Visibility progress requires a stage and non-negative completedFrames: runId="
                            + runId + ", stage=" + stage + ", completedFrames=" + completedFrames);
        }
        SceneVisibilityRun run = status(runId);
        if (run.getStatus() != SceneVisibilityRunStatusEnum.RUNNING) {
            return;
        }
        int totalFrames = run.getTotalFrames() == null ? 0 : run.getTotalFrames();
        if (totalFrames <= 0 || completedFrames > totalFrames) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Visibility progress completedFrames is outside run bounds: runId="
                            + runId + ", completedFrames=" + completedFrames
                            + ", totalFrames=" + totalFrames);
        }
        double progress = (completedFrames + stageFraction(stage)) / totalFrames;
        runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getId, runId)
                .eq(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.RUNNING)
                .le(SceneVisibilityRun::getCompletedFrames, completedFrames)
                .set(SceneVisibilityRun::getStage, stage)
                .set(SceneVisibilityRun::getProgress, Math.min(progress, 0.99))
                .set(SceneVisibilityRun::getCompletedFrames, completedFrames));
    }

    private static double stageFraction(SceneVisibilityRunStageEnum stage) {
        switch (stage) {
            case PREPARING:
                return 0.05;
            case OCC_GENERATION:
                return 0.30;
            case LIDAR_VISIBILITY:
                return 0.55;
            case ANNOTATION_VISIBILITY:
                return 0.80;
            case WRITING:
                return 0.95;
            default:
                return 0.0;
        }
    }

    public JSONObject frameResult(Long runId, Long dataId, Long userId) {
        SceneVisibilityRun run = status(runId);
        requireDatasetAccess(run.getDatasetId(), userId);
        return frameResult(runId, dataId);
    }

    public JSONObject occVisualization(Long runId, Long dataId, Integer maxVoxels, Long userId) {
        SceneVisibilityRun run = status(runId);
        requireDatasetAccess(run.getDatasetId(), userId);
        return occVisualization(runId, dataId, maxVoxels);
    }

    public JSONObject occVisualization(
            Long runId, Long dataId, Integer maxVoxels, String layer, Long userId) {
        SceneVisibilityRun run = status(runId);
        requireDatasetAccess(run.getDatasetId(), userId);
        return occVisualization(runId, dataId, maxVoxels, layer);
    }

    public SceneVisibilityRun requireCurrentSucceededRunForDataset(Long runId, Long datasetId) {
        SceneVisibilityRun run = requireSucceededRunForDataset(runId, datasetId);
        List<DataInfo> frames = loadFrames(datasetId, run.getSceneId(), null);
        SceneInput currentInput = buildSceneInput(
                datasetId,
                run.getSceneId(),
                frames,
                frames.stream().map(DataInfo::getId).collect(Collectors.toList()));
        String currentSourceHash = sourceHash(currentInput);
        if (!currentSourceHash.equals(run.getSourceHash())) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Visibility run expired: visibilityRunId=" + runId
                            + ", runSourceHash=" + run.getSourceHash()
                            + ", currentSourceHash=" + currentSourceHash
                            + "; run /annotate/visibility/ensure again before export");
        }
        return run;
    }

    public Long resolveCompleteVisibilityRunForExport(Long datasetId, List<Long> exportedDataIds) {
        if (datasetId == null || exportedDataIds == null || exportedDataIds.isEmpty()) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Auto occlusion export requires datasetId and at least one frame");
        }
        List<DataInfo> exportedFrames = dataInfoDAO.listByIds(exportedDataIds);
        Set<Long> sceneIds = exportedFrames.stream()
                .map(DataInfo::getParentId)
                .filter(Objects::nonNull)
                .filter(sceneId -> sceneId > 0)
                .collect(Collectors.toSet());
        if (sceneIds.size() != 1) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Auto occlusion export requires exactly one complete scene; selectedSceneIds=" + sceneIds);
        }
        Long sceneId = sceneIds.iterator().next();
        List<DataInfo> sceneFrames = loadFrames(datasetId, sceneId, null);
        Set<Long> expectedFrameIds = sceneFrames.stream().map(DataInfo::getId).collect(Collectors.toSet());
        Set<Long> selectedFrameIds = exportedFrames.stream().map(DataInfo::getId).collect(Collectors.toSet());
        if (!expectedFrameIds.equals(selectedFrameIds)) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Auto occlusion export requires all scene frames: sceneId=" + sceneId
                            + ", selectedFrames=" + selectedFrameIds.size()
                            + ", sceneFrames=" + expectedFrameIds.size());
        }
        List<SceneVisibilityRun> runs = runDAO.list(Wrappers.lambdaQuery(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getDatasetId, datasetId)
                .eq(SceneVisibilityRun::getSceneId, sceneId)
                .eq(SceneVisibilityRun::getTaskType, SceneVisibilityTaskTypeEnum.VISIBILITY)
                .eq(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.SUCCEEDED)
                .eq(SceneVisibilityRun::getTotalFrames, expectedFrameIds.size())
                .eq(SceneVisibilityRun::getCompletedFrames, expectedFrameIds.size())
                .orderByDesc(SceneVisibilityRun::getCreatedAt));
        if (runs.isEmpty()) {
            throw new UsecaseException(
                    UsecaseCode.NOT_FOUND,
                    "No complete auto occlusion result found: sceneId=" + sceneId
                            + ", requiredFrames=" + expectedFrameIds.size());
        }
        return requireCurrentSucceededRunForDataset(runs.get(0).getId(), datasetId).getId();
    }

    @Transactional
    public void deleteOccRun(Long occRunId, Long userId) {
        SceneVisibilityRun occRun = status(occRunId, userId);
        if (occRun.getTaskType() != SceneVisibilityTaskTypeEnum.OCC) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR, "Only OCC runs can be deleted: runId=" + occRunId);
        }
        List<SceneVisibilityRun> visibilityRuns = runDAO.list(Wrappers.lambdaQuery(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getOccRunId, occRunId));
        if (isActive(occRun) || visibilityRuns.stream().anyMatch(this::isActive)) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR, "Cannot delete a queued or running OCC task: runId=" + occRunId);
        }
        for (SceneVisibilityRun visibilityRun : visibilityRuns) {
            minioService.removeObjectsByPrefix(minioProp.getBucketName(), outputPrefix(visibilityRun) + "/");
            runDAO.removeById(visibilityRun.getId());
        }
        minioService.removeObjectsByPrefix(minioProp.getBucketName(), outputPrefix(occRun) + "/");
        runDAO.removeById(occRunId);
    }

    private boolean isActive(SceneVisibilityRun run) {
        return run.getStatus() == SceneVisibilityRunStatusEnum.QUEUED
                || run.getStatus() == SceneVisibilityRunStatusEnum.RUNNING;
    }

    public SceneVisibilityRun requireSucceededRunForDataset(Long runId, Long datasetId) {
        if (runId == null || datasetId == null) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "visibilityRunId and datasetId are required: visibilityRunId=" + runId
                            + ", datasetId=" + datasetId);
        }
        SceneVisibilityRun run = status(runId);
        if (!datasetId.equals(run.getDatasetId())) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Visibility run dataset does not match export: visibilityRunId=" + runId
                            + ", runDatasetId=" + run.getDatasetId()
                            + ", exportDatasetId=" + datasetId);
        }
        if (run.getStatus() != SceneVisibilityRunStatusEnum.SUCCEEDED) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Visibility run must be SUCCEEDED for export: visibilityRunId=" + runId
                            + ", status=" + run.getStatus());
        }
        return run;
    }

    public JSONObject frameResult(Long runId, Long dataId) {
        SceneVisibilityRun run = requireSucceededRunFrame(runId, dataId);
        if (run.getTaskType() == SceneVisibilityTaskTypeEnum.OCC) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "OCC run does not contain visibility sidecars: runId=" + runId);
        }
        String objectKey = outputPrefix(run) + "/visibility/" + dataId + ".json";
        String bucketName = minioProp.getBucketName();
        try {
            if (!minioService.objectExists(bucketName, objectKey)) {
                throw new UsecaseException(
                        UsecaseCode.NOT_FOUND,
                        "Visibility sidecar not found: runId=" + runId
                                + ", dataId=" + dataId + ", objectKey=" + objectKey);
            }
            return JSONUtil.parseObj(minioService.readObjectAsString(bucketName, objectKey));
        } catch (UsecaseException exception) {
            throw exception;
        } catch (RuntimeException exception) {
            throw new UsecaseException(
                    UsecaseCode.ERROR,
                    "Failed to read visibility sidecar: runId=" + runId
                            + ", dataId=" + dataId + ", objectKey=" + objectKey
                            + ", error=" + exception.getMessage());
        }
    }

    public JSONObject occVisualization(Long runId, Long dataId, Integer maxVoxels) {
        return occVisualization(runId, dataId, maxVoxels, "semantic");
    }

    public JSONObject occVisualization(Long runId, Long dataId, Integer maxVoxels, String layer) {
        SceneVisibilityRun run = requireSucceededRunFrame(runId, dataId);
        if (maxVoxels != null && maxVoxels <= 0) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "maxVoxels must be greater than zero: maxVoxels=" + maxVoxels);
        }
        if (!List.of("semantic", "lidar-mask", "camera-mask").contains(layer)) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Unsupported OCC visualization layer: layer=" + layer);
        }
        SceneVisibilityRun occRun = run.getTaskType() == SceneVisibilityTaskTypeEnum.VISIBILITY
                ? requireOccRun(run)
                : run;
        String objectKey = outputPrefix(occRun) + "/occ/" + dataId + "/labels.npz";
        return workerCaller.occVisualization(objectKey, maxVoxels, layer);
    }

    private SceneVisibilityRun requireOccRun(SceneVisibilityRun visibilityRun) {
        if (visibilityRun.getOccRunId() == null) {
            throw new UsecaseException(
                    UsecaseCode.ERROR,
                    "Visibility run has no OCC run reference: runId=" + visibilityRun.getId());
        }
        SceneVisibilityRun occRun = status(visibilityRun.getOccRunId());
        if (occRun.getTaskType() == SceneVisibilityTaskTypeEnum.VISIBILITY) {
            throw new UsecaseException(
                    UsecaseCode.ERROR,
                    "Visibility run references another visibility task: runId="
                            + visibilityRun.getId() + ", occRunId=" + occRun.getId());
        }
        return occRun;
    }

    private SceneVisibilityRun requireSucceededRunFrame(Long runId, Long dataId) {
        if (runId == null || dataId == null) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "runId and dataId are required: runId=" + runId + ", dataId=" + dataId);
        }
        SceneVisibilityRun run = status(runId);
        if (run.getStatus() != SceneVisibilityRunStatusEnum.SUCCEEDED) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Visibility run must be SUCCEEDED: runId=" + runId
                            + ", status=" + run.getStatus());
        }
        DataInfo frame = dataInfoDAO.getById(dataId);
        if (frame == null
                || frame.getType() != ItemTypeEnum.SINGLE_DATA
                || !run.getDatasetId().equals(frame.getDatasetId())
                || !run.getSceneId().equals(frame.getParentId())
                || Boolean.TRUE.equals(frame.getIsDeleted())) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "dataId does not belong to visibility run scene: runId=" + runId
                            + ", datasetId=" + run.getDatasetId()
                            + ", sceneId=" + run.getSceneId()
                            + ", dataId=" + dataId);
        }
        return run;
    }

    private static String outputPrefix(SceneVisibilityRun run) {
        return "visibility/" + run.getDatasetId() + "/"
                + run.getSceneId() + "/" + run.getId();
    }

    private void validateScene(Long datasetId, Long sceneId) {
        if (datasetId == null || sceneId == null) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "datasetId and sceneId are required: datasetId=" + datasetId + ", sceneId=" + sceneId);
        }
        Dataset dataset = datasetDAO.getById(datasetId);
        if (dataset == null
                || Boolean.TRUE.equals(dataset.getIsDeleted())
                || dataset.getType() != DatasetTypeEnum.LIDAR_FUSION) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Visibility requires an active LIDAR_FUSION dataset: datasetId=" + datasetId);
        }
        DataInfo scene = dataInfoDAO.getById(sceneId);
        if (scene == null
                || scene.getType() != ItemTypeEnum.SCENE
                || !datasetId.equals(scene.getDatasetId())
                || Boolean.TRUE.equals(scene.getIsDeleted())) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Scene is invalid: datasetId=" + datasetId + ", sceneId=" + sceneId);
        }
    }

    private void requireDatasetAccess(Long datasetId, Long userId) {
        Dataset dataset = datasetDAO.getById(datasetId);
        User user = userDAO.getById(userId);
        if (dataset == null || Boolean.TRUE.equals(dataset.getIsDeleted()) || user == null) {
            throw new UsecaseException(
                    UsecaseCode.NOT_FOUND,
                    "Dataset or user not found: datasetId=" + datasetId + ", userId=" + userId);
        }
        if (userId.equals(dataset.getCreatedBy()) || UserRoleEnum.ADMIN.equals(user.getRole())) {
            return;
        }
        throw new UsecaseException(
                UsecaseCode.PARAM_ERROR,
                "User is not authorized for dataset: datasetId=" + datasetId + ", userId=" + userId);
    }

    private List<DataInfo> loadFrames(
            Long datasetId,
            Long sceneId,
            List<Long> selectedDataIds) {
        List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getDatasetId, datasetId)
                .eq(DataInfo::getParentId, sceneId)
                .eq(DataInfo::getType, ItemTypeEnum.SINGLE_DATA)
                .eq(DataInfo::getIsDeleted, false)
                .orderByAsc(DataInfo::getOrderName)
                .orderByAsc(DataInfo::getId));
        if (frames.isEmpty()) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Scene has no frames: datasetId=" + datasetId + ", sceneId=" + sceneId);
        }
        return selectedDataIds == null
                ? frames
                : selectFrames(frames, datasetId, sceneId, selectedDataIds);
    }

    private List<DataInfo> selectFrames(
            List<DataInfo> frames,
            Long datasetId,
            Long sceneId,
            List<Long> selectedDataIds) {
        if (selectedDataIds == null) {
            return frames;
        }
        if (selectedDataIds.isEmpty()
                || selectedDataIds.stream().anyMatch(dataId -> dataId == null || dataId <= 0)) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "selectedDataIds must contain positive data IDs: selectedDataIds=" + selectedDataIds);
        }
        Set<Long> requestedIds = new LinkedHashSet<>(selectedDataIds);
        List<DataInfo> selectedFrames = frames.stream()
                .filter(frame -> requestedIds.contains(frame.getId()))
                .collect(Collectors.toList());
        if (selectedFrames.size() != requestedIds.size()) {
            Set<Long> foundIds = selectedFrames.stream()
                    .map(DataInfo::getId)
                    .collect(Collectors.toSet());
            Set<Long> invalidIds = new LinkedHashSet<>(requestedIds);
            invalidIds.removeAll(foundIds);
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Selected frame does not belong to scene: datasetId=" + datasetId
                            + ", sceneId=" + sceneId + ", selectedDataIds=" + invalidIds);
        }
        return selectedFrames;
    }

    private static List<DataInfo> fusionContextFrames(
            List<DataInfo> sceneFrames,
            List<DataInfo> selectedFrames) {
        Set<Long> selectedIds = selectedFrames.stream()
                .map(DataInfo::getId)
                .collect(Collectors.toSet());
        Set<Long> contextIds = new LinkedHashSet<>();
        for (int index = 0; index < sceneFrames.size(); index++) {
            if (!selectedIds.contains(sceneFrames.get(index).getId())) {
                continue;
            }
            int first = Math.max(0, index - OCC_FUSION_WINDOW);
            int last = Math.min(sceneFrames.size() - 1, index + OCC_FUSION_WINDOW);
            for (int neighbor = first; neighbor <= last; neighbor++) {
                contextIds.add(sceneFrames.get(neighbor).getId());
            }
        }
        return sceneFrames.stream()
                .filter(frame -> contextIds.contains(frame.getId()))
                .collect(Collectors.toList());
    }

    private SceneInput buildSceneInput(
            Long datasetId,
            Long sceneId,
            List<DataInfo> frames,
            List<Long> selectedDataIds) {
        Set<Long> fileIds = new LinkedHashSet<>();
        for (DataInfo frame : frames) {
            collectFileIds(frame.getContent(), fileIds);
        }
        Map<Long, File> filesById = fileIds.isEmpty()
                ? Map.of()
                : fileDAO.listByIds(new ArrayList<>(fileIds)).stream()
                        .collect(Collectors.toMap(File::getId, file -> file, (first, ignored) -> first));
        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        List<AnnotationInput> annotations = dataAnnotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .eq(DataAnnotationObject::getDatasetId, datasetId)
                                .in(DataAnnotationObject::getDataId, frameIds)
                                .and(query -> query
                                        .eq(DataAnnotationObject::getSourceType,
                                                DataAnnotationObjectSourceTypeEnum.DATA_FLOW)
                                        .or()
                                        .isNull(DataAnnotationObject::getSourceType)))
                .stream()
                .map(AnnotationInput::new)
                .sorted(AnnotationInput.COMPARATOR)
                .collect(Collectors.toList());
        Map<Long, SceneLocation> locationsByDataId =
                sceneLocationDAO.list(Wrappers.lambdaQuery(SceneLocation.class)
                                .in(SceneLocation::getDataId, frameIds))
                        .stream()
                        .collect(Collectors.toMap(
                                SceneLocation::getDataId,
                                location -> location,
                                (first, ignored) -> first));
        fillLocationsFromSamples(sceneId, frames, locationsByDataId);

        List<FrameInput> frameInputs = new ArrayList<>(frames.size());
        List<String> errors = new ArrayList<>();
        Set<String> cameraConfigKeys = new LinkedHashSet<>();
        Map<String, List<FileInput>> cameraConfigsByPointCloudDirectory = new LinkedHashMap<>();
        for (DataInfo frame : frames) {
            List<FileInput> frameFiles = new ArrayList<>();
            collectFiles(frame.getContent(), "", filesById, frameFiles);
            List<FileInput> pointCloudFiles = frameFiles.stream()
                    .filter(SceneVisibilityUseCase::isPointCloud)
                    .filter(file -> hasText(file.file.getPath()))
                    .distinct()
                    .sorted(Comparator.comparing(file -> file.file.getPath()))
                    .collect(Collectors.toList());
            List<FileInput> frameCameraConfigFiles = frameFiles.stream()
                    .filter(SceneVisibilityUseCase::isCameraConfig)
                    .filter(file -> hasText(file.file.getPath()))
                    .distinct()
                    .sorted(Comparator.comparing(file -> file.file.getPath()))
                    .collect(Collectors.toList());
            if (frameCameraConfigFiles.isEmpty() && pointCloudFiles.size() == 1) {
                String pointCloudDirectory = pointCloudDirectory(pointCloudFiles.get(0).file.getPath());
                if (pointCloudDirectory != null) {
                    frameCameraConfigFiles = cameraConfigsByPointCloudDirectory.computeIfAbsent(
                            pointCloudDirectory,
                            this::loadSceneCameraConfigFiles);
                }
            }
            if (pointCloudFiles.size() != 1) {
                errors.add("Frame must contain exactly one point cloud File.path: dataId="
                        + frame.getId() + ", found=" + pointCloudFiles.size());
            }
            if (frameCameraConfigFiles.size() != 1) {
                errors.add("Frame must contain exactly one camera config File.path: dataId="
                        + frame.getId() + ", found=" + frameCameraConfigFiles.size());
            } else {
                cameraConfigKeys.add(frameCameraConfigFiles.get(0).file.getPath());
            }
            SceneLocation location = locationsByDataId.get(frame.getId());
            if (!hasCompletePose(location)) {
                errors.add("Frame SceneLocation is missing or incomplete: dataId=" + frame.getId());
            }
            frameInputs.add(new FrameInput(
                    frame,
                    pointCloudFiles.size() == 1 ? pointCloudFiles.get(0) : null,
                    frameCameraConfigFiles.size() == 1 ? frameCameraConfigFiles.get(0) : null,
                    location));
        }
        if (cameraConfigKeys.size() > 1) {
            errors.add("Scene frames reference different camera config File.path values: datasetId="
                    + datasetId + ", sceneId=" + sceneId + ", paths=" + cameraConfigKeys);
        }
        String cameraConfigKey = cameraConfigKeys.size() == 1
                ? cameraConfigKeys.iterator().next()
                : null;
        String error = errors.isEmpty() ? null : String.join("; ", errors);
        return new SceneInput(
                frameInputs,
                annotations,
                selectedDataIds,
                cameraConfigKey,
                truncate(error));
    }

    private void fillLocationsFromSamples(
            Long sceneId,
            List<DataInfo> frames,
            Map<Long, SceneLocation> locationsByDataId) {
        List<DataInfo> missingFrames = frames.stream()
                .filter(frame -> !hasCompletePose(locationsByDataId.get(frame.getId())))
                .collect(Collectors.toList());
        if (missingFrames.isEmpty()) {
            return;
        }
        List<SceneLocationSample> samples = sceneLocationSampleDAO.list(
                Wrappers.lambdaQuery(SceneLocationSample.class)
                        .eq(SceneLocationSample::getSceneId, sceneId)
                        .orderByAsc(SceneLocationSample::getTimestampNs));
        List<LocationPoseInterpolator.TimestampedPoseSample> sortedSamples =
                LocationPoseInterpolator.toSortedSamples(samples);
        for (DataInfo frame : missingFrames) {
            Long timestampNs = SceneLocationImportService.parseTimestampNs(frame.getName());
            if (timestampNs == null) {
                continue;
            }
            double[] pose = LocationPoseInterpolator.interpolatePose(timestampNs, sortedSamples);
            if (pose == null) {
                continue;
            }
            locationsByDataId.put(frame.getId(), SceneLocation.builder()
                    .dataId(frame.getId())
                    .posX(pose[0])
                    .posY(pose[1])
                    .posZ(pose[2])
                    .yaw(pose[3])
                    .roll(Double.isNaN(pose[4]) ? null : pose[4])
                    .pitch(Double.isNaN(pose[5]) ? null : pose[5])
                    .build());
        }
    }

    private List<FileInput> loadSceneCameraConfigFiles(String pointCloudDirectory) {
        String cameraConfigDirectory = pointCloudDirectory + "/camera_config/";
        return fileDAO.list(Wrappers.lambdaQuery(File.class)
                        .likeRight(File::getPath, cameraConfigDirectory))
                .stream()
                .map(file -> new FileInput(file, "camera_config/" + file.getName()))
                .filter(SceneVisibilityUseCase::isCameraConfig)
                .filter(file -> hasText(file.file.getPath()))
                .distinct()
                .sorted(Comparator.comparing(file -> file.file.getPath()))
                .collect(Collectors.toList());
    }

    private static String pointCloudDirectory(String pointCloudPath) {
        String path = pointCloudPath == null ? null : pointCloudPath.replace('\\', '/');
        if (!hasText(path)) {
            return null;
        }
        int markerIndex = path.toLowerCase(Locale.ROOT).lastIndexOf("/lidar_point_cloud/");
        if (markerIndex <= 0) {
            return null;
        }
        return path.substring(0, markerIndex);
    }

    private void execute(Long runId, SceneInput input) {
        SceneVisibilityRun run = runDAO.getById(runId);
        if (run == null) {
            return;
        }
        try {
            boolean claimed = runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                    .eq(SceneVisibilityRun::getId, runId)
                    .eq(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.QUEUED)
                    .set(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.RUNNING)
                    .set(SceneVisibilityRun::getStage, SceneVisibilityRunStageEnum.PREPARING)
                    .set(SceneVisibilityRun::getProgress, 0.0)
                    .set(SceneVisibilityRun::getError, null));
            if (!claimed) {
                return;
            }
            SceneVisibilityManifestDTO.Manifest manifest = buildManifest(run, input);
            SceneVisibilityManifestDTO.Response response = workerCaller.submit(manifest);
            if (!Integer.valueOf(input.selectedDataIds.size()).equals(response.getFrameCount())) {
                throw new UsecaseException("Visibility worker frame count mismatch: runId=" + runId
                        + ", expected=" + input.selectedDataIds.size()
                        + ", actual=" + response.getFrameCount()
                        + ", manifestObjectKey=" + response.getManifestObjectKey());
            }
            runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                    .eq(SceneVisibilityRun::getId, runId)
                    .eq(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.RUNNING)
                    .set(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.SUCCEEDED)
                    .set(SceneVisibilityRun::getStage, SceneVisibilityRunStageEnum.COMPLETED)
                    .set(SceneVisibilityRun::getProgress, 1.0)
                    .set(SceneVisibilityRun::getCompletedFrames, input.selectedDataIds.size())
                    .set(SceneVisibilityRun::getTimingsMs, timingsMs(response))
                    .set(SceneVisibilityRun::getError, null));
            promoteDefault(run);
        } catch (Throwable throwable) {
            log.error("Visibility run failed: runId={}, datasetId={}, sceneId={}",
                    runId, run.getDatasetId(), run.getSceneId(), throwable);
            markFailed(runId, SceneVisibilityRunStatusEnum.RUNNING, throwable);
        }
    }

    private void executeVisibility(
            Long runId,
            SceneVisibilityRun occRun,
            SceneInput input) {
        SceneVisibilityRun run = runDAO.getById(runId);
        if (run == null) {
            return;
        }
        try {
            boolean claimed = runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                    .eq(SceneVisibilityRun::getId, runId)
                    .eq(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.QUEUED)
                    .set(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.RUNNING)
                    .set(SceneVisibilityRun::getStage, SceneVisibilityRunStageEnum.PREPARING)
                    .set(SceneVisibilityRun::getProgress, 0.0)
                    .set(SceneVisibilityRun::getError, null));
            if (!claimed) {
                return;
            }
            SceneVisibilityManifestDTO.Response response =
                    workerCaller.submit(buildVisibilityManifest(run, occRun, input));
            if (!Integer.valueOf(input.selectedDataIds.size()).equals(response.getFrameCount())) {
                throw new UsecaseException("Visibility worker frame count mismatch: runId=" + runId
                        + ", expected=" + input.selectedDataIds.size()
                        + ", actual=" + response.getFrameCount()
                        + ", manifestObjectKey=" + response.getManifestObjectKey());
            }
            runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                    .eq(SceneVisibilityRun::getId, runId)
                    .eq(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.RUNNING)
                    .set(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.SUCCEEDED)
                    .set(SceneVisibilityRun::getStage, SceneVisibilityRunStageEnum.COMPLETED)
                    .set(SceneVisibilityRun::getProgress, 1.0)
                    .set(SceneVisibilityRun::getCompletedFrames, input.selectedDataIds.size())
                    .set(SceneVisibilityRun::getTimingsMs, timingsMs(response))
                    .set(SceneVisibilityRun::getError, null));
        } catch (Throwable throwable) {
            log.error("Visibility task failed: runId={}, occRunId={}, datasetId={}, sceneId={}",
                    runId, occRun.getId(), run.getDatasetId(), run.getSceneId(), throwable);
            markFailed(runId, SceneVisibilityRunStatusEnum.RUNNING, throwable);
        }
    }

    private static String timingsMs(SceneVisibilityManifestDTO.Response response) {
        if (response.getTimingsMs() == null) {
            return null;
        }
        return JSONUtil.toJsonStr(response.getTimingsMs());
    }

    private void promoteDefault(SceneVisibilityRun run) {
        if (Boolean.TRUE.equals(run.getIsDefault())) {
            return;
        }
        boolean promoted = runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getId, run.getId())
                .eq(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.SUCCEEDED)
                .set(SceneVisibilityRun::getIsDefault, true));
        if (!promoted) {
            return;
        }
        runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getDatasetId, run.getDatasetId())
                .eq(SceneVisibilityRun::getSceneId, run.getSceneId())
                .eq(SceneVisibilityRun::getSourceHash, run.getSourceHash())
                .eq(SceneVisibilityRun::getAlgorithmVersion, run.getAlgorithmVersion())
                .ne(SceneVisibilityRun::getId, run.getId())
                .eq(SceneVisibilityRun::getIsDefault, true)
                .set(SceneVisibilityRun::getIsDefault, false));
    }

    private SceneVisibilityManifestDTO.Manifest buildManifest(
            SceneVisibilityRun run,
            SceneInput input) {
        Map<String, Integer> classMap = workerClassMap(run.getDatasetId(), input.annotations);
        List<SceneVisibilityManifestDTO.Frame> frames = input.frames.stream()
                .map(frame -> SceneVisibilityManifestDTO.Frame.builder()
                        .dataId(String.valueOf(frame.frame.getId()))
                        .token(String.valueOf(frame.frame.getId()))
                        .pointCloudObjectKey(frame.pointCloudObjectKey)
                        .pose(toPose(frame.location))
                        .build())
                .collect(Collectors.toList());
        List<SceneVisibilityManifestDTO.Annotation> annotations = input.annotations.stream()
                .map(annotation -> SceneVisibilityManifestDTO.Annotation.builder()
                        .dataId(annotation.dataId)
                        .objectId(annotation.objectId)
                        .classId(annotation.classId)
                        .classAttributes(annotation.classAttributes)
                        .build())
                .collect(Collectors.toList());
        return SceneVisibilityManifestDTO.Manifest.builder()
                .schemaVersion(SCHEMA_VERSION)
                .taskType(SceneVisibilityTaskTypeEnum.OCC.name())
                .runId(run.getId())
                .datasetId(run.getDatasetId())
                .sceneId(run.getSceneId())
                .source(SceneVisibilityManifestDTO.Source.builder()
                        .hash(run.getSourceHash())
                        .build())
                .algorithm(SceneVisibilityManifestDTO.Algorithm.builder()
                        .version(run.getAlgorithmVersion())
                        .classMapVersion(OCC_CLASS_MAP_VERSION)
                        .occVisibility(true)
                        .freeId(0)
                        .generalObjectId(1)
                        .unknownId(255)
                        .lidarOrigin(List.of(0.0, 0.0, 0.0))
                        .classMap(classMap)
                        .groundClassIds(List.of(OCC_CLASS_IDS.get("ground")))
                        .dropEgoBody(true)
                        .boxPaintMargin(0.05)
                        .polylineSurfaceThickness(0.3)
                        .minPointsPerVoxel(4)
                        .voxelCleanupMinNeighbors(1)
                        .build())
                .frames(frames)
                .selectedDataIds(input.selectedDataIds)
                .annotations(annotations)
                .cameraConfigObjectKey(input.cameraConfigObjectKey)
                .outputPrefix(outputPrefix(run))
                .build();
    }

    private SceneVisibilityManifestDTO.Manifest buildVisibilityManifest(
            SceneVisibilityRun run,
            SceneVisibilityRun occRun,
            SceneInput input) {
        SceneVisibilityManifestDTO.Manifest manifest = buildManifest(run, input);
        manifest.setTaskType(SceneVisibilityTaskTypeEnum.VISIBILITY.name());
        manifest.setOccOutputPrefix(outputPrefix(occRun));
        return manifest;
    }

    private Map<String, Integer> workerClassMap(
            Long datasetId,
            List<AnnotationInput> annotations) {
        Set<Long> classIds = annotations.stream()
                .filter(SceneVisibilityUseCase::requiresSemanticMapping)
                .map(annotation -> annotation.classId)
                .filter(Objects::nonNull)
                .collect(Collectors.toCollection(LinkedHashSet::new));
        if (classIds.isEmpty()) {
            return Map.of();
        }
        Map<Long, String> namesById = datasetClassDAO.list(
                        Wrappers.<DatasetClass>lambdaQuery()
                                .eq(DatasetClass::getDatasetId, datasetId)
                                .in(DatasetClass::getId, classIds))
                .stream()
                .collect(Collectors.toMap(DatasetClass::getId, DatasetClass::getName));
        Map<String, Integer> result = new TreeMap<>();
        for (Long classId : classIds) {
            String className = namesById.get(classId);
            Integer semanticId = OCC_CLASS_IDS.get(normalizeOccClassName(className));
            if (semanticId == null) {
                throw new UsecaseException(
                        "visibility algorithm " + OCC_CLASS_MAP_VERSION
                                + " has no semantic mapping for dataset classId=" + classId
                                + " name=" + className
                                + "; configure a worker-compatible class mapping");
            }
            result.put(String.valueOf(classId), semanticId);
        }
        return result;
    }

    private static boolean requiresSemanticMapping(AnnotationInput annotation) {
        if (annotation.classAttributes == null) {
            return false;
        }
        String type = annotation.classAttributes.getStr("type");
        return "3D_BOX".equals(type)
                || "GROUND_POLYLINE".equals(type)
                || "IRREGULAR_WALL".equals(type);
    }

    private static String normalizeOccClassName(String className) {
        if (!hasText(className)) {
            return "";
        }
        return className.trim().toLowerCase(Locale.ROOT)
                .replace(' ', '_')
                .replace('-', '_');
    }

    private SceneVisibilityRun findExisting(Long datasetId, Long sceneId, String sourceHash) {
        return runDAO.getOne(Wrappers.lambdaQuery(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getDatasetId, datasetId)
                .eq(SceneVisibilityRun::getSceneId, sceneId)
                .eq(SceneVisibilityRun::getSourceHash, sourceHash)
                .eq(SceneVisibilityRun::getAlgorithmVersion, algorithmVersion)
                .orderByDesc(SceneVisibilityRun::getCompletedFrames)
                .orderByDesc(SceneVisibilityRun::getId)
                .last("limit 1"));
    }

    private static String sourceHash(SceneInput input) {
        List<Map<String, Object>> canonicalFrames = input.frames.stream()
                .sorted(Comparator.comparing(frame -> frame.frame.getId()))
                .map(frame -> {
                    Map<String, Object> canonical = new LinkedHashMap<>();
                    canonical.put("dataId", frame.frame.getId());
                    canonical.put("orderName", frame.frame.getOrderName());
                    canonical.put("pointCloudObjectKey", frame.pointCloudObjectKey);
                    canonical.put("cameraConfigObjectKey", frame.cameraConfigObjectKey);
                    canonical.put("pointCloudFile", canonicalFile(frame.pointCloudFile));
                    canonical.put("cameraConfigFile", canonicalFile(frame.cameraConfigFile));
                    canonical.put("pose", canonicalPose(frame.location));
                    return canonical;
                })
                .collect(Collectors.toList());
        Map<String, Object> source = new LinkedHashMap<>();
        source.put("frames", canonicalFrames);
        source.put("annotations", input.annotations.stream()
                .map(annotation -> {
                    Map<String, Object> canonical = new LinkedHashMap<>();
                    canonical.put("dataId", annotation.dataId);
                    canonical.put("objectId", annotation.objectId);
                    canonical.put("classId", annotation.classId);
                    canonical.put("classAttributes", annotation.canonicalClassAttributes);
                    return canonical;
                })
                .collect(Collectors.toList()));
        source.put("cameraConfigObjectKey", input.cameraConfigObjectKey);
        return sha256(JSONUtil.toJsonStr(source));
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(digest.length * 2);
            for (byte digestByte : digest) {
                result.append(String.format("%02x", digestByte & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private static Map<String, Object> canonicalPose(SceneLocation location) {
        if (location == null) {
            return Map.of();
        }
        Map<String, Object> pose = new LinkedHashMap<>();
        pose.put("x", location.getPosX());
        pose.put("y", location.getPosY());
        pose.put("z", location.getPosZ());
        pose.put("yaw", location.getYaw());
        pose.put("roll", location.getRoll());
        pose.put("pitch", location.getPitch());
        return pose;
    }

    private static Map<String, Object> canonicalFile(FileInput input) {
        if (input == null || input.file == null) {
            return Map.of();
        }
        File file = input.file;
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("id", file.getId());
        canonical.put("path", file.getPath());
        canonical.put("pathHash", file.getPathHash());
        canonical.put("size", file.getSize());
        canonical.put("updatedAt", file.getUpdatedAt());
        canonical.put("extraInfo", canonicalJsonValue(file.getExtraInfo()));
        return canonical;
    }

    private static Object canonicalJsonValue(Object value) {
        if (value instanceof Map<?, ?>) {
            Map<String, Object> canonical = new TreeMap<>();
            ((Map<?, ?>) value).forEach((key, child) ->
                    canonical.put(String.valueOf(key), canonicalJsonValue(child)));
            return canonical;
        }
        if (value instanceof Collection<?>) {
            return ((Collection<?>) value).stream()
                    .map(SceneVisibilityUseCase::canonicalJsonValue)
                    .collect(Collectors.toList());
        }
        return value;
    }

    private static SceneVisibilityManifestDTO.Pose toPose(SceneLocation location) {
        return SceneVisibilityManifestDTO.Pose.builder()
                .x(location.getPosX())
                .y(location.getPosY())
                .z(location.getPosZ())
                .yaw(location.getYaw())
                .roll(location.getRoll())
                .pitch(location.getPitch())
                .build();
    }

    private static void collectFileIds(
            Collection<?> nodes,
            Set<Long> fileIds) {
        if (nodes == null) {
            return;
        }
        for (DataInfo.FileNode node : normalizeFileNodes(nodes, "data.content")) {
            if (node.getFileId() != null) {
                fileIds.add(node.getFileId());
            }
            collectFileIds(node.getFiles(), fileIds);
        }
    }

    private static void collectFiles(
            Collection<?> nodes,
            String parentPath,
            Map<Long, File> filesById,
            List<FileInput> files) {
        if (nodes == null) {
            return;
        }
        for (DataInfo.FileNode node : normalizeFileNodes(nodes, "data.content")) {
            String nodePath = parentPath.isEmpty()
                    ? Objects.toString(node.getName(), "")
                    : parentPath + "/" + Objects.toString(node.getName(), "");
            File file = node.getFileId() == null ? null : filesById.get(node.getFileId());
            if (file != null) {
                files.add(new FileInput(file, nodePath));
            }
            collectFiles(node.getFiles(), nodePath, filesById, files);
        }
    }

    private static List<DataInfo.FileNode> normalizeFileNodes(
            Collection<?> nodes,
            String input) {
        if (nodes == null) {
            return List.of();
        }
        List<DataInfo.FileNode> normalizedNodes = new ArrayList<>();
        int index = 0;
        for (Object node : nodes) {
            if (node != null) {
                normalizedNodes.add(normalizeFileNode(node, input + "[" + index + "]"));
            }
            index++;
        }
        return normalizedNodes;
    }

    private static DataInfo.FileNode normalizeFileNode(Object node, String input) {
        if (node instanceof DataInfo.FileNode) {
            DataInfo.FileNode fileNode = (DataInfo.FileNode) node;
            return DataInfo.FileNode.builder()
                    .name(fileNode.getName())
                    .fileId(fileNode.getFileId())
                    .type(fileNode.getType())
                    .files(normalizeFileNodes(fileNode.getFiles(), input + ".files"))
                    .build();
        }
        if (!(node instanceof Map<?, ?>)) {
            throw invalidContent(input, "must be a FileNode or Map",
                    node.getClass().getName());
        }
        Map<?, ?> nodeMap = (Map<?, ?>) node;
        Object nestedFiles = nodeMap.get("files");
        if (nestedFiles != null && !(nestedFiles instanceof Collection<?>)) {
            throw invalidContent(input + ".files", "must be a collection",
                    nestedFiles.getClass().getName());
        }
        return DataInfo.FileNode.builder()
                .name(readString(nodeMap.get("name"), input + ".name"))
                .fileId(readFileId(nodeMap.get("fileId"), input + ".fileId"))
                .type(readString(nodeMap.get("type"), input + ".type"))
                .files(normalizeFileNodes((Collection<?>) nestedFiles, input + ".files"))
                .build();
    }

    private static String readString(Object value, String input) {
        if (value == null || value instanceof String) {
            return (String) value;
        }
        throw invalidContent(input, "must be a string", value.getClass().getName());
    }

    private static Long readFileId(Object value, String input) {
        if (value == null) {
            return null;
        }
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        if (value instanceof String) {
            try {
                return Long.valueOf((String) value);
            } catch (NumberFormatException exception) {
                throw new UsecaseException(
                        UsecaseCode.PARAM_ERROR,
                        "Invalid data content: input=" + input
                                + " must be a numeric file ID; value=" + value);
            }
        }
        throw invalidContent(input, "must be a numeric value or string",
                value.getClass().getName());
    }

    private static UsecaseException invalidContent(
            String input,
            String expected,
            String actual) {
        return new UsecaseException(
                UsecaseCode.PARAM_ERROR,
                "Invalid data content: input=" + input
                        + " " + expected + "; actual=" + actual);
    }

    private static boolean isPointCloud(FileInput input) {
        return hasText(input.file.getPath())
                && input.file.getPath().toLowerCase(Locale.ROOT).endsWith(".pcd");
    }

    private static boolean isCameraConfig(FileInput input) {
        String objectPath = normalizedPath(input.file.getPath());
        String nodePath = normalizedPath(input.nodePath);
        return objectPath.contains("/camera_config/")
                || objectPath.startsWith("camera_config/")
                || nodePath.contains("/camera_config/")
                || nodePath.startsWith("camera_config/");
    }

    private static String normalizedPath(String path) {
        return path == null ? "" : path.replace('\\', '/').toLowerCase(Locale.ROOT);
    }

    private static boolean hasCompletePose(SceneLocation location) {
        return location != null
                && location.getPosX() != null
                && location.getPosY() != null
                && location.getPosZ() != null
                && location.getYaw() != null;
    }

    private static boolean hasText(String value) {
        return value != null && !value.isBlank();
    }

    private void markFailed(
            Long runId,
            SceneVisibilityRunStatusEnum expectedStatus,
            Throwable throwable) {
        if (runId == null) {
            return;
        }
        runDAO.update(Wrappers.lambdaUpdate(SceneVisibilityRun.class)
                .eq(SceneVisibilityRun::getId, runId)
                .eq(SceneVisibilityRun::getStatus, expectedStatus)
                .set(SceneVisibilityRun::getStatus, SceneVisibilityRunStatusEnum.FAILED)
                .set(SceneVisibilityRun::getStage, SceneVisibilityRunStageEnum.FAILED)
                .set(SceneVisibilityRun::getError, errorMessage(throwable)));
    }

    private static String errorMessage(Throwable throwable) {
        return truncate(throwable.getClass().getSimpleName() + ": " + throwable.getMessage());
    }

    private static String truncate(String value) {
        if (value == null || value.length() <= MAX_ERROR_LENGTH) {
            return value;
        }
        return value.substring(0, MAX_ERROR_LENGTH);
    }

    private static final class FileInput {
        private final File file;
        private final String nodePath;

        private FileInput(File file, String nodePath) {
            this.file = file;
            this.nodePath = nodePath;
        }
    }

    private static final class FrameInput {
        private final DataInfo frame;
        private final String pointCloudObjectKey;
        private final String cameraConfigObjectKey;
        private final FileInput pointCloudFile;
        private final FileInput cameraConfigFile;
        private final SceneLocation location;

        private FrameInput(
                DataInfo frame,
                FileInput pointCloudFile,
                FileInput cameraConfigFile,
                SceneLocation location) {
            this.frame = frame;
            this.pointCloudFile = pointCloudFile;
            this.cameraConfigFile = cameraConfigFile;
            this.pointCloudObjectKey = pointCloudFile == null ? null : pointCloudFile.file.getPath();
            this.cameraConfigObjectKey = cameraConfigFile == null ? null : cameraConfigFile.file.getPath();
            this.location = location;
        }
    }

    private static final class AnnotationInput {
        private static final Comparator<AnnotationInput> COMPARATOR = Comparator
                .comparing((AnnotationInput annotation) -> annotation.dataId,
                        Comparator.nullsFirst(Comparator.naturalOrder()))
                .thenComparing(annotation -> annotation.objectId,
                        Comparator.nullsFirst(Comparator.naturalOrder()))
                .thenComparing(annotation -> annotation.classId,
                        Comparator.nullsFirst(Comparator.naturalOrder()))
                .thenComparing(annotation -> annotation.canonicalJson);

        private final Long dataId;
        private final Long objectId;
        private final Long classId;
        private final Object canonicalClassAttributes;
        private final String canonicalJson;
        private final JSONObject classAttributes;

        private AnnotationInput(DataAnnotationObject annotation) {
            this.dataId = annotation.getDataId();
            this.objectId = annotation.getId();
            this.classId = annotation.getClassId();
            this.canonicalClassAttributes = canonicalJsonValue(annotation.getClassAttributes());
            this.canonicalJson = JSONUtil.toJsonStr(canonicalClassAttributes);
            this.classAttributes = annotation.getClassAttributes() == null
                    ? null
                    : JSONUtil.parseObj(canonicalJson);
        }
    }

    private static final class SceneInput {
        private final List<FrameInput> frames;
        private final List<AnnotationInput> annotations;
        private final List<Long> selectedDataIds;
        private final String cameraConfigObjectKey;
        private final String error;

        private SceneInput(
                List<FrameInput> frames,
                List<AnnotationInput> annotations,
                List<Long> selectedDataIds,
                String cameraConfigObjectKey,
                String error) {
            this.frames = frames;
            this.annotations = annotations;
            this.selectedDataIds = selectedDataIds;
            this.cameraConfigObjectKey = cameraConfigObjectKey;
            this.error = error;
        }
    }
}
