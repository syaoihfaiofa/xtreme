package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.entity.DataAnnotationObjectBO;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TrackSyncUseCaseTest {

    @Test
    void splitAtFraction_insertsOneSharedCutPoint() {
        JSONArray points = new JSONArray();
        points.add(point(0, 0, 0));
        points.add(point(10, 0, 0));
        points.add(point(20, 0, 0));

        TrackSyncUseCase.SplitParts split = TrackSyncUseCase.splitAtFraction(points, 0.25);

        assertEquals(2, split.left.size());
        assertEquals(3, split.right.size());
        assertPoint(split.left.getJSONObject(1), 5, 0, 0);
        assertPoint(split.right.getJSONObject(0), 5, 0, 0);
    }

    @Test
    void splitAtFraction_reusesAnExistingVertexWithoutDuplicatePoints() {
        JSONArray points = new JSONArray();
        points.add(point(0, 0, 0));
        points.add(point(10, 0, 0));
        points.add(point(20, 0, 0));

        TrackSyncUseCase.SplitParts split = TrackSyncUseCase.splitAtFraction(points, 0.5);

        assertEquals(2, split.left.size());
        assertEquals(2, split.right.size());
        assertPoint(split.left.getJSONObject(1), 10, 0, 0);
        assertPoint(split.right.getJSONObject(0), 10, 0, 0);
    }

    @Test
    void splitAtFraction_rejectsWholePolylineEndpoints() {
        JSONArray points = new JSONArray();
        points.add(point(0, 0, 0));
        points.add(point(10, 0, 0));

        assertNull(TrackSyncUseCase.splitAtFraction(points, 0));
        assertNull(TrackSyncUseCase.splitAtFraction(points, 1));
    }

    @Test
    void orientedTop_reversesOppositeWallEdgeDirection() {
        JSONArray bottom = new JSONArray();
        bottom.add(point(0, 0, 0));
        bottom.add(point(10, 0, 0));
        JSONArray top = new JSONArray();
        top.add(point(10, 0, 3));
        top.add(point(5, 0, 3));
        top.add(point(0, 0, 3));

        JSONArray oriented = TrackSyncUseCase.orientedTop(bottom, top);

        assertPoint(oriented.getJSONObject(0), 0, 0, 3);
        assertPoint(oriented.getJSONObject(2), 10, 0, 3);
    }

    @Test
    void sliceVisibility_copiesSplitSegmentFlagToBothHalves() {
        JSONArray entries = new JSONArray();
        entries.add(new JSONObject().set("index", 0).set("visible", true));
        entries.add(new JSONObject().set("index", 1).set("visible", false));
        entries.add(new JSONObject().set("index", 2).set("visible", true));
        JSONObject visibility = new JSONObject().set("0", entries);

        JSONObject left = TrackSyncUseCase.sliceVisibility(visibility, 1, false);
        JSONObject right = TrackSyncUseCase.sliceVisibility(visibility, 1, true);

        assertEquals(2, left.getJSONArray("0").size());
        assertEquals(false, left.getJSONArray("0").getJSONObject(1).getBool("visible"));
        assertEquals(2, right.getJSONArray("0").size());
        assertEquals(0, right.getJSONArray("0").getJSONObject(0).getInt("index"));
        assertEquals(false, right.getJSONArray("0").getJSONObject(0).getBool("visible"));
    }

    @Test
    void syncResult_returnsSortedAffectedFrameIdsAndVersion() {
        TrackSyncUseCase.SyncResult result = new TrackSyncUseCase.SyncResult(Set.of(9L, 2L, 5L));

        assertEquals(List.of(2L, 5L, 9L), result.getAffectedDataIds());
        assertTrue(result.getSyncVersion() > 0);
    }

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
    void sameTrackId_matchesTrackAfterClassChange() {
        JSONObject oldClassAttributes = new JSONObject()
                .set("trackId", "track-1")
                .set("classId", 100L);

        assertEquals(true, TrackSyncUseCase.sameTrackId(oldClassAttributes, "track-1"));
        assertEquals(false, TrackSyncUseCase.sameTrackId(oldClassAttributes, "track-2"));
    }

    @Test
    void sameClass_matchesUnclassifiedGroundShapes() {
        JSONObject attrs = new JSONObject()
                .set("trackId", "track-1")
                .set("type", "GROUND_POLYLINE");
        DataAnnotationObject existing = DataAnnotationObject.builder()
                .classAttributes(attrs)
                .build();
        DataAnnotationObjectBO source = DataAnnotationObjectBO.builder()
                .classAttributes(new JSONObject()
                        .set("trackId", "track-1")
                        .set("type", "GROUND_POLYLINE"))
                .build();

        assertTrue(TrackSyncUseCase.sameClass(existing, source));
    }

    @Test
    void fixedSizeSync_appliesPendingCKeyTurnToTargetYaw() {
        JSONObject contour = new JSONObject().set("rotation3D", point(0, 0, Math.PI / 4));

        TrackSyncUseCase.applyFixedSizeOrientationTurn(contour, -1);

        assertEquals(Math.PI * 7 / 4, contour.getJSONObject("rotation3D").getDouble("z"), 0.000000001);
    }

    @Test
    void staticSync_rejectsCrossLevelTargetBeyondTwoMeters() {
        assertTrue(TrackSyncUseCase.isWithinStaticSyncRange(11.9, 12, 8, 6, true));
        assertFalse(TrackSyncUseCase.isWithinStaticSyncRange(11.9, 12, 8, 5.9, true));
        assertTrue(TrackSyncUseCase.isWithinStaticSyncRange(11.9, 12, 8, 0, false));
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
    void cachedWorldPolyline_matchesDirectProjectionForEveryTargetPose() {
        JSONArray sourcePoints = new JSONArray();
        sourcePoints.add(point(-2, 1, 0));
        sourcePoints.add(point(3, -4, 2));
        sourcePoints.add(point(8, 2, 1));
        TrackSyncUseCase.Pose sourcePose = new TrackSyncUseCase.Pose(
                12D, -7D, 3D, Math.PI / 3, 0.1, -0.2);

        List<TrackSyncUseCase.Pose> targetPoses = List.of(
                new TrackSyncUseCase.Pose(12D, -7D, 3D, Math.PI / 3, 0.1, -0.2),
                new TrackSyncUseCase.Pose(1D, 4D, -2D, -Math.PI / 4, -0.15, 0.25));
        for (boolean syncWorldVertical : List.of(true, false)) {
            JSONArray cachedWorldPoints = TrackSyncUseCase.polylineToWorld(
                    sourcePoints, sourcePose, syncWorldVertical);
            for (TrackSyncUseCase.Pose targetPose : targetPoses) {
                JSONArray direct = TrackSyncUseCase.projectGroundPoints(
                        sourcePoints, sourcePose, targetPose, syncWorldVertical);
                JSONArray fromCachedWorld = TrackSyncUseCase.polylineToLocal(
                        cachedWorldPoints, targetPose, syncWorldVertical);

                assertPolylineEquals(direct, fromCachedWorld);
            }
        }
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
    void isGroundPolylineFullyOutside_returnsTrueOnlyWhenEverySegmentIsOutside() {
        assertTrue(TrackSyncUseCase.isGroundPolylineFullyOutside(List.of(true, true)));
        assertFalse(TrackSyncUseCase.isGroundPolylineFullyOutside(List.of(true, false)));
    }

    @Test
    void computeReachableFrameIds_stopsAfterMaxConsecutiveMissingFrames() {
        List<DataInfo> frames = List.of(frame(1), frame(2), frame(3), frame(4), frame(5), frame(6));
        Map<Long, DataAnnotationObject> existingByDataId = Map.of(
                1L, DataAnnotationObject.builder().build(),
                3L, DataAnnotationObject.builder().build());

        assertEquals(
                Set.of(1L, 2L, 3L, 4L),
                TrackSyncUseCase.computeReachableFrameIds(3L, frames, existingByDataId, 1));
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
        existing.set("bev", visibilityEntries(false));

        JSONObject result = TrackSyncUseCase.buildDistanceVisibility(
                existing, oldPoints, targetPoints, List.of(false, true));

        assertVisibility(result, "0", true, false);
        assertVisibility(result, "1", false, false);
        assertVisibility(result, "2", true, false);
        assertVisibility(result, "3", true, false);
        assertVisibility(result, "bev", false, false);

        existing.remove("bev");
        JSONObject migrated = TrackSyncUseCase.buildDistanceVisibility(
                existing, oldPoints, targetPoints, List.of(false, true));
        assertVisibility(migrated, "bev", true, false);
    }

    @Test
    void syncSegmentVisibility_isDisabledUnlessExplicitlyEnabled() {
        assertFalse(TrackSyncUseCase.shouldSyncSegmentVisibility(new JSONObject()));
        assertTrue(TrackSyncUseCase.shouldSyncSegmentVisibility(
                new JSONObject().set("syncSegmentVisibility", true)));
        assertFalse(TrackSyncUseCase.shouldSyncSegmentVisibility(
                new JSONObject().set("syncSegmentVisibility", false)));
    }

    private static JSONArray visibilityEntries(boolean... values) {
        JSONArray entries = new JSONArray();
        for (int index = 0; index < values.length; index++) {
            entries.add(new JSONObject().set("index", index).set("visible", values[index]));
        }
        return entries;
    }

    private static DataInfo frame(long id) {
        return DataInfo.builder().id(id).build();
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

    private static void assertPolylineEquals(JSONArray expected, JSONArray actual) {
        assertEquals(expected.size(), actual.size());
        for (int index = 0; index < expected.size(); index++) {
            JSONObject expectedPoint = expected.getJSONObject(index);
            JSONObject actualPoint = actual.getJSONObject(index);
            assertPoint(
                    actualPoint,
                    expectedPoint.getDouble("x"),
                    expectedPoint.getDouble("y"),
                    expectedPoint.getDouble("z"));
        }
    }
}
