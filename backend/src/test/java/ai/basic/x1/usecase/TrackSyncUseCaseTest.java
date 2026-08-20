package ai.basic.x1.usecase;

import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class TrackSyncUseCaseTest {

    @Test
    void projectGroundPoints_preservesPolylineOrderAcrossPoses() {
        JSONArray sourcePoints = new JSONArray();
        sourcePoints.add(point(1, 2, 3));
        sourcePoints.add(point(2, 0, 4));
        sourcePoints.add(point(-1, 3, 5));
        sourcePoints.add(point(0, 0, 0));
        sourcePoints.add(point(4, -2, 1));

        JSONArray targetPoints = TrackSyncUseCase.projectGroundPoints(
                sourcePoints,
                new TrackSyncUseCase.Pose(10D, 20D, 2D, Math.PI / 2),
                new TrackSyncUseCase.Pose(7D, 18D, 1D, Math.PI / 2));

        assertEquals(5, targetPoints.size());
        assertPoint(targetPoints.getJSONObject(0), 3, -1, 4);
        assertPoint(targetPoints.getJSONObject(1), 4, -3, 5);
        assertPoint(targetPoints.getJSONObject(2), 1, 0, 6);
        assertPoint(targetPoints.getJSONObject(3), 2, -3, 1);
        assertPoint(targetPoints.getJSONObject(4), 6, -5, 2);
    }

    @Test
    void distanceToGroundShapeFootprint_usesNearestSegment() {
        JSONArray points = new JSONArray();
        points.add(point(3, -2, 0));
        points.add(point(3, 2, 0));

        assertEquals(3, TrackSyncUseCase.distanceToGroundShapeFootprint(points), 0.000000001);
    }

    @Test
    void distanceToGroundShapeFootprint_returnsZeroWhenSegmentContainsEgo() {
        JSONArray points = new JSONArray();
        points.add(point(-2, 0, 0));
        points.add(point(2, 0, 0));

        assertEquals(0, TrackSyncUseCase.distanceToGroundShapeFootprint(points), 0.000000001);
    }

    private static JSONObject point(double x, double y, double z) {
        JSONObject point = new JSONObject();
        point.set("x", x);
        point.set("y", y);
        point.set("z", z);
        return point;
    }

    private static void assertPoint(JSONObject point, double x, double y, double z) {
        assertEquals(x, point.getDouble("x"), 0.000000001);
        assertEquals(y, point.getDouble("y"), 0.000000001);
        assertEquals(z, point.getDouble("z"), 0.000000001);
    }
}
