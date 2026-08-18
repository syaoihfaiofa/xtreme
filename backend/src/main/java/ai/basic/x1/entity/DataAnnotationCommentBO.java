package ai.basic.x1.entity;

import ai.basic.x1.entity.enums.CommentAnchorTypeEnum;
import cn.hutool.json.JSONObject;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.OffsetDateTime;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class DataAnnotationCommentBO {

    private Long id;

    private Long datasetId;

    private Long dataId;

    private CommentAnchorTypeEnum anchorType;

    private Long objectId;

    private String trackId;

    private JSONObject position;

    private String message;

    private Long parentId;

    private Long rootId;

    private Boolean resolved;

    private Long createdBy;

    private OffsetDateTime createdAt;

    private OffsetDateTime updatedAt;

    private String authorUsername;

    private String authorNickname;

    private Long authorAvatarId;
}
