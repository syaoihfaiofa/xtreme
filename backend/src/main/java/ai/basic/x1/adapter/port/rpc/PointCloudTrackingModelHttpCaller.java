package ai.basic.x1.adapter.port.rpc;

import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingReqDTO;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingRespDTO;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.core.date.StopWatch;
import cn.hutool.core.lang.TypeReference;
import cn.hutool.http.ContentType;
import cn.hutool.http.HttpRequest;
import cn.hutool.http.HttpResponse;
import cn.hutool.http.HttpStatus;
import cn.hutool.http.HttpUtil;
import cn.hutool.json.JSONUtil;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
@Slf4j
public class PointCloudTrackingModelHttpCaller {

    public ApiResult<List<PointCloudTrackingRespDTO>> callTrackingModel(PointCloudTrackingReqDTO reqDTO, String url) {
        try {
            StopWatch stopWatch = new StopWatch();
            stopWatch.start();
            String requestBody = JSONUtil.toJsonStr(reqDTO);
            HttpRequest httpRequest = HttpUtil.createPost(url)
                    .body(requestBody, ContentType.JSON.getValue());
            HttpResponse httpResponse = httpRequest.execute();
            stopWatch.stop();
            log.info(String.format("call trackingModelService took: %dms,req:%s ,resp:%s",
                    stopWatch.getLastTaskTimeMillis(), requestBody, httpResponse.body()));
            if (httpResponse.getStatus() == HttpStatus.HTTP_OK) {
                return JSONUtil.toBean(httpResponse.body(), new TypeReference<>() {
                }, false);
            }
            throw new UsecaseException("trackingModel run error!");
        } catch (Throwable throwable) {
            log.error("call tracking-model service error.", throwable);
            throw new UsecaseException("trackingModel run error!");
        }
    }
}
