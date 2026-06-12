package ai.basic.x1.adapter.port.rpc;

import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingReqDTO;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingRespDTO;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.date.StopWatch;
import cn.hutool.core.lang.TypeReference;
import cn.hutool.http.ContentType;
import cn.hutool.http.HttpRequest;
import cn.hutool.http.HttpResponse;
import cn.hutool.http.HttpStatus;
import cn.hutool.http.HttpUtil;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
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
                return normalizeTrackingHttpBody(httpResponse.body());
            }
            throw new UsecaseException("trackingModel run error!");
        } catch (Throwable throwable) {
            log.error("call tracking-model service error.", throwable);
            throw new UsecaseException("trackingModel run error!");
        }
    }

    /**
     * Normalizes Flask-style tracking JSON ({@code "code":"OK"}, string enums) into {@link ApiResult}
     * for downstream retry/converter logic. Hutool {@code toBean} often leaves {@code code} null
     * and/or drops the generic {@code data} list.
     */
    static ApiResult<List<PointCloudTrackingRespDTO>> normalizeTrackingHttpBody(String body) {
        JSONObject root = JSONUtil.parseObj(body);
        String codeStr = root.getStr("code");
        JSONArray dataArr = root.getJSONArray("data");

        ApiResult<List<PointCloudTrackingRespDTO>> apiResult = JSONUtil.toBean(body, new TypeReference<>() {
        }, false);
        if (apiResult == null) {
            apiResult = new ApiResult<>();
        }
        if (UsecaseCode.OK.getCode().equalsIgnoreCase(codeStr)) {
            apiResult.setCode(UsecaseCode.OK);
        }
        if (CollUtil.isEmpty(apiResult.getData()) && dataArr != null && !dataArr.isEmpty()) {
            List<PointCloudTrackingRespDTO> list = JSONUtil.toList(dataArr, PointCloudTrackingRespDTO.class);
            apiResult.setData(list);
        }
        return apiResult;
    }
}
