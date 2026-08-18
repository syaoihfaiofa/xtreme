package ai.basic.x1.adapter.port.rpc.dto;

import ai.basic.x1.entity.enums.InferenceMotionModeEnum;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

public final class SceneInferenceTrackingDTO {

    private SceneInferenceTrackingDTO() {
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Request {
        private Config config;
        private List<Frame> frames;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Config {
        private Double iouThreshold;
        private Double syncDistance;
        private Integer maxOutsideFrames;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Frame {
        private Long dataId;
        private Integer frameIndex;
        private Pose pose;
        private List<Object> objects;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Pose {
        private Double x;
        private Double y;
        private Double z;
        private Double yaw;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Object {
        private String predictionId;
        private String label;
        private Double confidence;
        private Double x;
        private Double y;
        private Double z;
        private Double dx;
        private Double dy;
        private Double dz;
        private Double rotX;
        private Double rotY;
        private Double rotZ;
        private InferenceMotionModeEnum motionMode;
        private Long datasetClassId;
        private String trackingId;
        private Long standardDataId;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Response {
        private List<Frame> frames;
    }
}
