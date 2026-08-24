package ai.basic.x1.adapter.port.rpc.dto;

import ai.basic.x1.entity.PointBO;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.math.BigDecimal;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ImageKeypointLiftedDetectionRespDTO {
    private Long id;
    private String code;
    private String message;
    private List<ObjectDTO> objects;
    private List<RejectionDTO> rejections;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ObjectDTO {
        private String objType;
        private String modelClass;
        private BigDecimal confidence;
        private PointBO center3D;
        private PointBO size3D;
        private PointBO rotation3D;
        private List<PointBO> points;
        private List<Integer> sourceViewIndexes;
        private List<List<BigDecimal>> sourceKeypoints;
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class RejectionDTO {
        private Integer cameraIndex;
        private Integer detectionIndex;
        private Integer classId;
        private BigDecimal score;
        private String reason;
    }
}
