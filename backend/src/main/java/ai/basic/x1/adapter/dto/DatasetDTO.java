package ai.basic.x1.adapter.dto;

import ai.basic.x1.entity.DatasetInferenceConfig;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * @author fyb
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DatasetDTO {

    /**
     * Dataset id
     */
    private Long id;

    /**
     * Dataset name
     */
    private String name;

    /**
     * Dataset type
     */
    private String type;

    /**
     * Whether cross-frame static/dynamic object sync is enabled (only meaningful for LIDAR_FUSION)
     */
    private Boolean syncMode;

    private Boolean inferenceMode;

    private DatasetInferenceConfig inferenceConfig;

    /**
     * Dataset description
     */
    private String description;

    /**
     * Annotated data count
     */
    private Integer annotatedCount;

    /**
     * Not annotate data count
     */
    private Integer notAnnotatedCount;

    /**
     * Invalid data count
     */
    private Integer invalidCount;

    /**
     * Data count
     */
    private Integer itemCount;

    /**
     * Data details under dataset
     */
    private List<DataInfoDTO> datas;
}
