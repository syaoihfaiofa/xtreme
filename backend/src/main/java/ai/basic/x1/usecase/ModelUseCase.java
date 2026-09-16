package ai.basic.x1.usecase;

import ai.basic.x1.adapter.api.config.ImageDatasetInitialInfo;
import ai.basic.x1.adapter.api.config.PointCloudDatasetInitialInfo;
import ai.basic.x1.adapter.api.job.converter.ImageKeypointLiftedModelReqConverter;
import ai.basic.x1.adapter.api.job.converter.ParkingSlotDetectionModelReqConverter;
import ai.basic.x1.adapter.api.job.converter.ModelCocoRequestConverter;
import ai.basic.x1.adapter.api.job.converter.PointCloudDetectionModelReqConverter;
import ai.basic.x1.adapter.api.job.converter.PointCloudTrackingModelReqConverter;
import ai.basic.x1.entity.PointCloudTrackingParamBO;
import ai.basic.x1.entity.TrackingSeedObjectBO;
import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.dto.response.ModelResponseDTO;
import ai.basic.x1.adapter.port.dao.*;
import ai.basic.x1.adapter.port.dao.mybatis.model.*;
import ai.basic.x1.adapter.port.dao.redis.ModelSerialNoCountDAO;
import ai.basic.x1.adapter.port.dao.redis.ModelSerialNoIncrDAO;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudDetectionRespDTO;
import ai.basic.x1.entity.*;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.DatasetTypeEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import ai.basic.x1.entity.enums.ModelCodeEnum;
import ai.basic.x1.entity.enums.ModelDatasetTypeEnum;
import ai.basic.x1.entity.enums.RunStatusEnum;
import ai.basic.x1.entity.enums.ToolTypeEnum;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import ai.basic.x1.util.Constants;
import ai.basic.x1.util.DefaultConverter;
import ai.basic.x1.util.Page;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.DatePattern;
import cn.hutool.core.date.DateUtil;
import cn.hutool.core.date.StopWatch;
import cn.hutool.core.lang.TypeReference;
import cn.hutool.core.thread.ThreadUtil;
import cn.hutool.core.util.EnumUtil;
import cn.hutool.core.util.IdUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.*;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import com.alibaba.ttl.TtlRunnable;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.google.common.collect.Lists;
import com.google.common.collect.Maps;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.redis.connection.stream.ObjectRecord;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.Assert;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

import static ai.basic.x1.entity.enums.ModelDatasetTypeEnum.*;
import static ai.basic.x1.usecase.exception.UsecaseCode.PARAM_ERROR;

/**
 * @author chenchao
 * @date 2022/8/26
 */
@Slf4j
public class ModelUseCase {


    @Autowired
    private ModelDAO modelDAO;

    @Autowired
    private ModelClassDAO modelClassDAO;

    @Autowired
    private DatasetDAO datasetDAO;

    @Autowired
    private DatasetClassDAO datasetClassDAO;

    @Autowired
    private ModelRunRecordDAO modelRunRecordDAO;
    @Autowired
    private ModelDatasetResultDAO modelDatasetResultDAO;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    @Autowired
    private ModelSerialNoCountDAO modelSerialNoCountDAO;
    @Autowired
    private ModelSerialNoIncrDAO modelSerialNoIncrDAO;

    @Autowired
    private DataInfoUseCase dataInfoUseCase;

    @Autowired
    private SceneInferenceUseCase sceneInferenceUseCase;

    @Autowired
    private ParkingSlotSceneInferenceUseCase parkingSlotSceneInferenceUseCase;

    @Autowired
    private PointCloudDatasetInitialInfo pointCloudDatasetInitialInfo;

    @Autowired
    private ImageDatasetInitialInfo imageDatasetInitialInfo;

    @Autowired
    private RedisTemplate<String, Object> streamRedisTemplate;

    private static final ExecutorService executorService = ThreadUtil.newExecutor(5);


    public ModelBO add(ModelBO modelBO) {

        modelBO.setModelCode(EnumUtil.fromString(ModelCodeEnum.class, String.format("%s_%s", modelBO.getDatasetType().name(), modelBO.getModelType().name())));
        var model = DefaultConverter.convert(modelBO, Model.class);
        try {
            modelDAO.save(model);
        } catch (DuplicateKeyException e) {
            throw new UsecaseException(UsecaseCode.NAME_DUPLICATED);
        }
        return DefaultConverter.convert(model, ModelBO.class);
    }

    public void update(ModelBO modelBO) {
        try {
            modelDAO.updateById(DefaultConverter.convert(modelBO, Model.class));
        } catch (DuplicateKeyException e) {
            throw new UsecaseException(UsecaseCode.NAME_DUPLICATED);
        }
    }

    public void configurationModelClass(Long modelId, List<ModelClassBO> modelClassBOList) {
        var modelClassLambdaQueryWrapper = Wrappers.lambdaQuery(ModelClass.class);
        modelClassLambdaQueryWrapper.eq(ModelClass::getModelId, modelId);
        modelClassDAO.remove(modelClassLambdaQueryWrapper);
        if (CollUtil.isNotEmpty(modelClassBOList)) {
            modelClassBOList.forEach(modelClassBO -> modelClassBO.setModelId(modelId));
            modelClassDAO.saveBatch(DefaultConverter.convert(modelClassBOList, ModelClass.class));
        }
    }

