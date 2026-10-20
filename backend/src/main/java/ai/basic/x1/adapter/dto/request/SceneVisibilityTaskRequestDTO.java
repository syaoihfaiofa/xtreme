package ai.basic.x1.adapter.dto.request;

import lombok.Data;

import javax.validation.constraints.NotNull;
import java.util.List;

@Data
public class SceneVisibilityTaskRequestDTO {

    @NotNull(message = "occRunId cannot be null")
    private Long occRunId;

    private List<Long> selectedDataIds;
}
