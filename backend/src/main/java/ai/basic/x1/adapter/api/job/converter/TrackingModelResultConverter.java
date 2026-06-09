package ai.basic.x1.adapter.api.job.converter;

import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingObject;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingRespDTO;
import ai.basic.x1.entity.PointBO;
import ai.basic.x1.entity.PointCloudTrackingObjectBO;
import ai.basic.x1.entity.TrackingObjectBO;
import ai.basic.x1.usecase.exception.UsecaseCode;
import cn.hutool.core.collection.CollUtil;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

public class TrackingModelResultConverter {

    public static PointCloudTrackingObjectBO trackingModelResultConverter(
            ApiResult<List<PointCloudTrackingRespDTO>> apiResult, Long dataId) {
        var builder = PointCloudTrackingObjectBO.builder();
        if (apiResult.getCode() == UsecaseCode.OK && CollUtil.isNotEmpty(apiResult.getData())) {
            var resp = apiResult.getData().get(0);
            builder.dataId(dataId)
                    .code(resp.getCode())
                    .message(resp.getMessage());
            if (UsecaseCode.OK.getCode().equals(resp.getCode())) {
                builder.objects(toTrackingObjectBOs(resp.getObjects()));
            }
        } else {
            builder.code(UsecaseCode.ERROR.getCode()).message(apiResult.getMessage());
        }
        return builder.build();
    }

    private static List<TrackingObjectBO> toTrackingObjectBOs(List<PointCloudTrackingObject> objects) {
        var list = new ArrayList<TrackingObjectBO>();
        if (CollUtil.isEmpty(objects)) {
            return list;
        }
        for (var obj : objects) {
            list.add(TrackingObjectBO.builder()
                    .trackingId(obj.getTrackingId())
                    .modelClass(obj.getLabel())
                    .confidence(obj.getConfidence())
                    .type("3D_BOX")
                    .center3D(toPoint(obj.getX(), obj.getY(), obj.getZ()))
                    .rotation3D(toPoint(obj.getRotX(), obj.getRotY(), obj.getRotZ()))
                    .size3D(toPoint(obj.getDimX(), obj.getDimY(), obj.getDimZ()))
                    .build());
        }
        return list;
    }

    private static PointBO toPoint(Double x, Double y, Double z) {
        return PointBO.builder()
                .x(x != null ? BigDecimal.valueOf(x) : null)
                .y(y != null ? BigDecimal.valueOf(y) : null)
                .z(z != null ? BigDecimal.valueOf(z) : null)
                .build();
    }
}
