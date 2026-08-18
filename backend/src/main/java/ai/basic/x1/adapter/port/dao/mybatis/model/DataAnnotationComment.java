package ai.basic.x1.adapter.port.dao.mybatis.model;

import ai.basic.x1.entity.enums.CommentAnchorTypeEnum;
import cn.hutool.json.JSONObject;
import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.handlers.JacksonTypeHandler;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.OffsetDateTime;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@TableName(value = "data_annotation_comment", autoResultMap = true)
public class DataAnnotationComment {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long datasetId;

    private Long dataId;

    private CommentAnchorTypeEnum anchorType;

    private Long objectId;

    private String trackId;

    @TableField(value = "position", typeHandler = JacksonTypeHandler.class)
    private JSONObject position;

    private String message;

    private Long parentId;

    private Long rootId;

    private Boolean resolved;

    @TableField(fill = FieldFill.INSERT)
    private Long createdBy;

    @TableField(fill = FieldFill.INSERT)
    private OffsetDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private OffsetDateTime updatedAt;
}
