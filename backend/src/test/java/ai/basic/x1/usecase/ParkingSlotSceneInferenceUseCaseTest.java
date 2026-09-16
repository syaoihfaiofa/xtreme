package ai.basic.x1.usecase;

import org.junit.jupiter.api.Test;

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

    private static List<ParkingSlotSceneInferenceUseCase.Point> square(double x, double y) {
        return List.of(new ParkingSlotSceneInferenceUseCase.Point(x, y, 0),
                new ParkingSlotSceneInferenceUseCase.Point(x + 2, y, 0),
                new ParkingSlotSceneInferenceUseCase.Point(x + 2, y + 2, 0),
                new ParkingSlotSceneInferenceUseCase.Point(x, y + 2, 0));
    }
}
