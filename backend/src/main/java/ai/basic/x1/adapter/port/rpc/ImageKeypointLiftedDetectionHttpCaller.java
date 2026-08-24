package ai.basic.x1.adapter.port.rpc;

import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionReqDTO;
import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionRespDTO;
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
public class ImageKeypointLiftedDetectionHttpCaller {
    private static final int CONNECTION_TIMEOUT_MILLIS = 10_000;
    private static final int READ_TIMEOUT_MILLIS = 120_000;

    @Autowired
    private ObjectMapper objectMapper;

    public ApiResult<List<ImageKeypointLiftedDetectionRespDTO>> call(
            ImageKeypointLiftedDetectionReqDTO request,
            String url) throws IOException {
        String requestBody = objectMapper.writeValueAsString(request);
        var response = HttpUtil.createPost(url)
                .body(requestBody, ContentType.JSON.getValue())
                .setConnectionTimeout(CONNECTION_TIMEOUT_MILLIS)
                .setReadTimeout(READ_TIMEOUT_MILLIS)
                .execute();
        if (response.getStatus() != HttpStatus.HTTP_OK) {
            throw new UsecaseException("keypoint-lifted model request failed: status="
                    + response.getStatus() + ", response=" + response.body());
        }
        return objectMapper.readValue(response.bodyBytes(),
                new TypeReference<ApiResult<List<ImageKeypointLiftedDetectionRespDTO>>>() {
                });
    }
}
