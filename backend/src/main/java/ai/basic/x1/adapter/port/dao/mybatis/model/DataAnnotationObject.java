package ai.basic.x1.adapter.port.dao.mybatis.model;

import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.annotation.*;
import com.baomidou.mybatisplus.extension.handlers.JacksonTypeHandler;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.time.OffsetDateTime;
import java.util.Objects;

/**
 * @author chenchao
 * @date 2022/8/26
 */
@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@TableName(autoResultMap = true)
public class DataAnnotationObject {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long datasetId;

    private Long dataId;

    private Long classId;

    @TableField(value = "class_attributes", typeHandler = JacksonTypeHandler.class)
    private JSONObject classAttributes;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private String trackId;

    private Long sourceId;

    private DataAnnotationObjectSourceTypeEnum sourceType;

    @TableField(fill = FieldFill.INSERT)
    private OffsetDateTime createdAt;

    @TableField(fill = FieldFill.INSERT)
    private Long createdBy;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private OffsetDateTime updatedAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private Long updatedBy;

    @TableField(exist = false)
    private Integer objectCount;

    @TableField(exist = false)
    private String frontId;

    @TableField(exist = false)
    private Long persistedSyncClassId;

    @TableField(exist = false)
    private String persistedSyncClassAttributes;

    @TableField(exist = false)
    private boolean persistedSyncStateCaptured;

    protected DataAnnotationObject(DataAnnotationObjectBuilder<?, ?> builder) {
        this.id = builder.id;
        this.datasetId = builder.datasetId;
        this.dataId = builder.dataId;
        this.classId = builder.classId;
        this.classAttributes = builder.classAttributes;
        this.trackId = DataAnnotationObjectTrackId.fromClassAttributes(this.classAttributes);
        this.sourceId = builder.sourceId;
        this.sourceType = builder.sourceType;
        this.createdAt = builder.createdAt;
        this.createdBy = builder.createdBy;
        this.updatedAt = builder.updatedAt;
        this.updatedBy = builder.updatedBy;
        this.objectCount = builder.objectCount;
        this.frontId = builder.frontId;
        this.persistedSyncClassId = builder.persistedSyncClassId;
        this.persistedSyncClassAttributes = builder.persistedSyncClassAttributes;
        this.persistedSyncStateCaptured = builder.persistedSyncStateCaptured;
    }

    public void setClassAttributes(JSONObject classAttributes) {
        this.classAttributes = classAttributes;
        this.trackId = DataAnnotationObjectTrackId.fromClassAttributes(classAttributes);
    }

    public void capturePersistedSyncState() {
        persistedSyncClassId = classId;
        persistedSyncClassAttributes = JSONUtil.toJsonStr(classAttributes);
        persistedSyncStateCaptured = true;
    }

    public boolean hasPersistedSyncState() {
        return persistedSyncStateCaptured;
    }

    public boolean matchesPersistedSyncState() {
        return persistedSyncStateCaptured
                && Objects.equals(persistedSyncClassId, classId)
                && Objects.equals(persistedSyncClassAttributes, JSONUtil.toJsonStr(classAttributes));
    }
}
