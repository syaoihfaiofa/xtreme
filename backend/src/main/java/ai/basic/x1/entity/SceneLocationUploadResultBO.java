package ai.basic.x1.entity;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SceneLocationUploadResultBO {

    /**
     * Total non-blank lines parsed from the uploaded file
     */
    private Integer totalLines;

    /**
     * Lines successfully matched to a frame in the scene and stored
     */
    private Integer matchedCount;

    /**
     * Lines that were well-formed but didn't match any frame name in the scene
     */
    private Integer unmatchedCount;

    /**
     * Lines that couldn't be parsed (bad format)
     */
    private Integer invalidCount;
}
