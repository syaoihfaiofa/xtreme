package ai.basic.x1.adapter.port.dao.mybatis.model;

import ai.basic.x1.entity.enums.DataAnnotationStatusEnum;
import ai.basic.x1.entity.enums.SplitTypeEnum;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ModelRunFilterData {

    private Integer dataCountRatio;

    /**
     * Exclude the data that already run under this model
     */
    private Boolean isExcludeModelData;

    /**
     * Split type
     */
    private SplitTypeEnum splitType;

    /**
     * Data annotation status
     */
    private DataAnnotationStatusEnum annotationStatus;

    private List<Long> sceneIds;
}
