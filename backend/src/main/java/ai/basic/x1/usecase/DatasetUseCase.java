package ai.basic.x1.usecase;

import ai.basic.x1.adapter.api.config.DatasetInitialInfo;
import ai.basic.x1.adapter.api.config.ImageDatasetInitialInfo;
import ai.basic.x1.adapter.api.config.PointCloudDatasetInitialInfo;
import ai.basic.x1.adapter.api.context.RequestContextHolder;
import ai.basic.x1.adapter.api.context.UserInfo;
import ai.basic.x1.adapter.port.dao.*;
import ai.basic.x1.adapter.port.dao.mybatis.model.*;
import ai.basic.x1.entity.*;
import ai.basic.x1.entity.enums.DatasetTypeEnum;
import ai.basic.x1.entity.enums.ModelCodeEnum;
import ai.basic.x1.entity.enums.ModelDatasetTypeEnum;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import ai.basic.x1.util.DecompressionFileUtils;
import ai.basic.x1.util.DefaultConverter;
import ai.basic.x1.util.Page;
import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.IdUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONUtil;
import com.alibaba.ttl.TtlRunnable;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.annotation.Transactional;

import javax.annotation.PostConstruct;
import java.io.IOException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.stream.Collectors;

import static ai.basic.x1.entity.enums.DatasetTypeEnum.IMAGE;
import static ai.basic.x1.util.Constants.PAGE_SIZE_100;

/**
 * @author fyb
 * @date 2022/2/16 15:03
 */
@Slf4j
public class DatasetUseCase {

    @Autowired
    private DatasetDAO datasetDAO;

    @Autowired
    private DatasetClassDAO datasetClassDAO;

    @Autowired
    private ModelDAO modelDAO;

    @Autowired
    private ModelClassDAO modelClassDAO;

    @Autowired
    private DatasetClassificationDAO datasetClassificationDAO;

    @Autowired
    private DataInfoUseCase dataInfoUseCase;


    @Autowired
    private UploadDataUseCase uploadDataUseCase;

    @Autowired
    private UserUseCase userUseCase;

    @Autowired
    private PointCloudDatasetInitialInfo pointCloudDatasetInitialInfo;

    @Autowired
    private ImageDatasetInitialInfo imageDatasetInitialInfo;

    @Autowired
    private DataAnnotationObjectUseCase dataAnnotationObjectUseCase;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    @Autowired
    private DatasetClassUseCase datasetClassUseCase;

    @Autowired
    private DataAnnotationClassificationDAO dataAnnotationClassificationDAO;

    @Value("${file.tempPath:/tmp/xtreme1/}")
    private String tempPath;

    @Autowired
    @Qualifier("datasetInitializationExecutor")
    private ExecutorService executorService;

    @PostConstruct
    public void init() {
        initDataset(pointCloudDatasetInitialInfo);
        initDataset(imageDatasetInitialInfo);
    }

