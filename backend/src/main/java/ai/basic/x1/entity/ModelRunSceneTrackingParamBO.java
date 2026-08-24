package ai.basic.x1.entity;

import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
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
public class ModelRunSceneTrackingParamBO {

    private Double minConfidence;
    private Double maxConfidence;
    private Double associationIou;
    private Double associationDistance;
    private Double syncDistance;

    @Builder.Default
    private List<String> classes = new ArrayList<>();

    @Builder.Default
    private List<DatasetInferenceConfig.ClassMapping> classMappings = new ArrayList<>();

    public static ModelRunSceneTrackingParamBO parse(JSONObject resultFilterParam) {
        return JSONUtil.toBean(resultFilterParam, ModelRunSceneTrackingParamBO.class);
    }

    public static boolean hasClassMappings(JSONObject resultFilterParam) {
        return resultFilterParam != null
                && resultFilterParam.getJSONArray("classMappings") != null
                && !resultFilterParam.getJSONArray("classMappings").isEmpty();
    }

    public DatasetInferenceConfig toInferenceConfig(Long modelId) {
        return DatasetInferenceConfig.builder()
                .modelId(modelId)
                .minConfidence(minConfidence == null ? 0.5 : minConfidence)
                .associationIou(associationIou == null ? 0.3 : associationIou)
                .associationDistance(associationDistance == null ? 0.5 : associationDistance)
                .syncDistance(syncDistance == null ? 12.0 : syncDistance)
                .maxOutsideFrames(50)
                .classMappings(classMappings)
                .build();
    }
}
