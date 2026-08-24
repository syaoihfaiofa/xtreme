package ai.basic.x1.entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Per-frame ego pose (x, y, z, yaw, roll, pitch), sourced from a Scene's uploaded location.txt.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SceneLocationBO {

    private Long dataId;

    private Double posX;

    private Double posY;

    private Double posZ;

    private Double yaw;

    private Double roll;

    private Double pitch;
}