    private void initDataset(DatasetInitialInfo datasetInitialInfo) {
        var file = FileUtil.file(".", datasetInitialInfo.getFileName());
        if (file.isFile()) {
            executorService.execute(Objects.requireNonNull(TtlRunnable.get(() -> {
                var datasetName = datasetInitialInfo.getName();
                var dataset = this.getInitDataset(datasetInitialInfo);
                if (ObjectUtil.isNull(dataset)) {
                    var userBO = userUseCase.findByUsername(datasetInitialInfo.getUserName());
                    var requestContext = RequestContextHolder.createEmptyContent();
                    requestContext.setUserInfo(UserInfo.builder().id(userBO.getId()).build());
                    RequestContextHolder.setContext(requestContext);
                    var datasetBO = DatasetBO.builder().name(datasetName).type(datasetInitialInfo.getType()).build();
                    dataset = DefaultConverter.convert(datasetBO, Dataset.class);
                    datasetDAO.save(dataset);
                    var datasetId = dataset.getId();
                    var baseSavePath = String.format("%s%s/", tempPath, UUID.randomUUID().toString().replace("-", ""));
                    var filePath = baseSavePath + FileUtil.getName(file);
                    FileUtil.copy(file.getAbsolutePath(), filePath, true);
                    try {
                        DecompressionFileUtils.decompress(filePath, baseSavePath);
                    } catch (IOException e) {
                        log.error("Decompression file error", e);
                    }
                    var dataInfoUploadBO = DataInfoUploadBO.builder().datasetId(datasetId).type(datasetInitialInfo.getType())
                            .userId(userBO.getId()).savePath(filePath).baseSavePath(baseSavePath).fileName(FileUtil.getPrefix(datasetInitialInfo.getFileName())).build();

                    if (IMAGE.equals(datasetInitialInfo.getType())) {
                        uploadDataUseCase.parseImageCompressedUploadFile(dataInfoUploadBO);
                    } else {
                        uploadDataUseCase.parsePointCloudUploadFile(dataInfoUploadBO);
                    }
                    var datasetClassPropertiesList = datasetInitialInfo.getClasses();
                    datasetClassPropertiesList.forEach(datasetClassProperties -> {
                        if (StrUtil.isEmpty(datasetClassProperties.getToolTypeOptions())) {
                            datasetClassProperties.setToolTypeOptions(null);
                        }
                        if (StrUtil.isEmpty(datasetClassProperties.getAttributes())) {
                            datasetClassProperties.setAttributes(null);
                        }
                    });
                    var datasetClassBOList = DefaultConverter.convert(datasetClassPropertiesList, DatasetClassBO.class);
                    datasetClassBOList.forEach(datasetClassBO -> datasetClassBO.setDatasetId(datasetId));
                    datasetClassDAO.saveBatch(DefaultConverter.convert(datasetClassBOList, DatasetClass.class));
                }
            })));
        }
    }

    public Dataset getInitDataset(DatasetInitialInfo datasetInitialInfo) {
        var datasetName = datasetInitialInfo.getName();
        var datasetLambdaQueryWrapper = Wrappers.lambdaQuery(Dataset.class);
        datasetLambdaQueryWrapper.eq(Dataset::getName, datasetName);
        datasetLambdaQueryWrapper.last("limit 1");
        var dataset = datasetDAO.getOne(datasetLambdaQueryWrapper);
        return dataset;
    }

    /**
     * Save dataset
     *
     * @param bo Dataset information
     */
    public DatasetBO create(DatasetBO bo) {
        if (bo.getSyncMode() == null) {
            bo.setSyncMode(false);
        }
        if (bo.getInferenceMode() == null) {
            bo.setInferenceMode(false);
        }
        validateInferenceConfig(bo.getType(), bo.getSyncMode(), bo.getInferenceMode(), bo.getInferenceConfig(), null);
        var dataset = DefaultConverter.convert(bo, Dataset.class);
        try {
            datasetDAO.save(dataset);
        } catch (DuplicateKeyException e) {
            log.error("Dataset duplicate name", e);
            throw new UsecaseException(UsecaseCode.DATASET_NAME_DUPLICATED);
        }
        return DefaultConverter.convert(dataset, DatasetBO.class);
    }

    /**
     * Dataset update
     *
     * @param id       Dataset id
     * @param updateBO Dataset update information
     */
    public void update(Long id, DatasetBO updateBO) {
        var datasetBO = findById(id);
        if (ObjectUtil.isNull(datasetBO)) {
            throw new UsecaseException(UsecaseCode.DATASET_NOT_FOUND);
        }
        Boolean syncMode = ObjectUtil.defaultIfNull(updateBO.getSyncMode(), datasetBO.getSyncMode());
        Boolean inferenceMode = ObjectUtil.defaultIfNull(updateBO.getInferenceMode(), datasetBO.getInferenceMode());
        DatasetInferenceConfig inferenceConfig = updateBO.getInferenceMode() == null
                ? datasetBO.getInferenceConfig() : updateBO.getInferenceConfig();
        validateInferenceConfig(datasetBO.getType(), syncMode, inferenceMode, inferenceConfig, id);
        datasetBO.setName(updateBO.getName());
        if (updateBO.getDescription() != null) {
            datasetBO.setDescription(updateBO.getDescription());
        }
        datasetBO.setSyncMode(syncMode);
        datasetBO.setInferenceMode(inferenceMode);
        datasetBO.setInferenceConfig(inferenceConfig);
        try {
            var lambdaUpdateWrapper = Wrappers.lambdaUpdate(Dataset.class);
            lambdaUpdateWrapper.eq(Dataset::getId, id);
            lambdaUpdateWrapper.set(Dataset::getName, datasetBO.getName())
                    .set(Dataset::getDescription, datasetBO.getDescription())
                    .set(Dataset::getSyncMode, datasetBO.getSyncMode())
                    .set(Dataset::getInferenceMode, datasetBO.getInferenceMode())
                    .set(Dataset::getInferenceConfig, datasetBO.getInferenceConfig());
            datasetDAO.update(lambdaUpdateWrapper);
        } catch (DuplicateKeyException e) {
            log.error("Dataset duplicate name", e);
            throw new UsecaseException(UsecaseCode.DATASET_NAME_DUPLICATED);
        }
    }

