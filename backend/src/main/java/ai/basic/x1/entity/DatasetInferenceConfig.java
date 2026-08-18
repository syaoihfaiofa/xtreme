package ai.basic.x1.entity;

import ai.basic.x1.entity.enums.InferenceMotionModeEnum;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DatasetInferenceConfig {

    private Long modelId;

    @Builder.Default
    private Double syncDistance = 12.0;

    @Builder.Default
    private Integer maxOutsideFrames = 50;

    @Builder.Default
    private Double associationIou = 0.3;

    @Builder.Default
    private Double minConfidence = 0.5;

    @Builder.Default
    private List<ClassMapping> classMappings = new ArrayList<>();

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ClassMapping {

        private String modelClassCode;

        private Long datasetClassId;

        private InferenceMotionModeEnum motionMode;
    }
}