    public List<ModelBO> list(ModelBO modelBO) {
        ModelDatasetTypeEnum datasetType = modelBO.getDatasetType();
        LambdaQueryWrapper<Model> modelLambdaQueryWrapper = Wrappers.lambdaQuery();
        modelLambdaQueryWrapper.orderBy(true, true, Model::getName);
        if (ObjectUtil.isNotNull(datasetType)) {
            if (LIDAR_BASIC.equals(datasetType) || LIDAR_FUSION.equals(datasetType)) {
                modelLambdaQueryWrapper.in(Model::getDatasetType, Lists.newArrayList(datasetType.name(), LIDAR.name()));
            } else {
                modelLambdaQueryWrapper.eq(Model::getDatasetType, datasetType);
            }
        }
        var modelList = modelDAO.list(modelLambdaQueryWrapper);
        var modelBOList = DefaultConverter.convert(modelList, ModelBO.class);

        if (CollUtil.isNotEmpty(modelBOList)) {
            var modelIds = modelList.stream().map(Model::getId).collect(Collectors.toList());
            var lambdaQueryWrapper = Wrappers.lambdaQuery(ModelClass.class);
            lambdaQueryWrapper.in(ModelClass::getModelId, modelIds);
            var modelClassList = modelClassDAO.list(lambdaQueryWrapper);
            var modelClassBOList = DefaultConverter.convert(modelClassList, ModelClassBO.class);
            var modelClassMap = new HashMap<Long, List<ModelClassBO>>();
            if (CollUtil.isNotEmpty(modelClassBOList)) {
                modelClassMap.putAll(modelClassBOList.stream().collect(Collectors.groupingBy(ModelClassBO::getModelId)));
            }
            modelBOList.forEach(m -> m.setClasses(modelClassMap.get(m.getId())));
            return modelBOList;
        }
        return List.of();
    }

    public Page<ModelBO> findByPage(Integer pageNo, Integer pageSize, ModelDatasetTypeEnum datasetType) {
        LambdaQueryWrapper<Model> modelLambdaQueryWrapper = Wrappers.lambdaQuery();
        modelLambdaQueryWrapper.orderByAsc(Model::getName);
        if (ObjectUtil.isNotNull(datasetType)) {
            modelLambdaQueryWrapper.eq(Model::getDatasetType, datasetType);
        }
        var modelPage = modelDAO.page(new com.baomidou.mybatisplus.extension.plugins.pagination.Page<>(pageNo, pageSize), modelLambdaQueryWrapper);
        return DefaultConverter.convert(modelPage, ModelBO.class);
    }

    public ModelBO findByModelCode(ModelCodeEnum modelCode) {
        var model = modelDAO.getOne(new LambdaQueryWrapper<Model>().eq(Model::getModelCode,
                modelCode));
        return DefaultConverter.convert(model, ModelBO.class);
    }

    public ModelBO findById(Long id) {
        var model = modelDAO.getById(id);
        var lambdaQueryWrapper = Wrappers.lambdaQuery(ModelClass.class);
        lambdaQueryWrapper.eq(ModelClass::getModelId, id);
        var modelClassList = modelClassDAO.list(lambdaQueryWrapper);
        if (ObjectUtil.isNotNull(model)) {
            var modelBO = DefaultConverter.convert(model, ModelBO.class);
            modelBO.setClasses(DefaultConverter.convert(modelClassList, ModelClassBO.class));
            return modelBO;
        }
        return null;
    }

    public void delete(Long id) {
        modelDAO.removeById(id);
        var modelClassLambdaQueryWrapper = Wrappers.lambdaQuery(ModelClass.class);
        modelClassLambdaQueryWrapper.eq(ModelClass::getModelId, id);
        modelClassDAO.remove(modelClassLambdaQueryWrapper);
        var modelRunRecordLambdaQueryWrapper = Wrappers.lambdaQuery(ModelRunRecord.class);
        modelRunRecordLambdaQueryWrapper.eq(ModelRunRecord::getModelId, id);
        modelRunRecordDAO.remove(modelRunRecordLambdaQueryWrapper);
        executorService.execute(() -> {
            var modelDatasetResultLambdaQueryWrapper = Wrappers.lambdaQuery(ModelDatasetResult.class);
            modelDatasetResultLambdaQueryWrapper.eq(ModelDatasetResult::getModelId, id);
            modelDatasetResultDAO.remove(modelDatasetResultLambdaQueryWrapper);
        });
    }

