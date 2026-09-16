package ai.basic.x1.adapter.api.job.converter;

import ai.basic.x1.adapter.port.rpc.dto.ParkingSlotDetectionReqDTO;
import ai.basic.x1.entity.DataInfoBO;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.RelationFileBO;

import java.util.ArrayList;
import java.util.List;

import static ai.basic.x1.util.Constants.DIRECTORY;
import static ai.basic.x1.util.Constants.FILE;

/** Builds an inference request from optional stitched imagery plus its matching point cloud. */
public final class ParkingSlotDetectionModelReqConverter {
    private ParkingSlotDetectionModelReqConverter() {
    }

    public static ParkingSlotDetectionReqDTO convert(ModelMessageBO message) {
        DataInfoBO dataInfo = message.getDataInfo();
        if (dataInfo == null || dataInfo.getContent() == null) {
            throw new IllegalArgumentException("dataId=" + message.getDataId() + " has no Fusion content");
        }
        List<RelationFileBO> stitched = new ArrayList<>();
        List<RelationFileBO> pointClouds = new ArrayList<>();
        for (DataInfoBO.FileNodeBO node : dataInfo.getContent()) {
            collect(node, stitched, pointClouds);
        }
        if (stitched.size() != 1) {
            throw new IllegalArgumentException("dataId=" + message.getDataId()
                    + " must contain exactly one stitched_img file, found " + stitched.size());
        }
        if (pointClouds.size() != 1) {
            throw new IllegalArgumentException("dataId=" + message.getDataId()
                    + " must contain exactly one lidar_point_cloud file, found " + pointClouds.size());
        }
        return ParkingSlotDetectionReqDTO.builder().datas(List.of(ParkingSlotDetectionReqDTO.FrameDTO.builder()
                .id(dataInfo.getId())
                .stitchedImageUrl(resourceUrl(stitched.get(0)))
                .pointCloudUrl(resourceUrl(pointClouds.get(0)))
                .build())).build();
    }

    /** stitched_img is optional in Fusion uploads, so its absence is a successful no-op for this model. */
    public static boolean hasStitchedImage(DataInfoBO dataInfo) {
        if (dataInfo == null || dataInfo.getContent() == null) return false;
        List<RelationFileBO> stitched = new ArrayList<>();
        for (DataInfoBO.FileNodeBO node : dataInfo.getContent()) collect(node, stitched, new ArrayList<>());
        return !stitched.isEmpty();
    }

    private static void collect(DataInfoBO.FileNodeBO node, List<RelationFileBO> stitched, List<RelationFileBO> clouds) {
        if (FILE.equals(node.getType()) && node.getFile() != null && node.getFile().getPath() != null) {
            String path = node.getFile().getPath().replace('\\', '/');
            if (path.matches("(?:^|.*/)stitched_img/[^/]+$")) stitched.add(node.getFile());
            // Fusion uploads use lidar_point_cloud_0 (and possibly other numbered lidar folders).
            if (path.matches("(?:^|.*/)lidar_point_cloud(?:_\\d+)?/[^/]+$")) clouds.add(node.getFile());
        }
        if (DIRECTORY.equals(node.getType()) && node.getFiles() != null) {
            for (DataInfoBO.FileNodeBO child : node.getFiles()) collect(child, stitched, clouds);
        }
    }

    private static String resourceUrl(RelationFileBO file) {
        String url = file.getInternalUrl() != null && !file.getInternalUrl().isEmpty() ? file.getInternalUrl() : file.getUrl();
        if (url == null || url.isEmpty()) throw new IllegalArgumentException("input file has no resource URL: " + file.getPath());
        return url;
    }
}
