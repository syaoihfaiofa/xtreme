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
@TableName("reconstruction_frame_image")
public class ReconstructionFrameImage {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long frameId;
    private Integer cameraIndex;
    private Long fileId;
}
