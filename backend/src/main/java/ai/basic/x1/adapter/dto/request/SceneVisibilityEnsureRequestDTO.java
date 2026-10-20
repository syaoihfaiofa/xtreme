package ai.basic.x1.adapter.dto.request;

import lombok.Data;

import javax.validation.constraints.NotNull;
import java.util.List;

@Data
public class SceneVisibilityEnsureRequestDTO {

    @NotNull(message = "datasetId cannot be null")
    private Long datasetId;

    @NotNull(message = "sceneId cannot be null")
    private Long sceneId;

    private List<Long> selectedDataIds;
}
