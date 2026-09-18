package ai.basic.x1.entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/** Additional, lidar-oriented statistics displayed on the dataset overview. */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DatasetOverviewDetailBO {
    private Integer sceneCount;
    private Integer annotatedFrameCount;
    private Integer totalFrameCount;
    private Integer positionedObjectCount;
    private List<DistanceUnit> distanceUnits;
    private List<SceneUnit> sceneUnits;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class DistanceUnit {
        private String range;
        private Integer objectCount;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SceneUnit {
        private Long sceneId;
        private String name;
        private Integer frameCount;
    }
}
