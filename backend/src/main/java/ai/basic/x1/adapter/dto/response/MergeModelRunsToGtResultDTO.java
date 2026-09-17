package ai.basic.x1.adapter.dto.response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class MergeModelRunsToGtResultDTO {

    private long writtenObjectCount;

    private long frameCount;

    private List<Long> skippedFrames;

    private Long snapshotId;
}