    @Transactional(rollbackFor = Throwable.class)
    public void modelRun(ModelRunBO modelRunBO) {
        var dataset = datasetDAO.getById(modelRunBO.getDatasetId());
        if (ObjectUtil.isNull(dataset)) {
            throw new UsecaseException(UsecaseCode.DATASET__NOT_EXIST);
        }
        Model model = modelDAO.getById(modelRunBO.getModelId());
        if (ObjectUtil.isNull(model)) {
            throw new UsecaseException(UsecaseCode.DATASET__MODEL_NOT_EXIST);
        }
        checkDatasetType(dataset.getType(), model.getDatasetType());
        if (supportsSceneRun(model.getModelCode())
                && ModelRunSceneTrackingParamBO.hasClassMappings(modelRunBO.getResultFilterParam())) {
            startSceneTrackingModelRun(modelRunBO, dataset, model);
            return;
        }
        var modelRunFilterDataBO = modelRunBO.getDataFilterParam();
        var totalDataNum = dataInfoUseCase.findModelRunDataCount(modelRunFilterDataBO, modelRunBO.getDatasetId(), modelRunBO.getModelId());
        totalDataNum = (long) Math.ceil(BigDecimal.valueOf(totalDataNum).multiply(BigDecimal.valueOf(modelRunFilterDataBO.getDataCountRatio())).divide(BigDecimal.valueOf(100)).doubleValue());
        if (totalDataNum == 0) {
            throw new UsecaseException(UsecaseCode.DATASET_DATA_SCENARIO_NOT_FOUND);
        }
        ModelBO modelBO = getModelById(modelRunBO.getModelId());
        if (ObjectUtil.isNull(modelBO)) {
            throw new UsecaseException(UsecaseCode.DATASET__MODEL_NOT_EXIST);
        }
        var dataIds = dataInfoUseCase.findModelRunDataIds(modelRunBO.getDataFilterParam(),
                modelRunBO.getDatasetId(), modelRunBO.getModelId(), totalDataNum);
        ModelRunRecord modelRunRecord = ModelRunRecord.builder()
                .modelId(modelRunBO.getModelId())
                .modelVersion(modelBO.getVersion())
                .modelSerialNo(IdUtil.getSnowflakeNextId())
                .dataFilterParam(DefaultConverter.convert(modelRunBO.getDataFilterParam(), ModelRunFilterData.class))
                .runNo(DateUtil.format(OffsetDateTime.now().toLocalDateTime(), DatePattern.PURE_DATETIME_PATTERN))
                .datasetId(dataset.getId())
                .status(RunStatusEnum.STARTED)
                .resultFilterParam(modelRunBO.getResultFilterParam())
                .dataCount(totalDataNum).build();
        modelRunRecordDAO.save(modelRunRecord);
        this.sendModelMessageAsync(modelRunRecord, modelBO, totalDataNum, dataIds);
    }

    private void startSceneTrackingModelRun(ModelRunBO modelRunBO, Dataset dataset, Model model) {
        List<Long> sceneIds = requireSceneIds(modelRunBO.getDataFilterParam());
        long totalFrames = validateScenesAndCountFrames(dataset.getId(), sceneIds);
        ModelRunSceneTrackingParamBO trackingParam =
                ModelRunSceneTrackingParamBO.parse(modelRunBO.getResultFilterParam());
        resolveSceneTrackingMappings(dataset.getId(), model.getId(), trackingParam);
        JSONObject resolvedResultFilterParam = JSONUtil.parseObj(trackingParam);
        ModelRunRecord modelRunRecord = ModelRunRecord.builder()
                .modelId(model.getId())
                .modelVersion(model.getVersion())
                .modelSerialNo(IdUtil.getSnowflakeNextId())
                .dataFilterParam(DefaultConverter.convert(
                        modelRunBO.getDataFilterParam(), ModelRunFilterData.class))
                .runNo(DateUtil.format(
                        OffsetDateTime.now().toLocalDateTime(), DatePattern.PURE_DATETIME_PATTERN))
                .datasetId(dataset.getId())
                .status(RunStatusEnum.STARTED)
                .resultFilterParam(resolvedResultFilterParam)
                .dataCount(totalFrames)
                .build();
        modelRunRecordDAO.save(modelRunRecord);
        DatasetInferenceConfig config = trackingParam.toInferenceConfig(model.getId());
        executorService.execute(() -> executeSceneTrackingModelRun(
                modelRunRecord, model, sceneIds, config));
    }

    private void resolveSceneTrackingMappings(
            Long datasetId,
            Long modelId,
            ModelRunSceneTrackingParamBO trackingParam) {
        List<DatasetClass> datasetClasses = datasetClassDAO.list(
                Wrappers.lambdaQuery(DatasetClass.class)
                        .eq(DatasetClass::getDatasetId, datasetId));
        Map<Long, DatasetClass> datasetClassById = datasetClasses.stream()
                .collect(Collectors.toMap(DatasetClass::getId, datasetClass -> datasetClass));
        ToolTypeEnum expectedToolType = modelId != null && modelDAO.getById(modelId).getModelCode() == ModelCodeEnum.PARKING_SLOT_DETECTION
                ? ToolTypeEnum.PARKING_SLOT : ToolTypeEnum.CUBOID;
        Map<String, DatasetClass> cuboidClassByName = datasetClasses.stream()
                .filter(datasetClass -> datasetClass.getToolType() == expectedToolType)
                .collect(Collectors.toMap(
                        datasetClass -> normalizeClassName(datasetClass.getName()),
                        datasetClass -> datasetClass,
                        (first, ignored) -> first));
        Map<String, ModelClass> modelClassByCode = modelClassDAO.list(
                        Wrappers.lambdaQuery(ModelClass.class)
                                .eq(ModelClass::getModelId, modelId))
                .stream()
                .collect(Collectors.toMap(
                        modelClass -> normalizeClassName(modelClass.getCode()),
                        modelClass -> modelClass,
                        (first, ignored) -> first));

        for (DatasetInferenceConfig.ClassMapping mapping : trackingParam.getClassMappings()) {
            if (mapping.getDatasetClassId() != null) {
                DatasetClass selected = datasetClassById.get(mapping.getDatasetClassId());
                if (selected == null || selected.getToolType() != expectedToolType) {
                    throw new UsecaseException(PARAM_ERROR,
                            "Mapped dataset class has an incompatible tool type in the selected dataset: datasetId="
                                    + datasetId + ", datasetClassId=" + mapping.getDatasetClassId()
                                    + ", modelClassCode=" + mapping.getModelClassCode());
                }
                continue;
            }
            if (expectedToolType == ToolTypeEnum.PARKING_SLOT) {
                throw new UsecaseException(PARAM_ERROR,
                        "Parking-slot model classes must be mapped to an existing PARKING_SLOT dataset class: modelClassCode="
                                + mapping.getModelClassCode());
            }
            String normalizedCode = normalizeClassName(mapping.getModelClassCode());
            ModelClass modelClass = modelClassByCode.get(normalizedCode);
            String className = modelClass == null || StrUtil.isBlank(modelClass.getName())
                    ? mapping.getModelClassCode() : modelClass.getName();
            DatasetClass datasetClass = cuboidClassByName.get(normalizeClassName(className));
            if (datasetClass == null) {
                datasetClass = cuboidClassByName.get(normalizedCode);
            }
            if (datasetClass == null) {
                datasetClass = createCuboidDatasetClass(datasetId, className);
                cuboidClassByName.put(normalizeClassName(datasetClass.getName()), datasetClass);
            }
            mapping.setDatasetClassId(datasetClass.getId());
        }
    }

