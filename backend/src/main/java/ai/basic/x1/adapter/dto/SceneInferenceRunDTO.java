package ai.basic.x1.adapter.dto;

import ai.basic.x1.entity.DatasetInferenceConfig;
import ai.basic.x1.entity.enums.SceneInferenceRunStatusEnum;
import lombok.Data;

import java.time.OffsetDateTime;
import java.util.List;

@Data
public class SceneInferenceRunDTO {

    private Long id;
    private Long datasetId;
    private Long sceneId;
    private String configHash;
    private DatasetInferenceConfig configSnapshot;
    private SceneInferenceRunStatusEnum status;
    private Double progress;
    private Integer totalFrames;
    private Integer completedFrames;
    private String error;
    private List<Long> affectedDataIds;
    private OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;
}
