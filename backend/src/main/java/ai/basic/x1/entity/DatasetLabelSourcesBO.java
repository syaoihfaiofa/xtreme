package ai.basic.x1.entity;

import ai.basic.x1.entity.enums.RunStatusEnum;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.OffsetDateTime;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DatasetLabelSourcesBO {

    private CurrentSource current;

    private List<SnapshotSource> snapshots;

    private List<ModelRunSource> modelRuns;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class CurrentSource {
        private long objectCount;
        private List<SceneCount> sceneCounts;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SceneCount {
        private Long sceneId;
        private long objectCount;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SnapshotSource {
        private Long id;
        private Long sceneId;
        private String name;
        private long objectCount;
        private OffsetDateTime createdAt;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ModelRunSource {
        private Long recordId;
        private String modelName;
        private RunStatusEnum status;
        private long objectCount;
        private OffsetDateTime createdAt;
    }
}