    private DatasetClass createCuboidDatasetClass(Long datasetId, String className) {
        DatasetClass datasetClass = DatasetClass.builder()
                .datasetId(datasetId)
                .name(className)
                .color(colorForClass(className))
                .toolType(ToolTypeEnum.CUBOID)
                .toolTypeOptions(JSONUtil.createObj()
                        .set("width", Arrays.asList(null, null))
                        .set("height", Arrays.asList(null, null))
                        .set("length", Arrays.asList(null, null))
                        .set("isStandard", false)
                        .set("isConstraints", false))
                .attributes(new JSONArray())
                .build();
        try {
            datasetClassDAO.save(datasetClass);
            return datasetClass;
        } catch (DuplicateKeyException exception) {
            DatasetClass existing = datasetClassDAO.getOne(
                    Wrappers.lambdaQuery(DatasetClass.class)
                            .eq(DatasetClass::getDatasetId, datasetId)
                            .eq(DatasetClass::getName, className)
                            .eq(DatasetClass::getToolType, ToolTypeEnum.CUBOID));
            if (existing != null) {
                return existing;
            }
            throw exception;
        }
    }

    private static String normalizeClassName(String value) {
        return StrUtil.blankToDefault(value, "").trim().toLowerCase(Locale.ROOT);
    }

    private static String colorForClass(String className) {
        int rgb = Math.floorMod(Objects.requireNonNull(className).hashCode(), 0x1000000);
        return String.format(Locale.ROOT, "#%06x", rgb);
    }

    private long validateScenesAndCountFrames(Long datasetId, List<Long> sceneIds) {
        long totalFrames = 0L;
        for (Long sceneId : sceneIds) {
            DataInfo scene = dataInfoDAO.getById(sceneId);
            if (scene == null || scene.getType() != ItemTypeEnum.SCENE
                    || !datasetId.equals(scene.getDatasetId())
                    || Boolean.TRUE.equals(scene.getIsDeleted())) {
                throw new UsecaseException(PARAM_ERROR,
                        "Invalid scene selection: datasetId=" + datasetId + ", sceneId=" + sceneId);
            }
            totalFrames += dataInfoDAO.count(Wrappers.lambdaQuery(DataInfo.class)
                    .eq(DataInfo::getParentId, sceneId)
                    .eq(DataInfo::getIsDeleted, false));
        }
        if (totalFrames == 0) {
            throw new UsecaseException(UsecaseCode.DATASET_DATA_SCENARIO_NOT_FOUND);
        }
        return totalFrames;
    }

    private void executeSceneTrackingModelRun(
            ModelRunRecord modelRunRecord,
            Model model,
            List<Long> sceneIds,
            DatasetInferenceConfig config) {
        modelRunRecordDAO.update(Wrappers.lambdaUpdate(ModelRunRecord.class)
                .eq(ModelRunRecord::getId, modelRunRecord.getId())
                .set(ModelRunRecord::getStatus, RunStatusEnum.RUNNING)
                .set(ModelRunRecord::getErrorReason, null));
        int successCount = 0;
        List<String> failures = new ArrayList<>();
        for (Long sceneId : sceneIds) {
            try {
                List<String> skippedFrames = Collections.emptyList();
                if (model.getModelCode() == ModelCodeEnum.PARKING_SLOT_DETECTION) {
                    skippedFrames = parkingSlotSceneInferenceUseCase.runForModelRun(modelRunRecord.getId(),
                            modelRunRecord.getDatasetId(), sceneId, model, config);
                } else {
                    sceneInferenceUseCase.runForModelRun(
                            modelRunRecord.getId(), modelRunRecord.getDatasetId(), sceneId, model, config);
                }
                successCount++;
                if (!skippedFrames.isEmpty()) {
                    failures.add(sceneId + ": skipped frames: " + JSONUtil.toJsonStr(skippedFrames));
                }
            } catch (RuntimeException exception) {
                failures.add(sceneId + ":" + exception.getClass().getSimpleName()
                        + ": " + exception.getMessage());
                log.error("Scene tracking Model Run failed: runRecordId={}, datasetId={}, sceneId={}, modelId={}",
                        modelRunRecord.getId(), modelRunRecord.getDatasetId(), sceneId, model.getId(), exception);
            }
        }
        RunStatusEnum status = summarizeSceneRunStatus(successCount, failures.size());
        String errorReason = failures.isEmpty() ? null : JSONUtil.toJsonStr(failures);
        if (errorReason != null && errorReason.length() > 8000) {
            errorReason = errorReason.substring(0, 8000);
        }
        modelRunRecordDAO.update(Wrappers.lambdaUpdate(ModelRunRecord.class)
                .eq(ModelRunRecord::getId, modelRunRecord.getId())
                .set(ModelRunRecord::getStatus, status)
                .set(ModelRunRecord::getErrorReason, errorReason));
    }

