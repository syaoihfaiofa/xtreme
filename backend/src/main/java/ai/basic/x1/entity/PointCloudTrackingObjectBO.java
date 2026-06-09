package ai.basic.x1.entity;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PointCloudTrackingObjectBO extends ModelTaskInfoBO {

    private Long dataId;
    private List<TrackingObjectBO> objects;
}
