package ai.basic.x1.adapter.port.rpc;

import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.rpc.dto.PointCloudTrackingRespDTO;
import ai.basic.x1.usecase.exception.UsecaseCode;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class PointCloudTrackingModelHttpCallerTest {

    /** Same shape as {@code deploy/point-cloud-object-tracking/app.py} success payload. */
    private static final String FLASK_OK_BODY =
            "{\"code\":\"OK\",\"message\":\"\",\"data\":[{\"id\":1002,\"code\":\"OK\",\"message\":\"\","
                    + "\"objects\":[{\"trackingId\":\"track-1\",\"label\":\"car\",\"confidence\":0.9,"
                    + "\"x\":1.5,\"y\":2,\"z\":3,\"dimX\":4,\"dimY\":2,\"dimZ\":1.5,"
                    + "\"rotX\":0,\"rotY\":0,\"rotZ\":0}]}]}";

    @Test
    void normalizeTrackingHttpBody_setsOkEnumAndParsesDataList() {
        ApiResult<List<PointCloudTrackingRespDTO>> r =
                PointCloudTrackingModelHttpCaller.normalizeTrackingHttpBody(FLASK_OK_BODY);
        assertEquals(UsecaseCode.OK, r.getCode(), "Hutool often leaves code null for string OK in JSON");
        assertNotNull(r.getData());
        assertEquals(1, r.getData().size());
        PointCloudTrackingRespDTO first = r.getData().get(0);
        assertEquals("OK", first.getCode());
        assertNotNull(first.getObjects());
        assertEquals(1, first.getObjects().size());
        assertEquals("track-1", first.getObjects().get(0).getTrackingId());
    }
}
