package ai.basic.x1.usecase;

import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class TrackSyncUseCaseTest {

    @Test
    void poseFromLocationValues_usesZeroForMissingRollAndPitch() {
        TrackSyncUseCase.Pose pose = TrackSyncUseCase.poseFromLocationValues(
                new double[]{1, 2, 3, 0.5, Double.NaN, Double.NaN});

        assertEquals(0, pose.roll, 0.000000001);
        assertEquals(0, pose.pitch, 0.000000001);
        assertEquals(false, pose.explicitRoll);
        assertEquals(false, pose.explicitPitch);
    }

    @Test
    void poseFromLocationValues_usesExplicitRollAndPitch() {
        TrackSyncUseCase.Pose pose = TrackSyncUseCase.poseFromLocationValues(
                new double[]{1, 2, 3, 0.5, 0.1, 0.2});

        assertEquals(0.1, pose.roll, 0.000000001);
        assertEquals(0.2, pose.pitch, 0.000000001);
        assertEquals(true, pose.explicitRoll);
        assertEquals(true, pose.explicitPitch);
    }

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
        assertPoint(merged.getJSONObject(0), 0, 0, 1);
        assertPoint(merged.getJSONObject(1), 5, 0, 1);
        assertPoint(merged.getJSONObject(2), 10, 0, 1);
        assertPoint(merged.getJSONObject(3), 15, 0, 1);
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
        assertPoint(merged.getJSONObject(2), 15, 0, 1);
    }

    @Test
    void resolveSyncedGroundPolyline_usesFullSourceLengthWithoutExistingWingsOrClipping() {
        JSONArray source = new JSONArray();
        source.add(point(5, 0, 0));
        source.add(point(15, 0, 0));
        JSONArray existing = new JSONArray();
        existing.add(point(-5, 0, 0));
        existing.add(point(5, 0, 0));
        TrackSyncUseCase.Pose pose = new TrackSyncUseCase.Pose(0D, 0D, 0D, 0D);

        JSONArray resolved = TrackSyncUseCase.resolveSyncedGroundPolyline(
                source, pose, existing, pose, 10);

        assertEquals(2, resolved.size());
        assertPoint(resolved.getJSONObject(0), 5, 0, 0);
        assertPoint(resolved.getJSONObject(1), 15, 0, 0);
    }

    @Test
    void splitGroundPolylineByRadius_insertsBoundariesAndMarksOutsideSegments() {
        JSONArray points = new JSONArray();
        points.add(point(-20, 0, 2));
        points.add(point(20, 0, 6));

        TrackSyncUseCase.PolylineDistanceMask masked =
                TrackSyncUseCase.splitGroundPolylineByRadius(points, 10);

        assertEquals(4, masked.points.size());
        assertPoint(masked.points.getJSONObject(0), -20, 0, 2);
        assertPoint(masked.points.getJSONObject(1), -10, 0, 3);
        assertPoint(masked.points.getJSONObject(2), 10, 0, 5);
        assertPoint(masked.points.getJSONObject(3), 20, 0, 6);
        assertEquals(List.of(true, false, true), masked.outsideSegments);
    }

    @Test
    void buildDistanceVisibility_preservesManualFlagsAndHidesOutsideForEveryView() {
        JSONArray oldPoints = new JSONArray();
        oldPoints.add(point(0, 0, 0));
        oldPoints.add(point(20, 0, 0));
        JSONArray targetPoints = new JSONArray();
        targetPoints.add(point(0, 0, 0));
        targetPoints.add(point(10, 0, 0));
        targetPoints.add(point(20, 0, 0));
        JSONObject existing = new JSONObject();
        existing.set("0", visibilityEntries(true));
        existing.set("1", visibilityEntries(false));

        JSONObject result = TrackSyncUseCase.buildDistanceVisibility(
                existing, oldPoints, targetPoints, List.of(false, true));

        assertVisibility(result, "0", true, false);
        assertVisibility(result, "1", false, false);
        assertVisibility(result, "2", true, false);
        assertVisibility(result, "3", true, false);
    }

    private static JSONArray visibilityEntries(boolean... values) {
        JSONArray entries = new JSONArray();
        for (int index = 0; index < values.length; index++) {
            entries.add(new JSONObject().set("index", index).set("visible", values[index]));
        }
        return entries;
    }

    private static void assertVisibility(
            JSONObject byView, String viewKey, boolean... expected) {
        JSONArray entries = byView.getJSONArray(viewKey);
        assertEquals(expected.length, entries.size());
        for (int index = 0; index < expected.length; index++) {
            assertEquals(index, entries.getJSONObject(index).getInt("index"));
            assertEquals(expected[index], entries.getJSONObject(index).getBool("visible"));
        }
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
