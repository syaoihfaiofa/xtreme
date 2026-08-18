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

import java.io.Serializable;
import java.time.OffsetDateTime;

/**
 * Per-frame ego pose, uploaded via a "location.txt" file associated with a Scene.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("scene_location")
public class SceneLocation implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(type = IdType.AUTO)
    private Long id;

    /**
     * Frame data id (SINGLE_DATA row under a Scene)
     */
    private Long dataId;

    private Double posX;

    private Double posY;

    private Double posZ;

    /**
     * Heading, radians
     */
    private Double yaw;

    @TableField(fill = FieldFill.INSERT)
    private OffsetDateTime createdAt;

    @TableField(fill = FieldFill.UPDATE)
    private OffsetDateTime updatedAt;
}
