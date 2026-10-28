package ai.basic.x1.usecase;

import cn.hutool.json.JSONObject;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class DataAnnotationObjectUseCaseTest {

    @Test
    void normalizeMissingBoxType_setsThreeDBoxForBoxGeometry() {
        JSONObject attributes = new JSONObject().set("contour", new JSONObject()
                .set("center3D", new JSONObject())
                .set("size3D", new JSONObject()));

        DataAnnotationObjectUseCase.normalizeMissingBoxType(attributes);

        assertEquals("3D_BOX", attributes.getStr("type"));
    }
}