    void validateInferenceConfig(DatasetTypeEnum datasetType, Boolean syncMode, Boolean inferenceMode,
                                 DatasetInferenceConfig config, Long datasetId) {
        if (!Boolean.TRUE.equals(inferenceMode)) {
            return;
        }
        if (!DatasetTypeEnum.LIDAR_FUSION.equals(datasetType) || !Boolean.TRUE.equals(syncMode)) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "inferenceMode requires type=LIDAR_FUSION and syncMode=true");
        }
        if (datasetId == null) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "inferenceMode must be configured after the dataset and its classes are created");
        }
        if (ObjectUtil.isNull(config) || ObjectUtil.isNull(config.getModelId())
                || CollectionUtil.isEmpty(config.getClassMappings())) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "inferenceConfig.modelId and classMappings are required");
        }
        if (!isPositive(config.getSyncDistance())
                || config.getMaxOutsideFrames() == null || config.getMaxOutsideFrames() < 0
                || !isUnitInterval(config.getAssociationIou())
                || !isUnitInterval(config.getMinConfidence())) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "Invalid inferenceConfig thresholds: syncDistance must be > 0, maxOutsideFrames >= 0, "
                            + "associationIou and minConfidence must be within [0, 1]");
        }
        Model model = modelDAO.getById(config.getModelId());
        if (ObjectUtil.isNull(model) || !ModelCodeEnum.LIDAR_DETECTION.equals(model.getModelCode())
                || !(ModelDatasetTypeEnum.LIDAR.equals(model.getDatasetType())
                || ModelDatasetTypeEnum.LIDAR_FUSION.equals(model.getDatasetType()))) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "Configured model is not a compatible point-cloud detection model: modelId=" + config.getModelId());
        }
        Set<String> modelClassCodes = modelClassDAO.list(Wrappers.lambdaQuery(ModelClass.class)
                        .eq(ModelClass::getModelId, config.getModelId()))
                .stream().map(ModelClass::getCode).collect(Collectors.toSet());
        Set<Long> datasetClassIds = datasetClassDAO.list(Wrappers.lambdaQuery(DatasetClass.class)
                        .eq(DatasetClass::getDatasetId, datasetId))
                .stream().map(DatasetClass::getId).collect(Collectors.toSet());
        Set<String> mappedCodes = new HashSet<>();
        for (DatasetInferenceConfig.ClassMapping mapping : config.getClassMappings()) {
            if (mapping == null || StrUtil.isBlank(mapping.getModelClassCode())
                    || mapping.getDatasetClassId() == null || mapping.getMotionMode() == null
                    || !modelClassCodes.contains(mapping.getModelClassCode())
                    || !datasetClassIds.contains(mapping.getDatasetClassId())
                    || !mappedCodes.add(mapping.getModelClassCode())) {
                throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                        "Invalid or duplicate inference class mapping: " + JSONUtil.toJsonStr(mapping));
            }
        }
    }

    private static boolean isPositive(Double value) {
        return value != null && Double.isFinite(value) && value > 0.0;
    }

    private static boolean isUnitInterval(Double value) {
        return value != null && Double.isFinite(value) && value >= 0.0 && value <= 1.0;
    }

    /**
     * Delete dataset
     *
     * @param id Dataset id
     */
    public void delete(Long id) {
        var task = datasetDAO.getById(id);
        if (ObjectUtil.isNull(task)) {
            throw new UsecaseException(UsecaseCode.DATASET_NOT_FOUND);
        }
        datasetDAO.removeById(id);

        executorService.execute(Objects.requireNonNull(TtlRunnable.get(() -> {
            dataInfoDAO.getBaseMapper().deleteByDatasetId(id);
            var dataAnnotationObjectLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataAnnotationObject.class);
            dataAnnotationObjectLambdaUpdateWrapper.eq(DataAnnotationObject::getDatasetId, id);
            dataAnnotationObjectDAO.remove(dataAnnotationObjectLambdaUpdateWrapper);
            var dataAnnotationClassificationLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataAnnotationClassification.class);
            dataAnnotationClassificationLambdaUpdateWrapper.eq(DataAnnotationClassification::getDatasetId, id);
            dataAnnotationClassificationDAO.remove(dataAnnotationClassificationLambdaUpdateWrapper);
        })));
    }

    /**
     * Query dataset by type
     *
     * @param datasetTypes Dataset type
     * @return Dataset page
     */
    public List<DatasetBO> findByType(List<DatasetTypeEnum> datasetTypes) {
        var datasetLambdaQueryWrapper = Wrappers.lambdaQuery(Dataset.class);
        datasetLambdaQueryWrapper.select(Dataset::getId, Dataset::getName);
        datasetLambdaQueryWrapper.in(Dataset::getType, datasetTypes);
        return DefaultConverter.convert(datasetDAO.list(datasetLambdaQueryWrapper), DatasetBO.class);
    }

    /**
     * Paging query dataset
     *
     * @param pageNo   Page number
     * @param pageSize Page size
     * @param queryBO  query parameters object
     * @return Dataset page
     */
    public Page<DatasetBO> findByPage(Integer pageNo, Integer pageSize, DatasetQueryBO queryBO) {
        var lambdaQueryWrapper = Wrappers.lambdaQuery(Dataset.class);
        lambdaQueryWrapper.eq(Dataset::getIsDeleted, false);
        if (StrUtil.isNotBlank(queryBO.getName())) {
            lambdaQueryWrapper.like(Dataset::getName, queryBO.getName());
        }

        if (ObjectUtil.isNotNull(queryBO.getType())) {
            lambdaQueryWrapper.eq(Dataset::getType, queryBO.getType());
        }

        if (ObjectUtil.isNotEmpty(queryBO.getCreateStartTime()) && ObjectUtil.isNotEmpty(queryBO.getCreateEndTime())) {
            lambdaQueryWrapper.ge(Dataset::getCreatedAt, queryBO.getCreateStartTime()).le(Dataset::getCreatedAt, queryBO.getCreateEndTime());
        }

        if (StrUtil.isNotBlank(queryBO.getSortField())) {
            lambdaQueryWrapper.last(" order by " + queryBO.getSortField().toLowerCase() + " " + queryBO.getAscOrDesc());
        }
        var datasetPage = datasetDAO.getBaseMapper().selectDatasetPage(new com.baomidou.mybatisplus.extension.plugins.pagination.Page<>(pageNo, pageSize), lambdaQueryWrapper);
        return DefaultConverter.convert(datasetPage, DatasetBO.class);
    }

    /**
     * Query details based on dataset id
     *
     * @param id Dataset id
     * @return Dataset detail
     */
    public DatasetBO findById(Long id) {
        return DefaultConverter.convert(datasetDAO.getById(id), DatasetBO.class);
    }

    /**
     * Query whether an Ontology exists in the dataset
     *
     * @param datasetId Dataset id
     * @return True means exists
     */
    public Boolean findOntologyIsExistByDatasetId(Long datasetId) {
        var datasetClassLambdaQueryWrapper = Wrappers.lambdaQuery(DatasetClass.class);
        datasetClassLambdaQueryWrapper.eq(DatasetClass::getDatasetId, datasetId);
        var datasetClassCount = datasetClassDAO.count(datasetClassLambdaQueryWrapper);

        var datasetClassificationLambdaQueryWrapper = Wrappers.lambdaQuery(DatasetClassification.class);
        datasetClassificationLambdaQueryWrapper.eq(DatasetClassification::getDatasetId, datasetId);
        var datasetClassificationCount = datasetClassificationDAO.count(datasetClassificationLambdaQueryWrapper);
        return datasetClassCount > 0 || datasetClassificationCount > 0;
    }

    @Transactional(rollbackFor = Exception.class)
    public void createByScenario(DatasetScenarioBO datasetScenarioBO) {
        var datasetBO = DatasetBO.builder().name(datasetScenarioBO.getDatasetName()).type(datasetScenarioBO.getDatasetType()).build();
        var newDatasetBO = create(datasetBO);
        var datasetId = newDatasetBO.getId();
        executorService.execute(Objects.requireNonNull(TtlRunnable.get(() -> {
            datasetClassUseCase.copyClassesToNewDataset(datasetId, datasetScenarioBO.getOntologyClassId(), datasetScenarioBO.getSource());
            var scenarioQueryBO = DefaultConverter.convert(datasetScenarioBO, ScenarioQueryBO.class);
            scenarioQueryBO.setPageSize(PAGE_SIZE_100);
            var i = 1;
            while (true) {
                scenarioQueryBO.setPageNo(i);
                var page = dataAnnotationObjectUseCase.findDataIdByScenarioPage(scenarioQueryBO);
                if (CollectionUtil.isEmpty(page.getList())) {
                    break;
                }
                var dataIds = page.getList().stream().map(DataAnnotationObjectBO::getDataId).collect(Collectors.toList());
                var dataInfoList = dataInfoDAO.getBaseMapper().listByIds(dataIds, false);
                dataInfoList.forEach(dataInfo -> {
                    dataInfo.setId(null);
                    dataInfo.setDatasetId(datasetId);
                    dataInfo.setTempDataId(dataInfo.getId());
                    dataInfo.setCreatedBy(RequestContextHolder.getContext().getUserInfo().getId());
                    dataInfo.setCreatedAt(OffsetDateTime.now());
                    dataInfo.setUpdatedBy(null);
                });
                scenarioQueryBO.setDataIds(dataIds);
                dataInfoDAO.getBaseMapper().insertBatch(dataInfoList);
                var dataInfoMap = dataInfoList.stream().collect(Collectors.toMap(DataInfo::getTempDataId, DataInfo::getId));
                var dataAnnotationObjectBOList = dataAnnotationObjectUseCase.listByScenario(scenarioQueryBO);
                dataAnnotationObjectBOList.forEach(dataAnnotationObjectBO -> {
                    dataAnnotationObjectBO.setId(null);
                    dataAnnotationObjectBO.setDatasetId(datasetId);
                    dataAnnotationObjectBO.setDataId(dataInfoMap.get(dataAnnotationObjectBO.getDataId()));
                    var classId = dataAnnotationObjectBO.getClassId();
                    if (ObjectUtil.isNotNull(classId)) {
                        dataAnnotationObjectBO.setClassId(null);
                        var dataAnnotationResultObjectBO = DefaultConverter.convert(dataAnnotationObjectBO.getClassAttributes(), DataAnnotationResultObjectBO.class);
                        dataAnnotationResultObjectBO.setId(IdUtil.randomUUID());
                        dataAnnotationResultObjectBO.setClassId(null);
                        dataAnnotationResultObjectBO.setClassValues(JSONUtil.createArray());
                        dataAnnotationObjectBO.setClassAttributes(JSONUtil.parseObj(dataAnnotationResultObjectBO));
                    }
                    dataAnnotationObjectBO.setCreatedBy(RequestContextHolder.getContext().getUserInfo().getId());
                    dataAnnotationObjectBO.setCreatedAt(OffsetDateTime.now());
                });
                dataAnnotationObjectDAO.getBaseMapper().insertBatch(DefaultConverter.convert(dataAnnotationObjectBOList, DataAnnotationObject.class));
                i++;
            }
        })));

    }

    public Long countObject(Long datasetId) {
        return datasetDAO.getBaseMapper().countObject(datasetId);
    }

}
