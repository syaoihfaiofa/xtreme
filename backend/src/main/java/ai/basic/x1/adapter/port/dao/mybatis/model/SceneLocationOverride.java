package ai.basic.x1.adapter.port.dao.mybatis.model;

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

/** A user-derived pose takes precedence over imported/interpolated location samples. */
@Data @Builder @NoArgsConstructor @AllArgsConstructor
@TableName("scene_location_override")
public class SceneLocationOverride {
    @TableId(type = IdType.AUTO) private Long id;
    private Long dataId;
    private Double posX;
    private Double posY;
    private Double posZ;
    private Double yaw;
    private Double roll;
    private Double pitch;
    @TableField(fill = FieldFill.INSERT) private OffsetDateTime createdAt;
    @TableField(fill = FieldFill.UPDATE) private OffsetDateTime updatedAt;
}
