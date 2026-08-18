package ai.basic.x1.entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SceneResultImportResultBO {

    private Integer totalFiles;

    private Integer matchedCount;

    private Integer unmatchedCount;

    private Integer objectCount;

    private String errorMessage;
}
