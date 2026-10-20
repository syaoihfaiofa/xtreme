package ai.basic.x1.adapter.dto;

import ai.basic.x1.entity.enums.SceneVisibilityRunStatusEnum;
import ai.basic.x1.entity.enums.SceneVisibilityRunStageEnum;
import ai.basic.x1.entity.enums.SceneVisibilityTaskTypeEnum;
import lombok.Data;

import java.time.OffsetDateTime;

@Data
public class SceneVisibilityRunDTO {

    private Long id;
    private Long datasetId;
    private Long sceneId;
    private String sourceHash;
    private String algorithmVersion;
    private SceneVisibilityTaskTypeEnum taskType;
    private Long occRunId;
    private SceneVisibilityRunStatusEnum status;
    private SceneVisibilityRunStageEnum stage;
    private Double progress;
    private Integer totalFrames;
    private Integer completedFrames;
    private String error;
    private String timingsMs;
    private Long resultFileId;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
}
