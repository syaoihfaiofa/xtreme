package ai.basic.x1.adapter.dto.response;

import ai.basic.x1.entity.enums.CommentAnchorTypeEnum;
import cn.hutool.json.JSONObject;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.OffsetDateTime;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DataAnnotationCommentResponseDTO {

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

    private AuthorDTO author;

    private OffsetDateTime createdAt;

    private OffsetDateTime updatedAt;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class AuthorDTO {

        private Long id;

        private String username;

        private String nickname;

        private Long avatarId;
    }
}
