package ai.basic.x1.adapter.dto.request;

import lombok.Data;

import javax.validation.constraints.NotNull;

@Data
public class SceneInferenceEnsureRequestDTO {

    @NotNull(message = "recordId cannot be null")
    private Long recordId;
}
