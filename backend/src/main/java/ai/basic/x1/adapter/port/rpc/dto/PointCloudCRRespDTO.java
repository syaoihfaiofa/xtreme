package ai.basic.x1.adapter.port.rpc.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PointCloudCRRespDTO {
    private Integer code;
    private String message;
    private Long imageSize;
    private Long binaryPcdSize;
    /** Size of the optional preview binary PCD. Null means converter did not generate one. */
    private Long previewPcdSize;
    /** Number of points in the full binary PCD. */
    private Long pointCount;
    /** Number of points in the preview binary PCD. */
    private Long previewPointCount;
    private Long chunkManifestSize;
    private Integer chunkCount;
    private PointCloudRange pointCloudRange;

}
