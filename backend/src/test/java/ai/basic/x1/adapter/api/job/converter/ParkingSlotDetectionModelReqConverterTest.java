package ai.basic.x1.adapter.api.job.converter;

import ai.basic.x1.adapter.port.rpc.dto.ParkingSlotDetectionReqDTO;
import ai.basic.x1.entity.DataInfoBO;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.RelationFileBO;
import org.junit.jupiter.api.Test;

import java.util.List;

import static ai.basic.x1.util.Constants.FILE;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ParkingSlotDetectionModelReqConverterTest {
    @Test
    void convert_selectsSameFrameStitchedImageAndPointCloud() {
        ParkingSlotDetectionReqDTO request = ParkingSlotDetectionModelReqConverter.convert(ModelMessageBO.builder()
                .dataId(42L).dataInfo(DataInfoBO.builder().id(42L).content(List.of(
                        file("stitched_img/20260814.jpg", "http://public/stitched", "http://minio/stitched"),
                        file("lidar_point_cloud/20260814.pcd", "http://public/cloud", "http://minio/cloud"),
                        file("camera_image/20260814_0.jpg", "http://public/camera", null))).build()).build());

        assertEquals(42L, request.getDatas().get(0).getId());
        assertEquals("http://minio/stitched", request.getDatas().get(0).getStitchedImageUrl());
        assertEquals("http://minio/cloud", request.getDatas().get(0).getPointCloudUrl());
    }

    @Test
    void convert_acceptsNumberedLidarPointCloudDirectory() {
        ParkingSlotDetectionReqDTO request = ParkingSlotDetectionModelReqConverter.convert(ModelMessageBO.builder()
                .dataId(42L).dataInfo(DataInfoBO.builder().id(42L).content(List.of(
                        file("lidar_point_cloud_0/stitched_img/20260814.jpg", "http://stitched", null),
                        file("lidar_point_cloud_0/20260814.pcd", "http://cloud", null))).build()).build());

        assertEquals("http://cloud", request.getDatas().get(0).getPointCloudUrl());
    }

    @Test
    void convert_rejectsFramesWithoutOptionalStitchedImage() {
        ModelMessageBO message = ModelMessageBO.builder().dataId(7L)
                .dataInfo(DataInfoBO.builder().id(7L).content(List.of(file("lidar_point_cloud/frame.pcd", "http://cloud", null))).build())
                .build();
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> ParkingSlotDetectionModelReqConverter.convert(message));
        assertEquals("dataId=7 must contain exactly one stitched_img file, found 0", error.getMessage());
        assertEquals(false, ParkingSlotDetectionModelReqConverter.hasStitchedImage(message.getDataInfo()));
    }

    private static DataInfoBO.FileNodeBO file(String path, String url, String internalUrl) {
        RelationFileBO file = new RelationFileBO();
        file.setPath(path);
        file.setUrl(url);
        file.setInternalUrl(internalUrl);
        return DataInfoBO.FileNodeBO.builder().type(FILE).file(file).build();
    }
}
