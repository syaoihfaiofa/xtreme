package ai.basic.x1.adapter.port.dao.mybatis.model;

import ai.basic.x1.entity.DatasetInferenceConfig;
import ai.basic.x1.entity.enums.SceneInferenceRunStatusEnum;
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
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName(value = "scene_inference_run", autoResultMap = true)
public class SceneInferenceRun {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long datasetId;

    private Long sceneId;

    private String configHash;

    @TableField(value = "config_snapshot", typeHandler = JacksonTypeHandler.class)
    private DatasetInferenceConfig configSnapshot;

    private SceneInferenceRunStatusEnum status;

    private Double progress;

    private Integer totalFrames;

    private Integer completedFrames;

    private String error;

    @TableField(value = "affected_data_ids", typeHandler = JacksonTypeHandler.class)
    private List<Long> affectedDataIds;

    @TableField(fill = FieldFill.INSERT)
    private OffsetDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private OffsetDateTime updatedAt;
}
