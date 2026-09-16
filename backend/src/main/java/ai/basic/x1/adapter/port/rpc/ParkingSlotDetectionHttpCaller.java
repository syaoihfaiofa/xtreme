package ai.basic.x1.adapter.port.rpc;

import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionRespDTO;
import ai.basic.x1.adapter.port.rpc.dto.ParkingSlotDetectionReqDTO;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.http.ContentType;
import cn.hutool.http.HttpStatus;
import cn.hutool.http.HttpUtil;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.util.List;

@Component
public class ParkingSlotDetectionHttpCaller {
    @Autowired private ObjectMapper objectMapper;

    public ApiResult<List<ImageKeypointLiftedDetectionRespDTO>> call(ParkingSlotDetectionReqDTO request, String url) throws IOException {
        var response = HttpUtil.createPost(url)
                .body(objectMapper.writeValueAsString(request), ContentType.JSON.getValue())
                .setConnectionTimeout(10_000).setReadTimeout(120_000).execute();
        if (response.getStatus() != HttpStatus.HTTP_OK) {
            throw new UsecaseException("parking-slot model request failed: status=" + response.getStatus() + ", response=" + response.body());
        }
        return objectMapper.readValue(response.bodyBytes(), new TypeReference<ApiResult<List<ImageKeypointLiftedDetectionRespDTO>>>() { });
    }
}
