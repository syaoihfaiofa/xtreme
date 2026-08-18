package ai.basic.x1.adapter.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SceneResultImportResultDTO {

    private Integer totalFiles;

    private Integer matchedCount;

    private Integer unmatchedCount;

    private Integer objectCount;

    private String errorMessage;
}
