package ai.basic.x1.usecase;

import ai.basic.x1.entity.DatasetInferenceConfig;
import ai.basic.x1.entity.enums.InferenceMotionModeEnum;
import ai.basic.x1.entity.enums.ModelCodeEnum;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SceneInferenceUseCaseTest {

    private static final double TOLERANCE = 1.0e-9;

    @Test
    void test_bevIou_returnsExactConfiguredBoundary() {
        SceneInferenceFinalizer.Box first = new SceneInferenceFinalizer.Box(0.0, 0.0, 2.0, 2.0, 0.0);
        SceneInferenceFinalizer.Box second =
                new SceneInferenceFinalizer.Box(14.0 / 13.0, 0.0, 2.0, 2.0, 0.0);

        assertEquals(0.3, SceneInferenceFinalizer.bevIou(first, second), TOLERANCE);
    }

    @Test
    void test_configHash_isStableAndChangesWithMapping() {
        DatasetInferenceConfig first = config(10L);
        DatasetInferenceConfig same = config(10L);
        DatasetInferenceConfig changed = config(11L);

        assertEquals(SceneInferenceUseCase.configHash(first), SceneInferenceUseCase.configHash(same));
        assertNotEquals(SceneInferenceUseCase.configHash(first), SceneInferenceUseCase.configHash(changed));
    }

    @Test
    void test_supportsSceneTracking_allowsThreeDimensionalDetectionModels() {
        assertTrue(SceneInferenceUseCase.supportsSceneTracking(ModelCodeEnum.LIDAR_DETECTION));
        assertTrue(SceneInferenceUseCase.supportsSceneTracking(
                ModelCodeEnum.IMAGE_KEYPOINT_LIFTED_DETECTION));
        assertFalse(SceneInferenceUseCase.supportsSceneTracking(ModelCodeEnum.IMAGE_DETECTION));
    }

    private static DatasetInferenceConfig config(Long datasetClassId) {
        return DatasetInferenceConfig.builder()
                .modelId(3L)
                .syncDistance(12.0)
                .maxOutsideFrames(50)
                .associationIou(0.3)
                .minConfidence(0.5)
                .classMappings(List.of(DatasetInferenceConfig.ClassMapping.builder()
                        .modelClassCode("car")
                        .datasetClassId(datasetClassId)
                        .motionMode(InferenceMotionModeEnum.DYNAMIC_FIXED_SIZE)
                        .build()))
                .build();
    }
}
