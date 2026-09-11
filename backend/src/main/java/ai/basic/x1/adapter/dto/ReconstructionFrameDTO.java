package ai.basic.x1.adapter.dto;

import lombok.Builder;
import lombok.Data;

import java.util.List;

@Data
@Builder
public class ReconstructionFrameDTO {
    private Long id;
    private Long timestampNs;
    private Double posX;
    private Double posY;
    private Double posZ;
    private Double yaw;
    private Double roll;
    private Double pitch;
    private List<ReconstructionFrameImageDTO> images;
}
