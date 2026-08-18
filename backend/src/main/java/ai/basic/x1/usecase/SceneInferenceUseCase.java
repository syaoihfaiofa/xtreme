package ai.basic.x1.usecase;

import ai.basic.x1.adapter.api.job.converter.PointCloudDetectionModelReqConverter;
import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.dao.DataAnnotationRecordDAO;
import ai.basic.x1.adapter.port.dao.DataEditDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.DatasetDAO;
import ai.basic.x1.adapter.port.dao.ModelDAO;
import ai.basic.x1.adapter.port.dao.SceneInferenceRunDAO;
import ai.basic.x1.adapter.port.dao.SceneLocationDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationRecord;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataEdit;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.Dataset;
import ai.basic.x1.adapter.port.dao.mybatis.model.Model;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneInferenceRun;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocation;
import ai.basic.x1.adapter.port.rpc.PointCloudDetectionModelHttpCaller;
import ai.basic.x1.adapter.port.rpc.SceneInferenceTrackingHttpCaller;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudDetectionObject;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudDetectionRespDTO;
import ai.basic.x1.adapter.port.rpc.dto.SceneInferenceTrackingDTO;
import ai.basic.x1.entity.DatasetInferenceConfig;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.enums.DatasetTypeEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import ai.basic.x1.entity.enums.ModelCodeEnum;
import ai.basic.x1.entity.enums.SceneInferenceRunStatusEnum;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.json.JSONUtil;
import com.alibaba.ttl.TtlRunnable;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.stream.Collectors;

@Slf4j
@Service
public class SceneInferenceUseCase {

    private static final int MAX_EXTERNAL_ATTEMPTS = 3;
    private static final long INITIAL_BACKOFF_MS = 200L;

    @Autowired
    private DataAnnotationRecordDAO dataAnnotationRecordDAO;

    @Autowired
    private DataEditDAO dataEditDAO;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private DatasetDAO datasetDAO;

    @Autowired
    private ModelDAO modelDAO;

    @Autowired
    private SceneLocationDAO sceneLocationDAO;

    @Autowired
    private SceneInferenceRunDAO sceneInferenceRunDAO;

    @Autowired
    private DataInfoUseCase dataInfoUseCase;

    @Autowired
    private DatasetUseCase datasetUseCase;

    @Autowired
    private PointCloudDetectionModelHttpCaller detectionModelHttpCaller;

    @Autowired
    private SceneInferenceTrackingHttpCaller trackingHttpCaller;

    @Autowired
    private SceneInferenceFinalizer finalizer;

    @Autowired
    @Qualifier("modelTaskExecutor")
    private ExecutorService executorService;

