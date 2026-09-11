package ai.basic.x1.adapter.dto;

import lombok.Builder;
import lombok.Data;

import java.util.List;

@Data
@Builder
public class ReconstructionSceneDTO {
    private Long id;
    private Long datasetId;
    private String name;
    private String pointCloudUrl;
    private String cameraConfigUrl;
    private List<ReconstructionFrameDTO> frames;
}
