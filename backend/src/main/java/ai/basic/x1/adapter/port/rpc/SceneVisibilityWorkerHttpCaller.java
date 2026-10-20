package ai.basic.x1.adapter.port.rpc;

import ai.basic.x1.adapter.port.rpc.dto.SceneVisibilityManifestDTO;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.http.ContentType;
import cn.hutool.http.HttpResponse;
import cn.hutool.http.HttpStatus;
import cn.hutool.http.HttpUtil;
import cn.hutool.json.JSONUtil;
import cn.hutool.json.JSONObject;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;

@Slf4j
@Component
public class SceneVisibilityWorkerHttpCaller {

    private static final int MAX_ATTEMPTS = 3;
    private static final long INITIAL_BACKOFF_MS = 200L;
    private static final int RUN_TIMEOUT_MS = 3_600_000;

    @Value("${visibility.worker.url:http://occ-worker:8080/runs}")
    private String url;

    @Value("${visibility.worker.shared-secret}")
    private String sharedSecret;

    @PostConstruct
    void validateSharedSecret() {
        sharedSecret = requireSharedSecret(sharedSecret);
    }

    static String requireSharedSecret(String value) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(
                    "visibility.worker.shared-secret must be configured with a non-blank value");
        }
        return value;
    }

    public SceneVisibilityManifestDTO.Response submit(SceneVisibilityManifestDTO.Manifest manifest) {
        String requestBody = JSONUtil.toJsonStr(manifest);
        String lastError = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                HttpResponse response = HttpUtil.createPost(url)
                        .header("X-Xtreme-Occ-Worker-Secret", sharedSecret)
                        .body(requestBody, ContentType.JSON.getValue())
                        .timeout(RUN_TIMEOUT_MS)
                        .execute();
                String responseBody = response.body();
                if (response.getStatus() != HttpStatus.HTTP_OK) {
                    throw new UsecaseException("Visibility worker returned a non-200 response: url=" + url
                            + ", status=" + response.getStatus() + ", body=" + responseBody
                            + ", request=" + requestBody);
                }
                SceneVisibilityManifestDTO.Response result =
                        JSONUtil.toBean(responseBody, SceneVisibilityManifestDTO.Response.class);
                if (result == null || result.getFrameCount() == null) {
                    throw new UsecaseException("Visibility worker returned an invalid response: url=" + url
                            + ", status=" + response.getStatus() + ", body=" + responseBody
                            + ", request=" + requestBody);
                }
                return result;
            } catch (RuntimeException exception) {
                lastError = exception.getMessage();
                log.warn("Visibility worker call failed: attempt={}, maxAttempts={}, url={}, error={}",
                        attempt, MAX_ATTEMPTS, url, lastError);
                if (attempt < MAX_ATTEMPTS) {
                    sleepBeforeRetry(INITIAL_BACKOFF_MS << (attempt - 1));
                }
            }
        }
        throw new UsecaseException("Visibility worker failed after retries: attempts=" + MAX_ATTEMPTS
                + ", url=" + url + ", request=" + requestBody + ", error=" + lastError);
    }

    public JSONObject occVisualization(String objectKey, Integer maxVoxels) {
        return occVisualization(objectKey, maxVoxels, "semantic");
    }

    public JSONObject occVisualization(String objectKey, Integer maxVoxels, String layer) {
        String requestUrl = occVisualizationUrl();
        String lastError = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                var request = HttpUtil.createGet(requestUrl)
                        .header("X-Xtreme-Occ-Worker-Secret", sharedSecret)
                        .form("objectKey", objectKey)
                        .form("layer", layer)
                        .timeout(600_000);
                if (maxVoxels != null) {
                    request.form("maxVoxels", maxVoxels);
                }
                HttpResponse response = request.execute();
                String responseBody = response.body();
                if (response.getStatus() != HttpStatus.HTTP_OK) {
                    throw new UsecaseException(
                            "Visibility worker returned a non-200 OCC response: url=" + requestUrl
                                    + ", status=" + response.getStatus() + ", body=" + responseBody
                                    + ", objectKey=" + objectKey + ", maxVoxels=" + maxVoxels
                                    + ", layer=" + layer);
                }
                return JSONUtil.parseObj(responseBody);
            } catch (RuntimeException exception) {
                lastError = exception.getMessage();
                log.warn(
                        "Visibility worker OCC call failed: attempt={}, maxAttempts={}, url={}, "
                                + "objectKey={}, maxVoxels={}, layer={}, error={}",
                        attempt, MAX_ATTEMPTS, requestUrl, objectKey, maxVoxels, layer, lastError);
                if (attempt < MAX_ATTEMPTS) {
                    sleepBeforeRetry(INITIAL_BACKOFF_MS << (attempt - 1));
                }
            }
        }
        throw new UsecaseException(
                "Visibility worker OCC call failed after retries: attempts=" + MAX_ATTEMPTS
                        + ", url=" + requestUrl + ", objectKey=" + objectKey
                        + ", maxVoxels=" + maxVoxels + ", layer=" + layer + ", error=" + lastError);
    }

    private String occVisualizationUrl() {
        String normalizedUrl = url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
        String baseUrl = normalizedUrl.endsWith("/runs")
                ? normalizedUrl.substring(0, normalizedUrl.length() - "/runs".length())
                : normalizedUrl;
        return baseUrl + "/occ-visualization";
    }

    private static void sleepBeforeRetry(long delayMs) {
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new UsecaseException("Visibility worker retry interrupted: delayMs=" + delayMs);
        }
    }
}
