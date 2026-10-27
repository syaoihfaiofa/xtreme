package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocation;
import org.junit.jupiter.api.Test;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONUtil;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
    void syncRangeRejectsParkingSlotOnDifferentLevel() {
        List<ParkingSlotSceneInferenceUseCase.Point> slot = square(0, 0);

        assertTrue(ParkingSlotSceneInferenceUseCase.isWithinSyncRange(
                slot, new ParkingSlotSceneInferenceUseCase.Point(0, 0, 2), 10));
        assertFalse(ParkingSlotSceneInferenceUseCase.isWithinSyncRange(
                slot, new ParkingSlotSceneInferenceUseCase.Point(0, 0, 2.1), 10));
    }

    @Test
    void polylineSyncRangeSplitsRampAtVerticalBoundary() {
        JSONArray projected = new JSONArray();
        projected.add(JSONUtil.createObj().set("x", 0).set("y", 0).set("z", 0));
        projected.add(JSONUtil.createObj().set("x", 4).set("y", 0).set("z", 4));
        JSONArray world = new JSONArray();
        world.add(JSONUtil.createObj().set("x", 0).set("y", 0).set("z", 0));
        world.add(JSONUtil.createObj().set("x", 4).set("y", 0).set("z", 4));

        TrackSyncUseCase.PolylineDistanceMask mask =
                TrackSyncUseCase.splitGroundPolylineBySyncRange(projected, world, 10, 0, true);

        assertEquals(3, mask.points.size());
        assertEquals(2.0, mask.points.getJSONObject(1).getDouble("z"), 1e-9);
        assertEquals(List.of(false, true), mask.outsideSegments);
    }

    @Test
    void irregularWallSyncRangeClipsBothBoundariesAtRampHeightLimit() {
        JSONArray bottom = new JSONArray();
        bottom.add(JSONUtil.createObj().set("x", 0).set("y", 0).set("z", 0));
        bottom.add(JSONUtil.createObj().set("x", 4).set("y", 0).set("z", 4));
        JSONArray top = new JSONArray();
        top.add(JSONUtil.createObj().set("x", 0).set("y", 0).set("z", 3));
        top.add(JSONUtil.createObj().set("x", 4).set("y", 0).set("z", 7));

        TrackSyncUseCase.IrregularWallSyncGeometry geometry =
                TrackSyncUseCase.clipIrregularWallToSyncRange(
                        bottom,
                        bottom,
                        top,
                        new TrackSyncUseCase.Pose(0D, 0D, 0D, 0D),
                        10,
                        true);

        assertEquals(2, geometry.bottomPoints.size());
        assertEquals(2.0, geometry.bottomPoints.getJSONObject(1).getDouble("z"), 1e-9);
        assertEquals(2, geometry.topPoints.size());
        assertEquals(5.0, geometry.topPoints.getJSONObject(1).getDouble("z"), 1e-9);
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

    @Test
    void parkingSlotProjectionUsesPitch() throws ReflectiveOperationException {
        SceneLocation pose = SceneLocation.builder()
                .posX(0.0).posY(0.0).posZ(0.0).yaw(0.0).roll(0.0).pitch(Math.PI / 2)
                .build();
        ParkingSlotSceneInferenceUseCase.Point local =
                new ParkingSlotSceneInferenceUseCase.Point(2.0, 0.0, 0.5);

        ParkingSlotSceneInferenceUseCase.Point world = transform("localToWorld", local, pose);
        ParkingSlotSceneInferenceUseCase.Point projectedLocal = transform(
                "worldToLocal",
                new ParkingSlotSceneInferenceUseCase.Point(0.5, 0.0, -2.0),
                pose);

        assertEquals(0.5, world.x, 1e-9);
        assertEquals(-2.0, world.z, 1e-9);
        assertEquals(2.0, projectedLocal.x, 1e-9);
        assertEquals(0.5, projectedLocal.z, 1e-9);
    }

    private static ParkingSlotSceneInferenceUseCase.Point transform(
            String methodName,
            ParkingSlotSceneInferenceUseCase.Point point,
            SceneLocation pose) throws ReflectiveOperationException {
        var method = ParkingSlotSceneInferenceUseCase.class.getDeclaredMethod(
                methodName,
                ParkingSlotSceneInferenceUseCase.Point.class,
                SceneLocation.class);
        method.setAccessible(true);
        return (ParkingSlotSceneInferenceUseCase.Point) method.invoke(null, point, pose);
    }

    private static List<ParkingSlotSceneInferenceUseCase.Point> square(double x, double y) {
        return List.of(new ParkingSlotSceneInferenceUseCase.Point(x, y, 0),
                new ParkingSlotSceneInferenceUseCase.Point(x + 2, y, 0),
                new ParkingSlotSceneInferenceUseCase.Point(x + 2, y + 2, 0),
                new ParkingSlotSceneInferenceUseCase.Point(x, y + 2, 0));
    }
}
