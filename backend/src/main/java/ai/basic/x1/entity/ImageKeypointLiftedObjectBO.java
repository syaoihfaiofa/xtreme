package ai.basic.x1.entity;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.math.BigDecimal;
import java.util.List;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class ImageKeypointLiftedObjectBO extends ModelTaskInfoBO {
    private Long dataId;
    private List<ObjectBO> objects;

    @Data
    @SuperBuilder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ObjectBO {
        private String modelClass;
        private String type;
        private BigDecimal confidence;
        private PointBO center3D;
        private PointBO size3D;
        private PointBO rotation3D;
        private Integer viewIndex;
        private List<Point> points;
        private List<Integer> sourceViewIndexes;
        private List<List<BigDecimal>> sourceKeypoints;
    }

    @Data
    @SuperBuilder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Point {
        private BigDecimal x;
        private BigDecimal y;
        private BigDecimal z;
    }
}
