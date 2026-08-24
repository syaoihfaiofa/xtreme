package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.rpc.dto.SceneInferenceTrackingDTO;
import ai.basic.x1.entity.enums.InferenceMotionModeEnum;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.core.util.StrUtil;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class StaticTrackExtrapolation {

    private StaticTrackExtrapolation() {
    }

    public static List<SceneInferenceTrackingDTO.Frame> apply(
            List<SceneInferenceTrackingDTO.Frame> frames,
            double syncDistance) {
        if (frames == null) {
            throw new UsecaseException("Tracked frames cannot be null");
        }
        Map<String, Candidate> closestByTrackId = findClosestStaticObjects(frames);
        List<SceneInferenceTrackingDTO.Frame> result = copyFramesWithoutStaticObjects(frames);
        for (Map.Entry<String, Candidate> entry : closestByTrackId.entrySet()) {
            projectTrack(entry.getKey(), entry.getValue(), result, syncDistance);
        }
        return result;
    }

    private static Map<String, Candidate> findClosestStaticObjects(
            List<SceneInferenceTrackingDTO.Frame> frames) {
        Map<String, Candidate> closestByTrackId = new LinkedHashMap<>();
        for (SceneInferenceTrackingDTO.Frame frame : frames) {
            if (frame == null || frame.getObjects() == null) {
                continue;
            }
            requireCompletePose(frame);
            for (SceneInferenceTrackingDTO.Object object : frame.getObjects()) {
                if (object == null || object.getMotionMode() != InferenceMotionModeEnum.STATIC) {
                    continue;
                }
                if (StrUtil.isBlank(object.getTrackingId()) || object.getX() == null || object.getY() == null) {
                    throw new UsecaseException("Static tracked object is incomplete: dataId=" + frame.getDataId()
                            + ", trackingId=" + (object == null ? null : object.getTrackingId()));
                }
                Candidate candidate = new Candidate(frame, object);
                Candidate current = closestByTrackId.get(object.getTrackingId());
                if (current == null || candidate.isPreferredTo(current)) {
                    closestByTrackId.put(object.getTrackingId(), candidate);
                }
            }
        }
        return closestByTrackId;
    }

    private static List<SceneInferenceTrackingDTO.Frame> copyFramesWithoutStaticObjects(
            List<SceneInferenceTrackingDTO.Frame> frames) {
        List<SceneInferenceTrackingDTO.Frame> result = new ArrayList<>(frames.size());
        for (SceneInferenceTrackingDTO.Frame frame : frames) {
            requireCompletePose(frame);
            List<SceneInferenceTrackingDTO.Object> objects = new ArrayList<>();
            if (frame.getObjects() != null) {
                for (SceneInferenceTrackingDTO.Object object : frame.getObjects()) {
                    if (object != null && object.getMotionMode() != InferenceMotionModeEnum.STATIC) {
                        objects.add(copyObject(object));
                    }
                }
            }
            result.add(SceneInferenceTrackingDTO.Frame.builder()
                    .dataId(frame.getDataId())
                    .frameIndex(frame.getFrameIndex())
                    .pose(copyPose(frame.getPose()))
                    .objects(objects)
                    .build());
        }
        return result;
    }

    private static void projectTrack(
            String trackingId,
            Candidate source,
            List<SceneInferenceTrackingDTO.Frame> targetFrames,
            double syncDistance) {
        TrackSyncUseCase.Pose sourcePose = toPose(source.frame.getPose());
        for (SceneInferenceTrackingDTO.Frame targetFrame : targetFrames) {
            TrackSyncUseCase.ProjectedPose projected = TrackSyncUseCase.projectPose(
                    source.object.getX(),
                    source.object.getY(),
                    source.object.getZ(),
                    source.object.getRotZ(),
                    sourcePose,
                    toPose(targetFrame.getPose()),
                    false);
            if (Math.hypot(projected.x, projected.y) > syncDistance) {
                continue;
            }
            SceneInferenceTrackingDTO.Object projectedObject = copyObject(source.object);
            projectedObject.setTrackingId(trackingId);
            projectedObject.setX(projected.x);
            projectedObject.setY(projected.y);
            projectedObject.setZ(source.object.getZ());
            projectedObject.setRotZ(projected.yaw);
            projectedObject.setStandardDataId(source.frame.getDataId());
            targetFrame.getObjects().add(projectedObject);
        }
    }

    private static void requireCompletePose(SceneInferenceTrackingDTO.Frame frame) {
        if (frame == null || frame.getDataId() == null || frame.getPose() == null
                || frame.getPose().getX() == null || frame.getPose().getY() == null
                || frame.getPose().getZ() == null || frame.getPose().getYaw() == null) {
            throw new UsecaseException("Tracked frame pose is incomplete: dataId="
                    + (frame == null ? null : frame.getDataId()));
        }
    }

    private static TrackSyncUseCase.Pose toPose(SceneInferenceTrackingDTO.Pose pose) {
        return new TrackSyncUseCase.Pose(pose.getX(), pose.getY(), pose.getZ(), pose.getYaw());
    }

    private static SceneInferenceTrackingDTO.Pose copyPose(SceneInferenceTrackingDTO.Pose pose) {
        return SceneInferenceTrackingDTO.Pose.builder()
                .x(pose.getX())
                .y(pose.getY())
                .z(pose.getZ())
                .yaw(pose.getYaw())
                .build();
    }

    private static SceneInferenceTrackingDTO.Object copyObject(SceneInferenceTrackingDTO.Object source) {
        return SceneInferenceTrackingDTO.Object.builder()
                .predictionId(source.getPredictionId())
                .label(source.getLabel())
                .confidence(source.getConfidence())
                .x(source.getX()).y(source.getY()).z(source.getZ())
                .dx(source.getDx()).dy(source.getDy()).dz(source.getDz())
                .rotX(source.getRotX()).rotY(source.getRotY()).rotZ(source.getRotZ())
                .motionMode(source.getMotionMode())
                .datasetClassId(source.getDatasetClassId())
                .trackingId(source.getTrackingId())
                .standardDataId(source.getStandardDataId())
                .build();
    }

    private static final class Candidate {
        private final SceneInferenceTrackingDTO.Frame frame;
        private final SceneInferenceTrackingDTO.Object object;

        private Candidate(
                SceneInferenceTrackingDTO.Frame frame,
                SceneInferenceTrackingDTO.Object object) {
            this.frame = frame;
            this.object = object;
        }

        private boolean isPreferredTo(Candidate other) {
            int distanceComparison = Double.compare(
                    Math.hypot(object.getX(), object.getY()),
                    Math.hypot(other.object.getX(), other.object.getY()));
            if (distanceComparison != 0) {
                return distanceComparison < 0;
            }
            double confidence = object.getConfidence() == null
                    ? Double.NEGATIVE_INFINITY : object.getConfidence();
            double otherConfidence = other.object.getConfidence() == null
                    ? Double.NEGATIVE_INFINITY : other.object.getConfidence();
            int confidenceComparison = Double.compare(confidence, otherConfidence);
            if (confidenceComparison != 0) {
                return confidenceComparison > 0;
            }
            return frame.getDataId() < other.frame.getDataId();
        }
    }
}
