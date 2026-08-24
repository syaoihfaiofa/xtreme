package ai.basic.x1.util;

import ai.basic.x1.entity.enums.ModelCodeEnum;
import cn.hutool.json.JSONUtil;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ModelParamUtilsTest {

    @Test
    void valid_acceptsImageKeypointLiftedDetectionFilter() {
        assertDoesNotThrow(() -> ModelParamUtils.valid(
                JSONUtil.parseObj("{\"classes\":[\"car\"],\"minConfidence\":0.5,\"maxConfidence\":0.9}"),
                ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION));
    }

    @Test
    void valid_rejectsInvalidImageKeypointLiftedDetectionFilter() {
        assertThrows(RuntimeException.class, () -> ModelParamUtils.valid(
                JSONUtil.parseObj("{\"classes\":[],\"minConfidence\":1.1}"),
                ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION));
    }

    @Test
    void valid_acceptsSceneTrackingMappingsForKeypointLifted() {
        assertDoesNotThrow(() -> ModelParamUtils.valid(
                JSONUtil.parseObj("{"
                        + "\"classes\":[\"pillar\"],"
                        + "\"minConfidence\":0.5,"
                        + "\"maxConfidence\":1,"
                        + "\"associationIou\":0.3,"
                        + "\"classMappings\":[{"
                        + "\"modelClassCode\":\"pillar\","
                        + "\"datasetClassId\":12,"
                        + "\"motionMode\":\"STATIC\"}]"
                        + "}"),
                ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION));
    }

    @Test
    void valid_acceptsSceneTrackingMappingWithoutDatasetClassId() {
        assertDoesNotThrow(() -> ModelParamUtils.valid(
                JSONUtil.parseObj("{"
                        + "\"classes\":[\"pillar\"],"
                        + "\"minConfidence\":0.5,"
                        + "\"maxConfidence\":1,"
                        + "\"classMappings\":[{"
                        + "\"modelClassCode\":\"pillar\","
                        + "\"motionMode\":\"STATIC\"}]"
                        + "}"),
                ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION));
    }
}
