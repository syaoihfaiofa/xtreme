package ai.basic.x1.adapter.api.job;

import ai.basic.x1.adapter.api.job.converter.ImageKeypointLiftedModelResultConverter;
import ai.basic.x1.adapter.api.job.converter.ParkingSlotDetectionModelReqConverter;
import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.dto.PreModelParamDTO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelClass;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelDatasetResult;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelRunRecord;
import ai.basic.x1.adapter.port.rpc.ParkingSlotDetectionHttpCaller;
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

/** Persists CenterNet stitched-image detections as four-vertex ground polygons. */
public class ParkingSlotDetectionModelMessageHandler
        extends AbstractModelMessageHandler<List<ImageKeypointLiftedDetectionRespDTO>> {
    @Autowired private ParkingSlotDetectionHttpCaller modelHttpCaller;
    @Autowired private ModelUseCase modelUseCase;

    @Override
    public ModelTaskInfoBO modelRun(ModelMessageBO message) {
        if (!ParkingSlotDetectionModelReqConverter.hasStitchedImage(message.getDataInfo())) {
            return ImageKeypointLiftedObjectBO.builder().dataId(message.getDataId())
                    .code(UsecaseCode.OK.getCode()).message("skipped: no stitched_img for this frame")
                    .objects(List.of()).build();
        }
        ApiResult<List<ImageKeypointLiftedDetectionRespDTO>> response = getRetryAbleApiResult(message);
        Map<String, ModelClass> classes = modelUseCase.getModelClassMapByModelId(message.getModelId());
        PreModelParamDTO filter = JSONUtil.isNull(message.getResultFilterParam()) ? null
                : JSONUtil.toBean(message.getResultFilterParam(), PreModelParamDTO.class);
        return ImageKeypointLiftedModelResultConverter.convert(response, classes, filter);
    }

    @Override
    ApiResult<List<ImageKeypointLiftedDetectionRespDTO>> callRemoteService(ModelMessageBO message) {
        try {
            return modelHttpCaller.call(ParkingSlotDetectionModelReqConverter.convert(message), message.getUrl());
        } catch (IOException exception) {
            throw new UsecaseException(UsecaseCode.UNKNOWN, "parking-slot model request failed for dataId="
                    + message.getDataId() + ": " + exception.getMessage());
        }
    }

    @Override
    public void syncModelAnnotationResult(ModelTaskInfoBO task, ModelMessageBO message) {
        ImageKeypointLiftedObjectBO result = (ImageKeypointLiftedObjectBO) task;
        if (CollUtil.isEmpty(result.getObjects())) return;
        ModelRunRecord run = modelRunRecordDAO.getOne(Wrappers.lambdaQuery(ModelRunRecord.class)
                .eq(ModelRunRecord::getModelSerialNo, message.getModelSerialNo()).last("limit 1"));
        List<DataAnnotationObjectBO> annotations = new ArrayList<>(result.getObjects().size());
        for (ImageKeypointLiftedObjectBO.ObjectBO object : result.getObjects()) {
            annotations.add(DataAnnotationObjectBO.builder().datasetId(message.getDatasetId()).dataId(result.getDataId())
                    .classAttributes(JSONUtil.parseObj(object)).sourceType(DataAnnotationObjectSourceTypeEnum.MODEL)
                    .sourceId(run.getId()).build());
        }
        dataAnnotationObjectDAO.saveBatch(DefaultConverter.convert(annotations, DataAnnotationObject.class));
    }

    @Override public void assembleCalculateMetricsData(List<ModelDatasetResult> results, List<DataAnnotationObject> objects, String truth, String output) { }
    @Override public String getResultEvaluateUrl() { return ""; }
    @Override public ModelCodeEnum getModelCodeEnum() { return ModelCodeEnum.PARKING_SLOT_DETECTION; }
}
