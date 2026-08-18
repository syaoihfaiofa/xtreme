package ai.basic.x1.adapter.dto.request;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DataAnnotationCommentReplyDTO {

    @NotNull(message = "datasetId cannot be null")
    private Long datasetId;

    @NotNull(message = "dataId cannot be null")
    private Long dataId;

    @NotNull(message = "parentId cannot be null")
    private Long parentId;

    @NotBlank(message = "message cannot be blank")
    private String message;
}
