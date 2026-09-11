package ai.basic.x1.adapter.dto.request;

import lombok.Data;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;

/** Source archive is uploaded separately, then supplied as a readable URL. */
@Data
public class ReconstructionUploadDTO {
    @NotNull(message = "datasetId cannot be null")
    private Long datasetId;

    @NotBlank(message = "fileUrl cannot be blank")
    private String fileUrl;
}
