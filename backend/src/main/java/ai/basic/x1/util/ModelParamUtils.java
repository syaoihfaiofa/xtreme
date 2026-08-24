package ai.basic.x1.util;

import ai.basic.x1.adapter.dto.PreModelParamDTO;
import ai.basic.x1.entity.DatasetInferenceConfig;
import ai.basic.x1.entity.enums.ModelCodeEnum;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;

import java.util.List;

/**
 * @author zhujh
 */
public class ModelParamUtils {

    public static void valid(JSONObject resultFilterParam, ModelCodeEnum modelCode) {
        if (JSONUtil.isNull(resultFilterParam)) {
            return;
        }
        switch (modelCode) {
            case LIDAR_DETECTION:
            case IMAGE_DETECTION:
            case IMAGE_KEYPOINT_LIFTED_DETECTION:
                var modelClass = DefaultConverter.convert(resultFilterParam, PreModelParamDTO.class);
                ValidateUtil.validate(modelClass);
                if (modelClass.getMinConfidence() != null && modelClass.getMaxConfidence() != null
                        && modelClass.getMinConfidence().compareTo(modelClass.getMaxConfidence()) > 0) {
                    throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                            "minConfidence must be less than or equal to maxConfidence");
                }
                validateSceneTrackingMappings(resultFilterParam, modelClass.getClasses());
                break;
            case LIDAR_TRACKING:
                break;
            default:
                throw new UsecaseException(UsecaseCode.UNKNOWN, "Not support the model code: " + modelCode);
        }
    }

    private static void validateSceneTrackingMappings(JSONObject resultFilterParam, List<String> selectedClasses) {
        if (resultFilterParam.getJSONArray("classMappings") == null) {
            return;
        }
        List<DatasetInferenceConfig.ClassMapping> mappings = JSONUtil.toList(
                resultFilterParam.getJSONArray("classMappings"),
                DatasetInferenceConfig.ClassMapping.class);
        if (CollUtil.isEmpty(mappings)) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "classMappings cannot be empty for a scene tracking Model Run");
        }
        Double associationIou = resultFilterParam.getDouble("associationIou");
        if (associationIou != null && (associationIou < 0.0 || associationIou > 1.0)) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                    "associationIou must be between 0 and 1: associationIou=" + associationIou);
        }
        for (DatasetInferenceConfig.ClassMapping mapping : mappings) {
            if (mapping == null || StrUtil.isBlank(mapping.getModelClassCode())
                    || mapping.getMotionMode() == null) {
                throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                        "Invalid scene tracking class mapping: mapping=" + JSONUtil.toJsonStr(mapping));
            }
            if (!selectedClasses.contains(mapping.getModelClassCode())) {
                throw new UsecaseException(UsecaseCode.PARAM_ERROR,
                        "Mapped model class is not selected: modelClassCode=" + mapping.getModelClassCode());
            }
        }
    }
}
