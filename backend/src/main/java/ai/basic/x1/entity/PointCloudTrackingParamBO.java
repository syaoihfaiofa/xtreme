package ai.basic.x1.entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PointCloudTrackingParamBO {

    private Long sourceDataId;
    private String direction;
    private List<TrackingSeedObjectBO> objects;
}