    static List<Long> requireSceneIds(ModelRunFilterDataBO filter) {
        if (filter == null || CollUtil.isEmpty(filter.getSceneIds())) {
            throw new UsecaseException(PARAM_ERROR,
                    "sceneIds cannot be empty for a scene tracking Model Run");
        }
        return new ArrayList<>(new LinkedHashSet<>(filter.getSceneIds()));
    }

    static RunStatusEnum summarizeSceneRunStatus(int successCount, int failureCount) {
        if (failureCount == 0) {
            return RunStatusEnum.SUCCESS;
        }
        if (successCount == 0) {
            return RunStatusEnum.FAILURE;
        }
        return RunStatusEnum.SUCCESS_WITH_ERROR;
    }

    private static boolean supportsSceneRun(ModelCodeEnum modelCode) {
        return SceneInferenceUseCase.supportsSceneTracking(modelCode)
                || modelCode == ModelCodeEnum.PARKING_SLOT_DETECTION;
    }

    private void checkDatasetType(DatasetTypeEnum datasetType, ModelDatasetTypeEnum modelDatasetType) {
        if (LIDAR.equals(modelDatasetType)) {
            if (ObjectUtil.notEqual(DatasetTypeEnum.LIDAR_BASIC, datasetType) && ObjectUtil.notEqual(DatasetTypeEnum.LIDAR_FUSION, datasetType)) {
                throw new UsecaseException(UsecaseCode.UNKNOWN, "model's dataset type is not match dataset type");
            }
        } else if (!modelDatasetType.name().equals(datasetType.name())) {
            throw new UsecaseException(UsecaseCode.UNKNOWN, "model's dataset type is not match dataset type");
        }
    }

    @Transactional(rollbackFor = Throwable.class)
    public void reRun(ModelRunRecordBO modelRunRecordBO) {
        ModelRunRecord modelRunRecord = modelRunRecordDAO.getById(modelRunRecordBO.getId());
        if (ObjectUtil.isNull(modelRunRecord)) {
            throw new UsecaseException(UsecaseCode.DATASET__MODEL_RUN_RECORD_NOT_EXIST);
        }
        if (ModelRunSceneTrackingParamBO.hasClassMappings(modelRunRecord.getResultFilterParam())) {
            reRunSceneTracking(modelRunRecord);
            return;
        }
        var queryWrapper = Wrappers.lambdaQuery(ModelDatasetResult.class);
        queryWrapper.eq(ModelDatasetResult::getRunRecordId, modelRunRecordBO.getId());
        var totalDataNum = modelDatasetResultDAO.count(queryWrapper);
        if (totalDataNum == 0) {
            throw new UsecaseException(UsecaseCode.DATASET_DATA_SCENARIO_NOT_FOUND);
        }
        ModelBO modelBO = getModelById(modelRunRecord.getModelId());
        if (ObjectUtil.isNull(modelBO)) {
            throw new UsecaseException(UsecaseCode.DATASET__MODEL_NOT_EXIST);
        }
        if (StrUtil.isEmpty(modelBO.getUrl())) {
            throw new UsecaseException(PARAM_ERROR, "Please first configure the model URL.");
        }
        boolean updateResult = modelRunRecordDAO.update(ModelRunRecord.builder().build(), Wrappers.lambdaUpdate(ModelRunRecord.class)
                .set(ModelRunRecord::getDataCount, totalDataNum)
                .set(ModelRunRecord::getStatus, RunStatusEnum.STARTED)
                .eq(ModelRunRecord::getId, modelRunRecordBO.getId())
                .in(ModelRunRecord::getStatus, RunStatusEnum.FAILURE, RunStatusEnum.SUCCESS_WITH_ERROR)
        );
        if (updateResult) {
            queryWrapper.select(ModelDatasetResult::getDataId);
            var modelDatasetResultList = modelDatasetResultDAO.list(queryWrapper);
            modelDatasetResultDAO.remove(new LambdaUpdateWrapper<ModelDatasetResult>()
                    .eq(ModelDatasetResult::getModelSerialNo, modelRunRecord.getModelSerialNo())
            );
            sendModelMessageAsync(modelRunRecord, modelBO, totalDataNum, modelDatasetResultList.stream().map(ModelDatasetResult::getDataId).collect(Collectors.toList()));
        } else {
            throw new UsecaseException(UsecaseCode.DATASET__MODEL_RERUN_ERROR);
        }
    }

