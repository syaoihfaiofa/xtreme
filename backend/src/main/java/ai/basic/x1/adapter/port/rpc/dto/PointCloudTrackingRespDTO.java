package ai.basic.x1.adapter.port.rpc.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PointCloudTrackingRespDTO {

    private Long id;
    private String code;
    private String message;
    private List<PointCloudTrackingObject> objects;
}
