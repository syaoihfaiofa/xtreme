package ai.basic.x1.adapter.port.dao.mybatis.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("reconstruction_frame")
public class ReconstructionFrame {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long sceneId;
    private Long timestampNs;
    private Double posX;
    private Double posY;
    private Double posZ;
    private Double yaw;
    private Double roll;
    private Double pitch;
}
