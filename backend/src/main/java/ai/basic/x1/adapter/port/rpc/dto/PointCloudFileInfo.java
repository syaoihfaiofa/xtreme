package ai.basic.x1.adapter.port.rpc.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PointCloudFileInfo {
    private String pointCloudFile;
    private String uploadImagePath;
    private String uploadBinaryPcdPath;
    /** Presigned PUT URL for the optional low-density binary PCD. */
    private String uploadPreviewPcdPath;
    private String uploadChunkManifestPath;
    private List<ChunkUpload> chunkUploads;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class ChunkUpload {
        private String id;
        private String path;
        private String uploadUrl;
    }
}
