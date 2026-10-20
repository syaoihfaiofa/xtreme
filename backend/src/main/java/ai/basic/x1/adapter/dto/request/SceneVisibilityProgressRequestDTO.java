package ai.basic.x1.adapter.dto.request;

import ai.basic.x1.entity.enums.SceneVisibilityRunStageEnum;
import lombok.Data;

import javax.validation.constraints.Min;
import javax.validation.constraints.NotNull;

@Data
public class SceneVisibilityProgressRequestDTO {

    @NotNull
    private SceneVisibilityRunStageEnum stage;

    @NotNull
    @Min(0)
    private Integer completedFrames;
}