    private void reRunSceneTracking(ModelRunRecord modelRunRecord) {
        Model model = modelDAO.getById(modelRunRecord.getModelId());
        if (model == null || !supportsSceneRun(model.getModelCode())) {
            throw new UsecaseException(UsecaseCode.DATASET__MODEL_NOT_EXIST);
        }
        if (StrUtil.isEmpty(model.getUrl())) {
            throw new UsecaseException(PARAM_ERROR, "Please first configure the model URL.");
        }
        ModelRunFilterDataBO filter = DefaultConverter.convert(
                modelRunRecord.getDataFilterParam(), ModelRunFilterDataBO.class);
        List<Long> sceneIds = requireSceneIds(filter);
        long totalFrames = validateScenesAndCountFrames(modelRunRecord.getDatasetId(), sceneIds);
        boolean updated = modelRunRecordDAO.update(
                ModelRunRecord.builder().build(),
                Wrappers.lambdaUpdate(ModelRunRecord.class)
                        .set(ModelRunRecord::getDataCount, totalFrames)
                        .set(ModelRunRecord::getStatus, RunStatusEnum.STARTED)
                        .set(ModelRunRecord::getErrorReason, null)
                        .eq(ModelRunRecord::getId, modelRunRecord.getId())
                        .in(ModelRunRecord::getStatus,
                                RunStatusEnum.SUCCESS,
                                RunStatusEnum.FAILURE,
                                RunStatusEnum.SUCCESS_WITH_ERROR));
        if (!updated) {
            throw new UsecaseException(UsecaseCode.DATASET__MODEL_RERUN_ERROR);
        }
        dataAnnotationObjectDAO.remove(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .eq(DataAnnotationObject::getSourceType, DataAnnotationObjectSourceTypeEnum.MODEL)
                .eq(DataAnnotationObject::getSourceId, modelRunRecord.getId()));
        DatasetInferenceConfig config = ModelRunSceneTrackingParamBO
                .parse(modelRunRecord.getResultFilterParam())
                .toInferenceConfig(model.getId());
        modelRunRecord.setDataCount(totalFrames);
        executorService.execute(() -> executeSceneTrackingModelRun(
                modelRunRecord, model, sceneIds, config));
    }

    public ModelResponseBO testModelUrlConnection(Long modelId, String url) {
        ModelBO modelBO = getModelById(modelId);
        if (ObjectUtil.isNull(modelBO)) {
            throw new UsecaseException(UsecaseCode.DATASET__MODEL_NOT_EXIST);
        }
        String requestBody = null;
        DataInfoBO dataInfoBO;
        switch (modelBO.getModelCode()) {
            case IMAGE_DETECTION:
                dataInfoBO = dataInfoUseCase.getInitDataInfoBO(imageDatasetInitialInfo);
                var predImageReqDTO = ModelCocoRequestConverter.convert(ModelMessageBO.builder().dataInfo(dataInfoBO).build());
                requestBody = JSONUtil.toJsonStr(predImageReqDTO);
                break;
            case LIDAR_DETECTION:
                dataInfoBO = dataInfoUseCase.getInitDataInfoBO(pointCloudDatasetInitialInfo);
                var preModelReqDTO = PointCloudDetectionModelReqConverter.buildRequestParam(ModelMessageBO.builder().dataInfo(dataInfoBO).build());
                requestBody = JSONUtil.toJsonStr(preModelReqDTO);
                break;
            case LIDAR_TRACKING:
                dataInfoBO = dataInfoUseCase.getInitDataInfoBO(pointCloudDatasetInitialInfo);
                var trackingMessage = ModelMessageBO.builder()
                        .dataInfo(dataInfoBO)
                        .resultFilterParam(JSONUtil.parseObj(PointCloudTrackingParamBO.builder()
                                .sourceDataId(dataInfoBO.getId())
                                .direction("FORWARD")
                                .objects(List.of(TrackingSeedObjectBO.builder().trackingId("test").build()))
                                .build()))
                        .build();
                requestBody = JSONUtil.toJsonStr(PointCloudTrackingModelReqConverter.buildRequestParam(trackingMessage, dataInfoBO));
                break;
            case IMAGE_KEYPOINT_LIFTED_DETECTION:
                dataInfoBO = dataInfoUseCase.getInitDataInfoBO(pointCloudDatasetInitialInfo);
                requestBody = JSONUtil.toJsonStr(ImageKeypointLiftedModelReqConverter.convert(
                        ModelMessageBO.builder().dataInfo(dataInfoBO).build()));
                break;
            case PARKING_SLOT_DETECTION:
                dataInfoBO = dataInfoUseCase.getInitDataInfoBO(pointCloudDatasetInitialInfo);
                requestBody = JSONUtil.toJsonStr(ParkingSlotDetectionModelReqConverter.convert(
                        ModelMessageBO.builder().dataInfo(dataInfoBO).build()));
                break;
            default:
        }
        try {
            var modelResponseBO = reqModel(requestBody, url);
            validateModelResponse(modelResponseBO, modelBO.getModelCode());
            return modelResponseBO;
        } catch (Exception e) {
            return ModelResponseBO.builder().errorMessage(e.getMessage()).code(UsecaseCode.ERROR).build();
        }
    }


    public ModelBO getModelById(Long modelId) {
        LambdaQueryWrapper<Model> modelLambdaQueryWrapper = new LambdaQueryWrapper<>();
        modelLambdaQueryWrapper.eq(Model::getId, modelId);
        Model model = modelDAO.getOne(modelLambdaQueryWrapper, Boolean.FALSE);
        return DefaultConverter.convert(model, ModelBO.class);
    }

    public Map<String, ModelClass> getModelClassMapByModelId(Long modelId) {
        var modelClassLambdaQueryWrapper = Wrappers.lambdaQuery(ModelClass.class);
        modelClassLambdaQueryWrapper.eq(ModelClass::getModelId, modelId);
        var modelClassList = modelClassDAO.list(modelClassLambdaQueryWrapper);
        if (CollUtil.isNotEmpty(modelClassList)) {
            return modelClassList.stream().collect(Collectors.toMap(ModelClass::getCode, v -> v));
        }
        return Maps.newHashMap();
    }

