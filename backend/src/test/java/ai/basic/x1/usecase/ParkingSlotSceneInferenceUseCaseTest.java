package ai.basic.x1.usecase;

import org.junit.jupiter.api.Test;
import cn.hutool.json.JSONArray;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ParkingSlotSceneInferenceUseCaseTest {

    @Test
    void worldPolygonIouAssociatesEquivalentSlots() {
        List<ParkingSlotSceneInferenceUseCase.Point> first = square(0, 0);
        List<ParkingSlotSceneInferenceUseCase.Point> equivalent = square(0.1, 0);

        assertTrue(ParkingSlotSceneInferenceUseCase.iou(first, equivalent) >= 0.3);
    }

    @Test
    void worldPolygonIouSeparatesDistantSlots() {
        assertEquals(0.0, ParkingSlotSceneInferenceUseCase.iou(square(0, 0), square(10, 0)), 1e-9);
    }

    @Test
    void footprintDistanceUsesNearestEdgeRatherThanCenter() {
        assertEquals(10.0, ParkingSlotSceneInferenceUseCase.distanceToFootprint(square(10, -1)), 1e-9);
    }

    @Test
    void usesNearestCameraCenterForSyncDistance() {
        assertEquals(0.0, ParkingSlotSceneInferenceUseCase.distanceToNearestCameraFootprint(
                square(10, -1), List.of(new ParkingSlotSceneInferenceUseCase.Point(0, 0, 0),
                        new ParkingSlotSceneInferenceUseCase.Point(10, 0, 0))), 1e-9);
    }

    @Test
    void convertsColumnMajorLidarToCameraExtrinsicToCameraCenter() {
        JSONArray external = new JSONArray();
        double[] values = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, -3, -4, 1};
        for (double value : values) external.add(value);

        ParkingSlotSceneInferenceUseCase.Point center =
                ParkingSlotSceneInferenceUseCase.cameraCenterInLidar(external, false);
        assertEquals(2.0, center.x, 1e-9);
        assertEquals(3.0, center.y, 1e-9);
        assertEquals(4.0, center.z, 1e-9);
    }

    private static List<ParkingSlotSceneInferenceUseCase.Point> square(double x, double y) {
        return List.of(new ParkingSlotSceneInferenceUseCase.Point(x, y, 0),
                new ParkingSlotSceneInferenceUseCase.Point(x + 2, y, 0),
                new ParkingSlotSceneInferenceUseCase.Point(x + 2, y + 2, 0),
                new ParkingSlotSceneInferenceUseCase.Point(x, y + 2, 0));
    }
}