    public SceneInferenceRun ensure(Long recordId) {
        DataAnnotationRecord record = requireRecord(recordId);
        Long sceneId = resolveSceneId(record);
        Dataset dataset = requireEnabledDataset(record.getDatasetId());
        DatasetInferenceConfig config = normalizedConfig(dataset.getInferenceConfig());
        datasetUseCase.validateInferenceConfig(dataset.getType(), dataset.getSyncMode(),
                dataset.getInferenceMode(), config, dataset.getId());
        String configHash = configHash(config);

        SceneInferenceRun existing = findByConfig(record.getDatasetId(), sceneId, configHash);
        if (existing != null) {
            return existing;
        }

        int totalFrames = Math.toIntExact(dataInfoDAO.count(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sceneId)
                .eq(DataInfo::getIsDeleted, false)));
        if (totalFrames == 0) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "Scene has no frames: recordId=" + recordId + ", sceneId=" + sceneId);
        }
        SceneInferenceRun run = SceneInferenceRun.builder()
                .datasetId(record.getDatasetId())
                .sceneId(sceneId)
                .configHash(configHash)
                .configSnapshot(config)
                .status(SceneInferenceRunStatusEnum.QUEUED)
                .progress(0.0)
                .totalFrames(totalFrames)
                .completedFrames(0)
                .build();
        try {
            sceneInferenceRunDAO.save(run);
        } catch (DuplicateKeyException exception) {
            return findByConfig(record.getDatasetId(), sceneId, configHash);
        }
        executorService.execute(Objects.requireNonNull(TtlRunnable.get(() -> execute(run.getId()))));
        return run;
    }

    public SceneInferenceRun status(Long runId) {
        SceneInferenceRun run = sceneInferenceRunDAO.getById(runId);
        if (run == null) {
            throw new UsecaseException(UsecaseCode.NOT_FOUND, "Inference run not found: runId=" + runId);
        }
        return run;
    }

    private void execute(Long runId) {
        SceneInferenceRun run = sceneInferenceRunDAO.getById(runId);
        if (run == null) {
            return;
        }
        try {
            sceneInferenceRunDAO.update(Wrappers.lambdaUpdate(SceneInferenceRun.class)
                    .eq(SceneInferenceRun::getId, runId)
                    .eq(SceneInferenceRun::getStatus, SceneInferenceRunStatusEnum.QUEUED)
                    .set(SceneInferenceRun::getStatus, SceneInferenceRunStatusEnum.RUNNING));
            Model model = requireDetectionModel(run.getConfigSnapshot().getModelId());
            List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                    .eq(DataInfo::getParentId, run.getSceneId())
                    .eq(DataInfo::getIsDeleted, false)
                    .orderByAsc(DataInfo::getOrderName)
                    .orderByAsc(DataInfo::getId));
            Map<Long, SceneLocation> poses = loadPoses(runId, frames);
            Map<String, DatasetInferenceConfig.ClassMapping> mappings = run.getConfigSnapshot().getClassMappings()
                    .stream().collect(Collectors.toMap(DatasetInferenceConfig.ClassMapping::getModelClassCode,
                            mapping -> mapping));
            List<SceneInferenceTrackingDTO.Frame> trackingFrames = new ArrayList<>(frames.size());
            for (int index = 0; index < frames.size(); index++) {
                DataInfo frame = frames.get(index);
                List<SceneInferenceTrackingDTO.Object> objects =
                        detectFrame(run, model, frame, index, mappings);
                SceneLocation pose = poses.get(frame.getId());
                trackingFrames.add(SceneInferenceTrackingDTO.Frame.builder()
                        .dataId(frame.getId())
                        .frameIndex(index)
                        .pose(SceneInferenceTrackingDTO.Pose.builder()
                                .x(pose.getPosX()).y(pose.getPosY()).z(pose.getPosZ()).yaw(pose.getYaw()).build())
                        .objects(objects)
                        .build());
                updateProgress(runId, index + 1, frames.size());
            }
            DatasetInferenceConfig config = run.getConfigSnapshot();
            SceneInferenceTrackingDTO.Request request = SceneInferenceTrackingDTO.Request.builder()
                    .config(SceneInferenceTrackingDTO.Config.builder()
                            .iouThreshold(config.getAssociationIou())
                            .syncDistance(config.getSyncDistance())
                            .maxOutsideFrames(config.getMaxOutsideFrames())
                            .build())
                    .frames(trackingFrames)
                    .build();
            SceneInferenceTrackingDTO.Response response = trackingHttpCaller.associate(request);
            run.setTotalFrames(frames.size());
            List<Long> allSceneFrameIds = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                            .select(DataInfo::getId)
                            .eq(DataInfo::getParentId, run.getSceneId()))
                    .stream().map(DataInfo::getId).collect(Collectors.toList());
            finalizer.replaceInferenceAnnotations(run, allSceneFrameIds, response);
        } catch (Throwable throwable) {
            log.error("Scene inference run failed: runId={}, datasetId={}, sceneId={}",
                    runId, run.getDatasetId(), run.getSceneId(), throwable);
            markFailed(runId, throwable);
        }
    }

    private List<SceneInferenceTrackingDTO.Object> detectFrame(
            SceneInferenceRun run,
            Model model,
            DataInfo frame,
            int frameIndex,
            Map<String, DatasetInferenceConfig.ClassMapping> mappings) {
        ModelMessageBO message = ModelMessageBO.builder()
                .datasetId(run.getDatasetId())
                .dataId(frame.getId())
                .modelId(model.getId())
                .modelCode(model.getModelCode())
                .modelVersion(model.getVersion())
                .url(model.getUrl())
                .dataInfo(dataInfoUseCase.findById(frame.getId()))
                .build();
        ApiResult<List<PointCloudDetectionRespDTO>> result = callDetectionWithRetry(message, run.getId());
        if (result.getCode() != UsecaseCode.OK || CollUtil.isEmpty(result.getData())) {
            throw new UsecaseException("Detection model returned an invalid result: runId=" + run.getId()
                    + ", dataId=" + frame.getId() + ", code=" + result.getCode()
                    + ", message=" + result.getMessage());
        }
        PointCloudDetectionRespDTO frameResult = result.getData().stream()
                .filter(item -> frame.getId().equals(item.getId()))
                .findFirst()
                .orElseThrow(() -> new UsecaseException("Detection response is missing frame: runId="
                        + run.getId() + ", dataId=" + frame.getId()));
        if (!UsecaseCode.OK.getCode().equals(frameResult.getCode())) {
            throw new UsecaseException("Detection failed for frame: runId=" + run.getId()
                    + ", dataId=" + frame.getId() + ", code=" + frameResult.getCode()
                    + ", message=" + frameResult.getMessage());
        }
        List<SceneInferenceTrackingDTO.Object> objects = new ArrayList<>();
        if (frameResult.getObjects() == null) {
            return objects;
        }
        int objectIndex = 0;
        for (PointCloudDetectionObject prediction : frameResult.getObjects()) {
            DatasetInferenceConfig.ClassMapping mapping = mappings.get(prediction.getLabel());
            if (mapping == null || prediction.getConfidence() == null
                    || prediction.getConfidence().doubleValue() < run.getConfigSnapshot().getMinConfidence()) {
                continue;
            }
            validatePrediction(run.getId(), frame.getId(), prediction);
            objects.add(SceneInferenceTrackingDTO.Object.builder()
                    .predictionId(run.getId() + "-" + frameIndex + "-" + objectIndex++)
                    .label(prediction.getLabel())
                    .confidence(toDouble(prediction.getConfidence()))
                    .x(toDouble(prediction.getX())).y(toDouble(prediction.getY())).z(toDouble(prediction.getZ()))
                    .dx(toDouble(prediction.getDx())).dy(toDouble(prediction.getDy())).dz(toDouble(prediction.getDz()))
                    .rotX(toDouble(prediction.getRotX())).rotY(toDouble(prediction.getRotY()))
                    .rotZ(toDouble(prediction.getRotZ()))
                    .motionMode(mapping.getMotionMode())
                    .datasetClassId(mapping.getDatasetClassId())
                    .build());
        }
        return objects;
    }

    private ApiResult<List<PointCloudDetectionRespDTO>> callDetectionWithRetry(ModelMessageBO message, Long runId) {
        RuntimeException lastError = null;
        for (int attempt = 1; attempt <= MAX_EXTERNAL_ATTEMPTS; attempt++) {
            try {
                return detectionModelHttpCaller.callPreLabelModel(
                        PointCloudDetectionModelReqConverter.buildRequestParam(message), message.getUrl());
            } catch (RuntimeException exception) {
                lastError = exception;
                log.warn("Scene inference detection call failed: runId={}, dataId={}, modelId={}, attempt={}, "
                                + "maxAttempts={}, url={}, error={}",
                        runId, message.getDataId(), message.getModelId(), attempt, MAX_EXTERNAL_ATTEMPTS,
                        message.getUrl(), exception.getMessage());
                if (attempt < MAX_EXTERNAL_ATTEMPTS) {
                    sleepBeforeRetry(INITIAL_BACKOFF_MS << (attempt - 1));
                }
            }
        }
        throw new UsecaseException("Detection model failed after retries: runId=" + runId
                + ", dataId=" + message.getDataId() + ", modelId=" + message.getModelId()
                + ", url=" + message.getUrl() + ", attempts=" + MAX_EXTERNAL_ATTEMPTS
                + ", error=" + (lastError == null ? null : lastError.getMessage()));
    }

    private Map<Long, SceneLocation> loadPoses(Long runId, List<DataInfo> frames) {
        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        Map<Long, SceneLocation> poses = sceneLocationDAO.list(Wrappers.lambdaQuery(SceneLocation.class)
                        .in(SceneLocation::getDataId, frameIds))
                .stream().collect(Collectors.toMap(SceneLocation::getDataId, pose -> pose, (first, second) -> first));
        for (Long frameId : frameIds) {
            SceneLocation pose = poses.get(frameId);
            if (pose == null || pose.getPosX() == null || pose.getPosY() == null || pose.getPosZ() == null
                    || pose.getYaw() == null) {
                throw new UsecaseException("Scene pose is missing or incomplete: runId=" + runId
                        + ", dataId=" + frameId);
            }
        }
        return poses;
    }

    private DataAnnotationRecord requireRecord(Long recordId) {
        DataAnnotationRecord record = dataAnnotationRecordDAO.getById(recordId);
        if (record == null || record.getItemType() != ItemTypeEnum.SCENE) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "A scene annotation record is required: recordId=" + recordId);
        }
        return record;
    }

    private Long resolveSceneId(DataAnnotationRecord record) {
        List<DataEdit> edits = dataEditDAO.list(Wrappers.lambdaQuery(DataEdit.class)
                .eq(DataEdit::getAnnotationRecordId, record.getId()));
        Set<Long> sceneIds = edits.stream().map(edit -> {
            if (edit.getSceneId() != null) {
                return edit.getSceneId();
            }
            DataInfo frame = dataInfoDAO.getById(edit.getDataId());
            return frame == null ? null : frame.getParentId();
        }).filter(ObjectUtil::isNotNull).collect(Collectors.toSet());
        if (sceneIds.size() != 1) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "Annotation record must resolve to exactly one scene: recordId=" + record.getId()
                            + ", sceneIds=" + sceneIds);
        }
        Long sceneId = sceneIds.iterator().next();
        DataInfo scene = dataInfoDAO.getById(sceneId);
        if (scene == null || scene.getType() != ItemTypeEnum.SCENE
                || !record.getDatasetId().equals(scene.getDatasetId())) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "Annotation record resolved to an invalid scene: recordId=" + record.getId()
                            + ", sceneId=" + sceneId);
        }
        return sceneId;
    }

    private Dataset requireEnabledDataset(Long datasetId) {
        Dataset dataset = datasetDAO.getById(datasetId);
        if (dataset == null || dataset.getType() != DatasetTypeEnum.LIDAR_FUSION
                || !Boolean.TRUE.equals(dataset.getSyncMode())
                || !Boolean.TRUE.equals(dataset.getInferenceMode())
                || dataset.getInferenceConfig() == null) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "Dataset inference is not enabled or valid: datasetId=" + datasetId);
        }
        return dataset;
    }

    private Model requireDetectionModel(Long modelId) {
        Model model = modelDAO.getById(modelId);
        if (model == null || model.getModelCode() != ModelCodeEnum.LIDAR_DETECTION
                || model.getUrl() == null || model.getUrl().isBlank()) {
            throw new UsecaseException("Configured point-cloud detection model is unavailable: modelId=" + modelId);
        }
        return model;
    }

    private SceneInferenceRun findByConfig(Long datasetId, Long sceneId, String configHash) {
        return sceneInferenceRunDAO.getOne(Wrappers.lambdaQuery(SceneInferenceRun.class)
                .eq(SceneInferenceRun::getDatasetId, datasetId)
                .eq(SceneInferenceRun::getSceneId, sceneId)
                .eq(SceneInferenceRun::getConfigHash, configHash)
                .last("limit 1"));
    }

    private static DatasetInferenceConfig normalizedConfig(DatasetInferenceConfig source) {
        DatasetInferenceConfig config = JSONUtil.toBean(JSONUtil.toJsonStr(source), DatasetInferenceConfig.class);
        if (config.getSyncDistance() == null) {
            config.setSyncDistance(12.0);
        }
        if (config.getMaxOutsideFrames() == null) {
            config.setMaxOutsideFrames(50);
        }
        if (config.getAssociationIou() == null) {
            config.setAssociationIou(0.3);
        }
        if (config.getMinConfidence() == null) {
            config.setMinConfidence(0.5);
        }
        return config;
    }

    static String configHash(DatasetInferenceConfig config) {
        Map<String, java.lang.Object> canonical = new LinkedHashMap<>();
        canonical.put("modelId", config.getModelId());
        canonical.put("syncDistance", config.getSyncDistance());
        canonical.put("maxOutsideFrames", config.getMaxOutsideFrames());
        canonical.put("associationIou", config.getAssociationIou());
        canonical.put("minConfidence", config.getMinConfidence());
        canonical.put("classMappings", config.getClassMappings());
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(JSONUtil.toJsonStr(canonical).getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(digest.length * 2);
            for (byte value : digest) {
                result.append(String.format("%02x", value & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
    }

    private void updateProgress(Long runId, int completed, int total) {
        sceneInferenceRunDAO.update(Wrappers.lambdaUpdate(SceneInferenceRun.class)
                .eq(SceneInferenceRun::getId, runId)
                .set(SceneInferenceRun::getCompletedFrames, completed)
                .set(SceneInferenceRun::getProgress, completed / (double) total));
    }

    private void markFailed(Long runId, Throwable throwable) {
        String error = throwable.getClass().getSimpleName() + ": " + throwable.getMessage();
        if (error.length() > 8000) {
            error = error.substring(0, 8000);
        }
        sceneInferenceRunDAO.update(Wrappers.lambdaUpdate(SceneInferenceRun.class)
                .eq(SceneInferenceRun::getId, runId)
                .set(SceneInferenceRun::getStatus, SceneInferenceRunStatusEnum.FAILED)
                .set(SceneInferenceRun::getError, error));
    }

    private static void validatePrediction(Long runId, Long dataId, PointCloudDetectionObject prediction) {
        if (prediction.getX() == null || prediction.getY() == null || prediction.getZ() == null
                || prediction.getDx() == null || prediction.getDx().signum() <= 0
                || prediction.getDy() == null || prediction.getDy().signum() <= 0
                || prediction.getDz() == null || prediction.getDz().signum() <= 0
                || prediction.getRotX() == null || prediction.getRotY() == null
                || prediction.getRotZ() == null) {
            throw new UsecaseException("Detection returned invalid geometry: runId=" + runId
                    + ", dataId=" + dataId + ", prediction=" + JSONUtil.toJsonStr(prediction));
        }
    }

    private static Double toDouble(BigDecimal value) {
        return value == null ? null : value.doubleValue();
    }

    private static void sleepBeforeRetry(long delayMs) {
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new UsecaseException("Detection retry interrupted: delayMs=" + delayMs);
        }
    }
}
