package ai.basic.x1.entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TrackingSeedObjectBO {

    private String trackingId;
    private String modelClass;
    private BigDecimal confidence;
    private PointBO center3D;
    private PointBO rotation3D;
    private PointBO size3D;
}
