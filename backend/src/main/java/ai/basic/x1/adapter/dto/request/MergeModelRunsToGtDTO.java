package ai.basic.x1.adapter.dto.request;

import ai.basic.x1.entity.enums.ModelRunMergeModeEnum;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import javax.validation.constraints.NotEmpty;
import javax.validation.constraints.NotNull;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MergeModelRunsToGtDTO {

    @NotNull
    private Long datasetId;

    @NotNull
    private Long sceneId;

    @NotEmpty
    private List<Long> modelRunRecordIds;

    @NotNull
    private ModelRunMergeModeEnum mode;
}