    public RecordId sendDataModelMessageToMQ(ModelMessageBO modelMessageBO) {
        ObjectRecord<String, String> record = StreamRecords.newRecord()
                .in(Constants.DATA_MODEL_RUN_STREAM_KEY)
                .ofObject(JSONUtil.toJsonStr(modelMessageBO))
                .withId(RecordId.autoGenerate());
        return streamRedisTemplate.opsForStream().add(record);
    }

    public RecordId sendDatasetModelMessageToMQ(ModelMessageBO modelMessageBO) {
        ObjectRecord<String, String> record = StreamRecords.newRecord()
                .in(Constants.DATASET_MODEL_RUN_STREAM_KEY)
                .ofObject(JSONUtil.toJsonStr(modelMessageBO))
                .withId(RecordId.autoGenerate());
        return streamRedisTemplate.opsForStream().add(record);
    }

    private void sendModelMessageAsync(ModelRunRecord modelRunRecord, ModelBO modelBO, long totalDataNum, List<Long> dataIds) {
        Assert.notNull(modelRunRecord, "modelRunRecord is null");
        log.info("start send model message. datasetId: {}, runRecodeId: {}",
                modelRunRecord.getDatasetId(), modelRunRecord.getId());
        try {
            executorService.execute(Objects.requireNonNull(TtlRunnable.get(() -> {
                try {
                    // Cumulative number of messages sent.
                    AtomicInteger sendSuccessNum = new AtomicInteger();
                    // Accumulated number of inserted records.
                    AtomicInteger insertRecordNum = new AtomicInteger(0);
                    var modelSerialNo = modelRunRecord.getModelSerialNo();
                    log.info("executor start. datasetId: {}, runRecodeId: {}",
                            modelRunRecord.getDatasetId(), modelRunRecord.getId());
                    modelSerialNoIncrDAO.removeModelSerialNo(modelRunRecord.getModelSerialNo());
                    modelSerialNoCountDAO.setCount(modelRunRecord.getModelSerialNo(),
                            (int) totalDataNum);

                    var dataIdList = CollUtil.split(dataIds, 1000);
                    dataIdList.forEach(dataIdSubList -> {
                        if (isNotExistModelRunRecord(modelRunRecord)) {
                            log.error("model {} runId {} is delete.", modelBO.getModelCode(), modelRunRecord.getRunNo());
                            return;
                        }
                        var dataInfoBOList = dataInfoUseCase.listByIds(dataIdSubList, true);
                        insertRecordNum.addAndGet(batchSaveModelDatasetMessage(dataInfoBOList,
                                modelRunRecord));
                        log.info("model {} runId {} cumulative insert num {}",
                                modelBO.getModelCode(),
                                modelRunRecord.getRunNo(), insertRecordNum);
                        sendSuccessNum.addAndGet(sendModelDatasetMessage(
                                convertMessageList(dataInfoBOList, modelRunRecord, modelBO)
                        ));
                        modelSerialNoCountDAO.setCount(modelSerialNo, sendSuccessNum.get());
                        log.info("model {} runId {} cumulative send num {}", modelBO.getModelCode(),
                                modelRunRecord.getRunNo(), sendSuccessNum);
                        log.info("model {} runId {} finish.", modelBO.getModelCode(),
                                modelRunRecord.getRunNo());
                    });
                } catch (Exception e) {
                    log.info("model {} runId {} fail. Exception:{}",
                            modelBO.getModelCode(),
                            modelRunRecord.getRunNo(), e);
                }
            })));
        } catch (RejectedExecutionException ex) {
            throw new UsecaseException(UsecaseCode.UNKNOWN,
                    "The system is busy, please try again later");
        }
    }

    private boolean isNotExistModelRunRecord(ModelRunRecord modelRunRecord) {
        var query = new LambdaQueryWrapper<ModelRunRecord>();
        query.eq(ModelRunRecord::getId, modelRunRecord.getId());
        return !modelRunRecordDAO.getBaseMapper().exists(query);
    }

    private int batchSaveModelDatasetMessage(List<DataInfoBO> dataInfoList, ModelRunRecord modelRunRecord) {
        var records = convertModelDatasetResultList(dataInfoList, modelRunRecord);
        if (CollUtil.isNotEmpty(records)) {
            modelDatasetResultDAO.insertBatch(records);
        }
        return CollUtil.isEmpty(records) ? 0 : records.size();
    }

    private List<ModelDatasetResult> convertModelDatasetResultList(List<DataInfoBO> dataInfoList, ModelRunRecord modelRunRecord) {
        var modelDatasetResults = new ArrayList<ModelDatasetResult>(dataInfoList.size());
        dataInfoList.forEach(data -> {
            var modelDatasetResult = ModelDatasetResult.builder()
                    .datasetId(modelRunRecord.getDatasetId())
                    .modelId(modelRunRecord.getModelId())
                    .modelVersion(modelRunRecord.getModelVersion())
                    .modelSerialNo(modelRunRecord.getModelSerialNo())
                    .runNo(modelRunRecord.getRunNo())
                    .runRecordId(modelRunRecord.getId())
                    .dataId(data.getId())
                    .isSuccess(Boolean.TRUE)
                    .resultFilterParam(modelRunRecord.getResultFilterParam())
                    .build();
            modelDatasetResults.add(modelDatasetResult);
        });
        return modelDatasetResults;
    }

