package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.rpc.dto.SceneInferenceTrackingDTO;
import ai.basic.x1.entity.enums.InferenceMotionModeEnum;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class StaticTrackExtrapolationTest {

    @Test
    void apply_usesClosestBevFrameAndProjectsStaticBox() {
        SceneInferenceTrackingDTO.Object far =
                object("t1", InferenceMotionModeEnum.STATIC, 10.0, 0.0, 0.8, 1L);
        SceneInferenceTrackingDTO.Object close =
                object("t1", InferenceMotionModeEnum.STATIC, 2.0, 0.0, 0.7, 2L);

        List<SceneInferenceTrackingDTO.Frame> result = StaticTrackExtrapolation.apply(List.of(
                frame(1L, 0, 0.0, far),
                frame(2L, 1, 3.0, close)
        ), 12.0);

        SceneInferenceTrackingDTO.Object projected = result.get(0).getObjects().get(0);
        assertEquals("t1", projected.getTrackingId());
        assertEquals(5.0, projected.getX(), 1.0e-9);
        assertEquals(0.0, projected.getY(), 1.0e-9);
        assertEquals(2L, projected.getStandardDataId());
    }

    @Test
    void apply_leavesDynamicTracksUnchanged() {
        SceneInferenceTrackingDTO.Object first =
                object("d1", InferenceMotionModeEnum.DYNAMIC_FIXED_SIZE, 1.0, 0.0, 0.9, 1L);
        SceneInferenceTrackingDTO.Object second =
                object("d1", InferenceMotionModeEnum.DYNAMIC_FIXED_SIZE, 8.0, 0.0, 0.9, 2L);

        List<SceneInferenceTrackingDTO.Frame> result = StaticTrackExtrapolation.apply(List.of(
                frame(1L, 0, 0.0, first),
                frame(2L, 1, 3.0, second)
        ), 12.0);

        assertEquals(1.0, result.get(0).getObjects().get(0).getX(), 1.0e-9);
        assertEquals(8.0, result.get(1).getObjects().get(0).getX(), 1.0e-9);
    }

    @Test
    void apply_reprojectsLocalZWhenLocationHeightChanges() {
        SceneInferenceTrackingDTO.Object source =
                object("t1", InferenceMotionModeEnum.STATIC, 2.0, 0.0, 0.9, 1L);
        List<SceneInferenceTrackingDTO.Frame> frames = List.of(
                frame(1L, 0, 0.0, 0.0, source),
                frame(2L, 1, 3.0, 2.0, null));

        List<SceneInferenceTrackingDTO.Frame> result =
                StaticTrackExtrapolation.apply(frames, 12.0);

        assertEquals(-1.5, result.get(1).getObjects().get(0).getZ(), 1.0e-9);
    }

    @Test
    void apply_skipsStaticBoxAboveVerticalSyncTolerance() {
        SceneInferenceTrackingDTO.Object source =
                object("t1", InferenceMotionModeEnum.STATIC, 2.0, 0.0, 0.9, 1L);
        List<SceneInferenceTrackingDTO.Frame> frames = List.of(
                frame(1L, 0, 0.0, 0.0, source),
                frame(2L, 1, 0.0, 2.5, null),
                frame(3L, 2, 0.0, 2.51, null));

        List<SceneInferenceTrackingDTO.Frame> result =
                StaticTrackExtrapolation.apply(frames, 12.0);

        assertEquals(1, result.get(1).getObjects().size());
        assertEquals(0, result.get(2).getObjects().size());
    }

    @Test
    void apply_reprojectsLocalZWithinVerticalSyncRange() {
        SceneInferenceTrackingDTO.Object source =
                object("t1", InferenceMotionModeEnum.STATIC, 2.0, 0.0, 0.9, 1L);
        List<SceneInferenceTrackingDTO.Frame> frames = List.of(
                frame(1L, 0, 0.0, 6.0, source),
                frame(2L, 1, 0.0, 5.5, null));

        List<SceneInferenceTrackingDTO.Frame> result =
                StaticTrackExtrapolation.apply(frames, 12.0);

        assertEquals(1.0, result.get(1).getObjects().get(0).getZ(), 1.0e-9);
    }

    @Test
    void apply_usesTargetPitchForStaticBoxProjection() {
        SceneInferenceTrackingDTO.Object source =
                object("t1", InferenceMotionModeEnum.STATIC, 2.0, 0.0, 0.9, 1L);
        List<SceneInferenceTrackingDTO.Frame> frames = List.of(
                frame(1L, 0, 0.0, source),
                frameWithOrientation(2L, 1, 0.0, 0.0, 0.0, Math.PI / 2, null));

        List<SceneInferenceTrackingDTO.Frame> result =
                StaticTrackExtrapolation.apply(frames, 12.0);

        assertEquals(-0.5, result.get(1).getObjects().get(0).getX(), 1.0e-9);
        assertEquals(2.0, result.get(1).getObjects().get(0).getZ(), 1.0e-9);
    }

    @Test
    void apply_dropsProjectedBoxesOutsideSyncDistance() {
        SceneInferenceTrackingDTO.Object source =
                object("t1", InferenceMotionModeEnum.STATIC, 2.0, 0.0, 0.9, 1L);
        List<SceneInferenceTrackingDTO.Frame> frames = List.of(
                frame(1L, 0, 0.0, source),
                frame(2L, 1, -20.0, null));

        List<SceneInferenceTrackingDTO.Frame> result =
                StaticTrackExtrapolation.apply(frames, 12.0);

        assertEquals(1, result.get(0).getObjects().size());
        assertEquals(0, result.get(1).getObjects().size());
    }

    private static SceneInferenceTrackingDTO.Frame frame(
            Long dataId, int index, double poseX, SceneInferenceTrackingDTO.Object object) {
        return frame(dataId, index, poseX, 0.0, object);
    }

    private static SceneInferenceTrackingDTO.Frame frame(
            Long dataId,
            int index,
            double poseX,
            double poseZ,
            SceneInferenceTrackingDTO.Object object) {
        return frameWithOrientation(dataId, index, poseX, poseZ, 0.0, 0.0, object);
    }

    private static SceneInferenceTrackingDTO.Frame frameWithOrientation(
            Long dataId,
            int index,
            double poseX,
            double poseZ,
            double roll,
            double pitch,
            SceneInferenceTrackingDTO.Object object) {
        return SceneInferenceTrackingDTO.Frame.builder()
                .dataId(dataId)
                .frameIndex(index)
                .pose(SceneInferenceTrackingDTO.Pose.builder()
                        .x(poseX).y(0.0).z(poseZ).yaw(0.0).roll(roll).pitch(pitch).build())
                .objects(object == null ? List.of() : List.of(object))
                .build();
    }

    private static SceneInferenceTrackingDTO.Object object(
            String trackingId,
            InferenceMotionModeEnum mode,
            double x,
            double y,
            double confidence,
            Long dataId) {
        return SceneInferenceTrackingDTO.Object.builder()
                .predictionId(dataId + "-0")
                .trackingId(trackingId)
                .label("pillar")
                .confidence(confidence)
                .x(x).y(y).z(0.5)
                .dx(0.4).dy(0.4).dz(1.0)
                .rotX(0.0).rotY(0.0).rotZ(0.0)
                .motionMode(mode)
                .datasetClassId(12L)
                .standardDataId(dataId)
                .build();
    }
}
