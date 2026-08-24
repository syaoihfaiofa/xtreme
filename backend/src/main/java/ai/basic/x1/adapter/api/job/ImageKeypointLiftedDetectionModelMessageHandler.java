package ai.basic.x1.adapter.api.job;

import ai.basic.x1.adapter.api.job.converter.ImageKeypointLiftedModelReqConverter;
import ai.basic.x1.adapter.api.job.converter.ImageKeypointLiftedModelResultConverter;
import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.dto.PreModelParamDTO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelClass;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelDatasetResult;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelRunRecord;
import ai.basic.x1.adapter.port.rpc.ImageKeypointLiftedDetectionHttpCaller;
import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionRespDTO;
import ai.basic.x1.entity.DataAnnotationObjectBO;
import ai.basic.x1.entity.ImageKeypointLiftedObjectBO;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.ModelTaskInfoBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.ModelCodeEnum;
import ai.basic.x1.usecase.ModelUseCase;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import ai.basic.x1.util.DefaultConverter;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.springframework.beans.factory.annotation.Autowired;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class ImageKeypointLiftedDetectionModelMessageHandler
        extends AbstractModelMessageHandler<List<ImageKeypointLiftedDetectionRespDTO>> {

    @Autowired
    private ImageKeypointLiftedDetectionHttpCaller modelHttpCaller;

    @Autowired
    private ModelUseCase modelUseCase;

    @Override
    public ModelTaskInfoBO modelRun(ModelMessageBO message) {
        ApiResult<List<ImageKeypointLiftedDetectionRespDTO>> apiResult = getRetryAbleApiResult(message);
        Map<String, ModelClass> modelClassMap = modelUseCase.getModelClassMapByModelId(message.getModelId());
        PreModelParamDTO filterCondition = JSONUtil.isNull(message.getResultFilterParam())
                ? null
                : JSONUtil.toBean(message.getResultFilterParam(), PreModelParamDTO.class);
        return ImageKeypointLiftedModelResultConverter.convert(
                apiResult, modelClassMap, filterCondition);
    }

    @Override
    ApiResult<List<ImageKeypointLiftedDetectionRespDTO>> callRemoteService(ModelMessageBO message) {
        try {
            return modelHttpCaller.call(ImageKeypointLiftedModelReqConverter.convert(message), message.getUrl());
        } catch (IOException exception) {
            throw new UsecaseException(UsecaseCode.UNKNOWN,
                    "keypoint-lifted model request failed for dataId=" + message.getDataId()
                            + ", url=" + message.getUrl() + ": " + exception.getMessage());
        }
    }

    @Override
    public void syncModelAnnotationResult(ModelTaskInfoBO modelTaskInfo, ModelMessageBO message) {
        ImageKeypointLiftedObjectBO modelResult = (ImageKeypointLiftedObjectBO) modelTaskInfo;
        if (CollUtil.isEmpty(modelResult.getObjects())) {
            return;
        }
        ModelRunRecord modelRunRecord = modelRunRecordDAO.getOne(
                Wrappers.lambdaQuery(ModelRunRecord.class)
                        .eq(ModelRunRecord::getModelSerialNo, message.getModelSerialNo())
                        .last("limit 1"));
        List<DataAnnotationObjectBO> annotations = new ArrayList<>(modelResult.getObjects().size());
        for (ImageKeypointLiftedObjectBO.ObjectBO object : modelResult.getObjects()) {
            annotations.add(DataAnnotationObjectBO.builder()
                    .datasetId(message.getDatasetId())
                    .dataId(modelResult.getDataId())
                    .classAttributes(JSONUtil.parseObj(object))
                    .sourceType(DataAnnotationObjectSourceTypeEnum.MODEL)
                    .sourceId(modelRunRecord.getId())
                    .build());
        }
        dataAnnotationObjectDAO.saveBatch(DefaultConverter.convert(annotations, DataAnnotationObject.class));
    }

    @Override
    public void assembleCalculateMetricsData(
            List<ModelDatasetResult> modelDatasetResults,
            List<DataAnnotationObject> dataAnnotationObjectList,
            String groundTruthFilePath,
            String modelRunFilePath) {
    }

    @Override
    public String getResultEvaluateUrl() {
        return "";
    }

    @Override
    public ModelCodeEnum getModelCodeEnum() {
        return ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION;
    }
}