    private List<ModelMessageBO> convertMessageList(List<DataInfoBO> dataInfoList,
                                                    ModelRunRecord modelRunRecord,
                                                    ModelBO modelBO) {
        if (CollUtil.isEmpty(dataInfoList)) {
            return new ArrayList<>(1);
        }
        var messages = new ArrayList<ModelMessageBO>(dataInfoList.size());
        dataInfoList.forEach(data -> {
            var message = ModelMessageBO.builder()
                    .datasetId(modelRunRecord.getDatasetId())
                    .modelId(modelRunRecord.getModelId())
                    .modelVersion(modelRunRecord.getModelVersion())
                    .modelSerialNo(modelRunRecord.getModelSerialNo())
                    .modelCode(modelBO.getModelCode())
                    .createdBy(modelRunRecord.getCreatedBy())
                    .resultFilterParam(JSONUtil.parseObj(modelRunRecord.getResultFilterParam()))
                    .dataId(data.getId())
                    .dataInfo(DefaultConverter.convert(data, DataInfoBO.class))
                    .url(modelBO.getUrl())
                    .build();
            messages.add(message);
        });
        return messages;
    }

    private int sendModelDatasetMessage(List<ModelMessageBO> modelMessageList) {
        if (CollUtil.isEmpty(modelMessageList)) {
            return 0;
        }
        AtomicInteger sendNum = new AtomicInteger(0);
        modelMessageList.forEach(modelMessageBO -> {
            this.sendDatasetModelMessageToMQ(modelMessageBO);
            sendNum.getAndIncrement();
        });
        return sendNum.get();
    }

    private ModelResponseBO reqModel(String requestBody, String url) {
        try {
            StopWatch stopWatch = new StopWatch();
            stopWatch.start();
            HttpRequest httpRequest = HttpUtil.createPost(url)
                    .body(requestBody, ContentType.JSON.getValue());
            HttpResponse httpResponse = httpRequest.execute();
            stopWatch.stop();
            log.info(String.format("call preLabelModelService took: %dms,req:%s ,resp:%s", stopWatch.getLastTaskTimeMillis(), requestBody, httpResponse.body()));

            return ModelResponseBO.builder().status(httpResponse.getStatus()).code(UsecaseCode.ERROR).content(JSONUtil.parseObj(httpResponse.body())).build();
        } catch (Exception e) {
            log.error("call pre-model service error.", e);
            throw new UsecaseException("Model service connection timed out");
        }
    }

    private void validateModelResponse(ModelResponseBO modelResponseBO, ModelCodeEnum modelCode) {
        switch (modelCode) {
            case IMAGE_DETECTION:
            case LIDAR_DETECTION:
            case LIDAR_TRACKING:
            case IMAGE_KEYPOINT_LIFTED_DETECTION:
            case PARKING_SLOT_DETECTION:
                var missFiled = new ArrayList<>();
                var content = modelResponseBO.getContent();
                if (!content.containsKey(Constants.MODEL_RUN_RESULT_CODE)) {
                    missFiled.add(Constants.MODEL_RUN_RESULT_CODE);
                }
                if (!UsecaseCode.OK.getCode().equals(content.get(Constants.MODEL_RUN_RESULT_CODE))) {
                    modelResponseBO.setErrorMessage(content.getStr(Constants.MODEL_RUN_RESULT_MESSAGE));
                    return;
                }
                if (!content.containsKey(Constants.MODEL_RUN_RESULT_DATA)) {
                    missFiled.add(Constants.MODEL_RUN_RESULT_DATA);
                }
                try {
                    var data = content.getJSONArray(Constants.MODEL_RUN_RESULT_DATA);
                    if (CollUtil.isNotEmpty(data)) {
                        var d = JSONUtil.parseObj(CollUtil.getFirst(data));
                        if (!d.containsKey(Constants.MODEL_RUN_RESULT_CODE)) {
                            missFiled.add(Constants.MODEL_RUN_RESULT_DATA_CODE);
                        }
                        if (!UsecaseCode.OK.getCode().equals(d.get(Constants.MODEL_RUN_RESULT_CODE))) {
                            modelResponseBO.setErrorMessage(d.getStr(Constants.MODEL_RUN_RESULT_MESSAGE));
                            return;
                        }
                        if (!d.containsKey(Constants.MODEL_RUN_RESULT_OBJECTS)) {
                            missFiled.add(Constants.MODEL_RUN_RESULT_OBJECTS);
                        }
                        if (CollUtil.isNotEmpty(missFiled)) {
                            var lastMissFiled = CollUtil.getLast(missFiled);
                            missFiled.remove(lastMissFiled);
                            var missFiledErrorStr = CollUtil.isEmpty(missFiled) ? lastMissFiled : String.format("%s and %s", CollUtil.join(missFiled, ","), lastMissFiled);
                            modelResponseBO.setErrorMessage(String.format(UsecaseCode.MODEL__MISS_FILED.getMessage(), missFiledErrorStr));
                            return;
                        }
                        modelResponseBO.setCode(UsecaseCode.OK);

                    } else {
                        modelResponseBO.setErrorMessage("Data is not allowed to be empty");
                    }

                } catch (Exception e) {
                    log.info("data parse error", e);
                    modelResponseBO.setErrorMessage("The format of data is wrong, it must be a json array");
                }

                break;
            default:
                break;
        }

    }
}
