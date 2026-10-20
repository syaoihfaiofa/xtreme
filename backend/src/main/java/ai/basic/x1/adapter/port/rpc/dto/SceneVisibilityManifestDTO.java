package ai.basic.x1.adapter.port.rpc.dto;

import cn.hutool.json.JSONObject;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

public final class SceneVisibilityManifestDTO {

    private SceneVisibilityManifestDTO() {
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Manifest {
        private String schemaVersion;
        private String taskType;
        private Long runId;
        private Long datasetId;
        private Long sceneId;
        private Source source;
        private Algorithm algorithm;
        private List<Frame> frames;
        private List<Long> selectedDataIds;
        private List<Annotation> annotations;
        private String cameraConfigObjectKey;
        private String occOutputPrefix;
        private String outputPrefix;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Source {
        private String hash;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Algorithm {
        private String version;
        private String classMapVersion;
        private Boolean occVisibility;
        private Integer freeId;
        private Integer generalObjectId;
        private Integer unknownId;
        private List<Double> lidarOrigin;
        private Map<String, Integer> classMap;
        private List<Integer> groundClassIds;
        private Boolean dropEgoBody;
        private Double boxPaintMargin;
        private Double polylineSurfaceThickness;
        private Integer minPointsPerVoxel;
        private Integer voxelCleanupMinNeighbors;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Frame {
        private String dataId;
        private String token;
        private String pointCloudObjectKey;
        private Pose pose;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Annotation {
        private Long dataId;
        private Long objectId;
        private Long classId;
        private JSONObject classAttributes;
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
        private Double roll;
        private Double pitch;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Response {
        private String manifestObjectKey;
        private Integer frameCount;
        private Map<String, Double> timingsMs;
    }
}
