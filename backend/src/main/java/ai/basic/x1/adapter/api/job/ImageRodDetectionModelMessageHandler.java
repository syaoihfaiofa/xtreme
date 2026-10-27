package ai.basic.x1.adapter.api.job;

import ai.basic.x1.entity.enums.ModelCodeEnum;

/**
 * ROD shares the keypoint-lifted request/response contract; only the model code differs.
 */
public class ImageRodDetectionModelMessageHandler extends ImageKeypointLiftedDetectionModelMessageHandler {

    @Override
    public ModelCodeEnum getModelCodeEnum() {
        return ModelCodeEnum.IMAGE_ROD_DETECTION;
    }
}
