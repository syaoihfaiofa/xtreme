package ai.basic.x1.adapter.dto;

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
public class DataOrganizeSceneDTO {

    @NotNull(message = "datasetId cannot be null")
    private Long datasetId;

    @NotEmpty(message = "dataIds cannot be null")
    private List<Long> dataIds;

    private String sceneName;
}
