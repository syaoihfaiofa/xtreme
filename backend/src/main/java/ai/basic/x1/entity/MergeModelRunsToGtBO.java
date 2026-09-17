package ai.basic.x1.entity;

import ai.basic.x1.entity.enums.ModelRunMergeModeEnum;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MergeModelRunsToGtBO {

    private Long datasetId;

    private Long sceneId;

    private List<Long> modelRunRecordIds;

    private ModelRunMergeModeEnum mode;
}
