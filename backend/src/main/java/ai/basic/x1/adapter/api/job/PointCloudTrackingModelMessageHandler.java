package ai.basic.x1.adapter.api.job;

import ai.basic.x1.adapter.api.job.converter.PointCloudTrackingModelReqConverter;
import ai.basic.x1.adapter.api.job.converter.TrackingModelResultConverter;
import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelDatasetResult;
import ai.basic.x1.adapter.port.rpc.PointCloudTrackingModelHttpCaller;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingRespDTO;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.ModelTaskInfoBO;
import ai.basic.x1.entity.PointCloudTrackingParamBO;
import ai.basic.x1.entity.enums.ModelCodeEnum;
import ai.basic.x1.usecase.DataInfoUseCase;
import cn.hutool.json.JSONUtil;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;

import java.util.List;

@Slf4j
public class PointCloudTrackingModelMessageHandler extends AbstractModelMessageHandler<List<PointCloudTrackingRespDTO>> {

    @Autowired
    private PointCloudTrackingModelHttpCaller trackingModelHttpCaller;

    @Autowired
    private DataInfoUseCase dataInfoUseCase;

    @Value("${pointCloud.resultEvaluate.url:}")
    private String resultEvaluateUrl;

    @Override
    public ModelTaskInfoBO modelRun(ModelMessageBO modelMessageBO) {
        ApiResult<List<PointCloudTrackingRespDTO>> apiResult = getRetryAbleApiResult(modelMessageBO);
        return TrackingModelResultConverter.trackingModelResultConverter(apiResult, modelMessageBO.getDataId());
    }

    @Override
    ApiResult<List<PointCloudTrackingRespDTO>> callRemoteService(ModelMessageBO modelMessageBO) {
        var trackingParam = JSONUtil.toBean(modelMessageBO.getResultFilterParam(), PointCloudTrackingParamBO.class);
        var sourceList = dataInfoUseCase.listRelationByIds(List.of(trackingParam.getSourceDataId()), false);
        var sourceDataInfo = sourceList.get(0);
        return trackingModelHttpCaller.callTrackingModel(
                PointCloudTrackingModelReqConverter.buildRequestParam(modelMessageBO, sourceDataInfo),
                modelMessageBO.getUrl());
    }

    @Override
    public void syncModelAnnotationResult(ModelTaskInfoBO modelTaskInfo, ModelMessageBO modelMessage) {
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
        return resultEvaluateUrl;
    }

    @Override
    public ModelCodeEnum getModelCodeEnum() {
        return ModelCodeEnum.LIDAR_TRACKING;
    }
}
