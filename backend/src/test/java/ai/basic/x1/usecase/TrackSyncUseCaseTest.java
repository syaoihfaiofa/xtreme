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
    void projectPose_increasesLocalZWhenDrivingDownhill() {
        TrackSyncUseCase.ProjectedPose projected = TrackSyncUseCase.projectPose(
                10.0,
                0.0,
                3.0,
                0D,
                new TrackSyncUseCase.Pose(0D, 0D, 0D, 0D),
                new TrackSyncUseCase.Pose(0D, 0D, -2D, 0D),
                true);

        assertEquals(5.0, projected.z, 0.000000001);
    }

    @Test
    void projectPose_reducesDownhillZWhenPitchIsApplied() {
        TrackSyncUseCase.ProjectedPose projected = TrackSyncUseCase.projectPose(
                8.714,
                -8.140,
                0.5676,
                0D,
                new TrackSyncUseCase.Pose(
                        2.2478030836203584,
                        97.49150496738476,
                        -0.0129597113,
                        1.5797882953545865,
                        0D),
                new TrackSyncUseCase.Pose(
                        8.99331904367943,
                        96.40130369510345,
                        -3.5470916224847815,
                        3.0991892352579966,
                        Math.toRadians(5.23)),
                true);

        assertEquals(4.002988691409424, projected.z, 0.000000001);
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

    @Test
    void clipGroundPolylineToRadius_insertsCircleIntersections() {
        JSONArray points = new JSONArray();
        points.add(point(-20, 0, 2));
        points.add(point(0, 0, 4));
        points.add(point(20, 0, 6));

        JSONArray clipped = TrackSyncUseCase.clipGroundPolylineToRadius(points, 10);

        assertEquals(3, clipped.size());
        assertPoint(clipped.getJSONObject(0), -10, 0, 3);
        assertPoint(clipped.getJSONObject(1), 0, 0, 4);
        assertPoint(clipped.getJSONObject(2), 10, 0, 5);
    }

    @Test
    void clipGroundPolylineToRadius_returnsEmptyOutsideCircle() {
        JSONArray points = new JSONArray();
        points.add(point(20, 0, 0));
        points.add(point(30, 0, 0));

        JSONArray clipped = TrackSyncUseCase.clipGroundPolylineToRadius(points, 10);

        assertEquals(0, clipped.size());
    }

    @Test
    void clipGroundPolylineToRadius_keepsNearestDisconnectedComponent() {
        JSONArray points = new JSONArray();
        points.add(point(-12, 8, 0));
        points.add(point(-8, 8, 0));
        points.add(point(-12, 8, 0));
        points.add(point(-12, 12, 0));
        points.add(point(12, 12, 0));
        points.add(point(12, 3, 0));
        points.add(point(8, 3, 0));

        JSONArray clipped = TrackSyncUseCase.clipGroundPolylineToRadius(points, 10);

        assertEquals(2, clipped.size());
        assertEquals(3, clipped.getJSONObject(0).getDouble("y"), 0.000000001);
        assertEquals(3, clipped.getJSONObject(1).getDouble("y"), 0.000000001);
    }

    @Test
    void mergeWorldPolylinesPreferringSource_keepsExistingWings() {
        JSONArray existing = new JSONArray();
        existing.add(point(0, 0, 0));
        existing.add(point(5, 0, 0));
        existing.add(point(10, 0, 0));
        existing.add(point(15, 0, 0));
        JSONArray source = new JSONArray();
        source.add(point(5, 0, 1));
        source.add(point(10, 0, 1));

        JSONArray merged = TrackSyncUseCase.mergeWorldPolylinesPreferringSource(existing, source);

        assertEquals(4, merged.size());
        assertPoint(merged.getJSONObject(0), 0, 0, 0);
        assertPoint(merged.getJSONObject(1), 5, 0, 1);
        assertPoint(merged.getJSONObject(2), 10, 0, 1);
        assertPoint(merged.getJSONObject(3), 15, 0, 0);
    }

    @Test
    void mergeWorldPolylinesPreferringSource_dropsDivergentWings() {
        JSONArray existing = new JSONArray();
        existing.add(point(0, 5, 0));
        existing.add(point(5, 0, 0));
        existing.add(point(10, 0, 0));
        existing.add(point(15, 0, 0));
        JSONArray source = new JSONArray();
        source.add(point(5, 0, 1));
        source.add(point(10, 0, 1));

        JSONArray merged = TrackSyncUseCase.mergeWorldPolylinesPreferringSource(existing, source);

        assertEquals(3, merged.size());
        assertPoint(merged.getJSONObject(0), 5, 0, 1);
        assertPoint(merged.getJSONObject(1), 10, 0, 1);
        assertPoint(merged.getJSONObject(2), 15, 0, 0);
    }

    @Test
    void resolveSyncedGroundPolyline_mergesLengthThenClipsTargetFrame() {
        JSONArray source = new JSONArray();
        source.add(point(5, 0, 0));
        source.add(point(15, 0, 0));
        JSONArray existing = new JSONArray();
        existing.add(point(-5, 0, 0));
        existing.add(point(5, 0, 0));
        TrackSyncUseCase.Pose pose = new TrackSyncUseCase.Pose(0D, 0D, 0D, 0D);

        JSONArray resolved = TrackSyncUseCase.resolveSyncedGroundPolyline(
                source, pose, existing, pose, 10);

        assertEquals(3, resolved.size());
        assertPoint(resolved.getJSONObject(0), -5, 0, 0);
        assertPoint(resolved.getJSONObject(1), 5, 0, 0);
        assertPoint(resolved.getJSONObject(2), 10, 0, 0);
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
