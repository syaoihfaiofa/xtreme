package ai.basic.x1.adapter.port.rpc.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PointCloudTrackingObject {

    private String trackingId;
    private String label;
    private BigDecimal confidence;
    private Double x;
    private Double y;
    private Double z;
    private Double dimX;
    private Double dimY;
    private Double dimZ;
    private Double rotX;
    private Double rotY;
    private Double rotZ;
}
