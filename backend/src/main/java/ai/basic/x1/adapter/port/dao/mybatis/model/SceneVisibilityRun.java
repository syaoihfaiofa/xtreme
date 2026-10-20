package ai.basic.x1.adapter.port.dao.mybatis.model;

import ai.basic.x1.entity.enums.SceneVisibilityRunStatusEnum;
import ai.basic.x1.entity.enums.SceneVisibilityRunStageEnum;
import ai.basic.x1.entity.enums.SceneVisibilityTaskTypeEnum;
import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.OffsetDateTime;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName(value = "scene_visibility_run", autoResultMap = true)
public class SceneVisibilityRun {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long datasetId;

    private Long sceneId;

    private String sourceHash;

    private String generationToken;

    private Boolean isDefault;

    private SceneVisibilityTaskTypeEnum taskType;

    private Long occRunId;

    private String algorithmVersion;

    private SceneVisibilityRunStatusEnum status;

    private SceneVisibilityRunStageEnum stage;

    private Double progress;

    private Integer totalFrames;

    private Integer completedFrames;

    private String error;

    private String timingsMs;

    private Long resultFileId;

    @TableField(fill = FieldFill.INSERT)
    private OffsetDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private OffsetDateTime updatedAt;
}
