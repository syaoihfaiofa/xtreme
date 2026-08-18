package ai.basic.x1.adapter.port.rpc;

import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.rpc.dto.SceneInferenceTrackingDTO;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.core.lang.TypeReference;
import cn.hutool.http.ContentType;
import cn.hutool.http.HttpResponse;
import cn.hutool.http.HttpStatus;
import cn.hutool.http.HttpUtil;
import cn.hutool.json.JSONUtil;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Slf4j
@Component
public class SceneInferenceTrackingHttpCaller {

    private static final int MAX_ATTEMPTS = 3;
    private static final long INITIAL_BACKOFF_MS = 200L;

    @Value("${pointCloud.sceneInferenceTracking.url:http://point-cloud-object-tracking:5000/pointCloud/associate}")
    private String url;

    public SceneInferenceTrackingDTO.Response associate(SceneInferenceTrackingDTO.Request request) {
        String requestBody = JSONUtil.toJsonStr(request);
        String lastError = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                HttpResponse response = HttpUtil.createPost(url)
                        .body(requestBody, ContentType.JSON.getValue())
                        .timeout(120_000)
                        .execute();
                String responseBody = response.body();
                if (response.getStatus() != HttpStatus.HTTP_OK) {
                    throw new UsecaseException("Tracking service returned non-200 response: url=" + url
                            + ", status=" + response.getStatus() + ", body=" + responseBody);
                }
                ApiResult<SceneInferenceTrackingDTO.Response> result = JSONUtil.toBean(
                        responseBody, new TypeReference<ApiResult<SceneInferenceTrackingDTO.Response>>() {
                        }, false);
                if (result == null || result.getCode() != UsecaseCode.OK || result.getData() == null) {
                    throw new UsecaseException("Tracking service returned an invalid result: url=" + url
                            + ", body=" + responseBody);
                }
                return result.getData();
            } catch (RuntimeException exception) {
                lastError = exception.getMessage();
                log.warn("Scene inference tracking call failed: attempt={}, maxAttempts={}, url={}, error={}",
                        attempt, MAX_ATTEMPTS, url, lastError);
                if (attempt < MAX_ATTEMPTS) {
                    sleepBeforeRetry(INITIAL_BACKOFF_MS << (attempt - 1));
                }
            }
        }
        throw new UsecaseException("Tracking service failed after retries: attempts=" + MAX_ATTEMPTS
                + ", url=" + url + ", request=" + requestBody + ", error=" + lastError);
    }

    private static void sleepBeforeRetry(long delayMs) {
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new UsecaseException("Tracking retry interrupted: delayMs=" + delayMs);
        }
    }
}
