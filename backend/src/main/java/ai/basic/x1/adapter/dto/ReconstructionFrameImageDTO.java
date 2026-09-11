package ai.basic.x1.adapter.dto;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class ReconstructionFrameImageDTO {
    private Integer cameraIndex;
    private String url;
}
