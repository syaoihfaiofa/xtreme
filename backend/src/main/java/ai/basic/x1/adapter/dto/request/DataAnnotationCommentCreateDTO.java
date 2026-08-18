package ai.basic.x1.adapter.dto.request;

import ai.basic.x1.adapter.api.annotation.valid.ValidStringEnum;
import ai.basic.x1.entity.enums.CommentAnchorTypeEnum;
import cn.hutool.json.JSONObject;
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
public class DataAnnotationCommentCreateDTO {

    @NotNull(message = "datasetId cannot be null")
    private Long datasetId;

    @NotNull(message = "dataId cannot be null")
    private Long dataId;

    @NotBlank(message = "anchorType cannot be blank")
    @ValidStringEnum(enumClass = CommentAnchorTypeEnum.class,
            message = "anchorType must be one of OBJECT, FRAME, POSITION")
    private String anchorType;

    private Long objectId;

    private String trackId;

    private JSONObject position;

    @NotBlank(message = "message cannot be blank")
    private String message;
}
