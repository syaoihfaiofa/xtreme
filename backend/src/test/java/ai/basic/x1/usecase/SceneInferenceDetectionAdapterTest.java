package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionRespDTO;
import ai.basic.x1.adapter.port.rpc.dto.SceneInferenceTrackingDTO;
import ai.basic.x1.entity.DatasetInferenceConfig;
import ai.basic.x1.entity.PointBO;
import ai.basic.x1.entity.enums.InferenceMotionModeEnum;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

class SceneInferenceDetectionAdapterTest {

    @Test
    void toTrackingObjects_mapsKeypointLiftedCenterSizeRotation() {
        ImageKeypointLiftedDetectionRespDTO.ObjectDTO detection =
                ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                        .modelClass("pillar")
                        .confidence(new BigDecimal("0.88"))
                        .center3D(point("1.0", "2.0", "0.5"))
                        .size3D(point("0.4", "0.4", "1.2"))
                        .rotation3D(point("0.0", "0.0", "0.3"))
                        .build();

        List<SceneInferenceTrackingDTO.Object> objects =
                SceneInferenceDetectionAdapter.fromKeypointLifted(
                        9L, 3, 90L, List.of(detection),
                        Map.of("pillar", mapping()), 0.5);

        assertEquals(1, objects.size());
        assertEquals("9-3-0", objects.get(0).getPredictionId());
        assertEquals(1.0, objects.get(0).getX());
        assertEquals(InferenceMotionModeEnum.STATIC, objects.get(0).getMotionMode());
    }

    @Test
    void toTrackingObjects_skipsBelowConfidence() {
        ImageKeypointLiftedDetectionRespDTO.ObjectDTO detection =
                ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                        .modelClass("pillar")
                        .confidence(new BigDecimal("0.2"))
                        .center3D(point("1", "0", "0"))
                        .size3D(point("1", "1", "1"))
                        .rotation3D(point("0", "0", "0"))
                        .build();

        assertEquals(List.of(), SceneInferenceDetectionAdapter.fromKeypointLifted(
                1L, 0, 10L, List.of(detection),
                Map.of("pillar", mapping()), 0.5));
    }

    @Test
    void toTrackingObjects_skipsGroundPolylinePredictions() {
        ImageKeypointLiftedDetectionRespDTO.ObjectDTO prediction =
                ImageKeypointLiftedDetectionRespDTO.ObjectDTO.builder()
                        .objType("GROUND_POLYLINE")
                        .modelClass("barrier_side_edge")
                        .confidence(new BigDecimal("0.9"))
                        .points(List.of(
                                point("1", "2", "0"),
                                point("2", "3", "0")))
                        .build();

        assertEquals(List.of(), SceneInferenceDetectionAdapter.fromKeypointLifted(
                1L, 0, 10L, List.of(prediction),
                Map.of("barrier_side_edge", mapping()), 0.5));
    }

    private static DatasetInferenceConfig.ClassMapping mapping() {
        return DatasetInferenceConfig.ClassMapping.builder()
                .modelClassCode("pillar")
                .datasetClassId(12L)
                .motionMode(InferenceMotionModeEnum.STATIC)
                .build();
    }

    private static PointBO point(String x, String y, String z) {
        return PointBO.builder()
                .x(new BigDecimal(x))
                .y(new BigDecimal(y))
                .z(new BigDecimal(z))
                .build();
    }
}
