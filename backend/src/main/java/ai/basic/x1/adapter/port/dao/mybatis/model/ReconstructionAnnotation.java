package ai.basic.x1.adapter.port.dao.mybatis.model;

import cn.hutool.json.JSONObject;
import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.handlers.JacksonTypeHandler;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.OffsetDateTime;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName(value = "reconstruction_annotation", autoResultMap = true)
public class ReconstructionAnnotation {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long datasetId;
    private Long sceneId;
    private Long classId;
    @TableField(value = "geometry", typeHandler = JacksonTypeHandler.class)
    private JSONObject geometry;
    @TableField(value = "class_attributes", typeHandler = JacksonTypeHandler.class)
    private JSONObject classAttributes;
    @TableField(fill = FieldFill.INSERT)
    private OffsetDateTime createdAt;
    @TableField(fill = FieldFill.INSERT)
    private Long createdBy;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private OffsetDateTime updatedAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private Long updatedBy;
}
