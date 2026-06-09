package ai.basic.x1.adapter.api.job.converter;

import ai.basic.x1.adapter.port.rpc.dto.DataInfo;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingObject;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingReqDTO;
import ai.basic.x1.entity.DataInfoBO;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.PointCloudTrackingParamBO;
import ai.basic.x1.entity.TrackingSeedObjectBO;
import cn.hutool.json.JSONUtil;

import java.util.ArrayList;
import java.util.List;

public class PointCloudTrackingModelReqConverter {

    public static PointCloudTrackingReqDTO buildRequestParam(ModelMessageBO messageBo, DataInfoBO sourceDataInfo) {
        var trackingParam = JSONUtil.toBean(messageBo.getResultFilterParam(), PointCloudTrackingParamBO.class);
        return PointCloudTrackingReqDTO.builder()
                .sourceData(buildDataInfo(sourceDataInfo))
                .targetData(buildDataInfo(messageBo.getDataInfo()))
                .direction(trackingParam.getDirection())
                .objects(toTrackingObjects(trackingParam.getObjects()))
                .build();
    }

    private static List<PointCloudTrackingObject> toTrackingObjects(List<TrackingSeedObjectBO> seeds) {
        var list = new ArrayList<PointCloudTrackingObject>();
        if (seeds == null) {
            return list;
        }
        for (var seed : seeds) {
            var center = seed.getCenter3D();
            var rotation = seed.getRotation3D();
            var size = seed.getSize3D();
            list.add(PointCloudTrackingObject.builder()
                    .trackingId(seed.getTrackingId())
                    .label(seed.getModelClass())
                    .confidence(seed.getConfidence())
                    .x(center != null && center.getX() != null ? center.getX().doubleValue() : null)
                    .y(center != null && center.getY() != null ? center.getY().doubleValue() : null)
                    .z(center != null && center.getZ() != null ? center.getZ().doubleValue() : null)
                    .dimX(size != null && size.getX() != null ? size.getX().doubleValue() : null)
                    .dimY(size != null && size.getY() != null ? size.getY().doubleValue() : null)
                    .dimZ(size != null && size.getZ() != null ? size.getZ().doubleValue() : null)
                    .rotX(rotation != null && rotation.getX() != null ? rotation.getX().doubleValue() : null)
                    .rotY(rotation != null && rotation.getY() != null ? rotation.getY().doubleValue() : null)
                    .rotZ(rotation != null && rotation.getZ() != null ? rotation.getZ().doubleValue() : null)
                    .build());
        }
        return list;
    }

    private static DataInfo buildDataInfo(DataInfoBO dataInfoBO) {
        return PointCloudDetectionModelReqConverter.buildRequestParam(
                ModelMessageBO.builder().dataInfo(dataInfoBO).build()
        ).getDatas().get(0);
    }
}
