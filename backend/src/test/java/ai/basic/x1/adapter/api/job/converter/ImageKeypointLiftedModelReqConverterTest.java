package ai.basic.x1.adapter.api.job.converter;

import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionReqDTO;
import ai.basic.x1.entity.DataInfoBO;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.RelationFileBO;
import org.junit.jupiter.api.Test;

import java.util.List;

import static ai.basic.x1.util.Constants.FILE;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ImageKeypointLiftedModelReqConverterTest {

    @Test
    void convert_keepsSparseCameraIndexesWithTheirImageUrls() {
        ModelMessageBO message = ModelMessageBO.builder()
                .dataId(9L)
                .dataInfo(DataInfoBO.builder()
                        .id(9L)
                        .content(List.of(
                                fileNode("scene/camera_image_2/frame.jpg", "http://minio/image-2"),
                                fileNode("scene/camera_image_0/frame.jpg", "http://minio/image-0"),
                                fileNode("scene/camera_config/frame.json", "http://minio/camera-config")))
                        .build())
                .build();

        ImageKeypointLiftedDetectionReqDTO request = ImageKeypointLiftedModelReqConverter.convert(message);

        assertEquals(9L, request.getDatas().get(0).getId());
        assertEquals(2, request.getDatas().get(0).getCameras().size());
        assertEquals(0, request.getDatas().get(0).getCameras().get(0).getViewIndex());
        assertEquals("http://minio/image-0", request.getDatas().get(0).getCameras().get(0).getImageUrl());
        assertEquals(2, request.getDatas().get(0).getCameras().get(1).getViewIndex());
        assertEquals("http://minio/image-2", request.getDatas().get(0).getCameras().get(1).getImageUrl());
        assertEquals("http://minio/camera-config", request.getDatas().get(0).getCameraConfigUrl());
    }

    @Test
    void convert_prefersInternalUrlsForModelServiceResources() {
        ModelMessageBO message = ModelMessageBO.builder()
                .dataId(12L)
                .dataInfo(DataInfoBO.builder()
                        .id(12L)
                        .content(List.of(
                                fileNode(
                                        "scene/camera_image_0/frame.jpg",
                                        "http://public/image-0",
                                        "http://minio:9000/image-0"),
                                fileNode(
                                        "scene/camera_config/frame.json",
                                        "http://public/camera-config",
                                        "http://minio:9000/camera-config")))
                        .build())
                .build();

        ImageKeypointLiftedDetectionReqDTO request = ImageKeypointLiftedModelReqConverter.convert(message);

        assertEquals("http://minio:9000/image-0",
                request.getDatas().get(0).getCameras().get(0).getImageUrl());
        assertEquals("http://minio:9000/camera-config",
                request.getDatas().get(0).getCameraConfigUrl());
    }

    @Test
    void convert_rejectsMissingCameraConfig() {
        ModelMessageBO message = ModelMessageBO.builder()
                .dataId(10L)
                .dataInfo(DataInfoBO.builder()
                        .id(10L)
                        .content(List.of(fileNode("scene/camera_image_0/frame.jpg", "http://minio/image-0")))
                        .build())
                .build();

        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class,
                () -> ImageKeypointLiftedModelReqConverter.convert(message));

        assertEquals("dataId=10 must contain exactly one camera_config file, found 0", exception.getMessage());
    }

    @Test
    void convert_rejectsMissingCameraImages() {
        ModelMessageBO message = ModelMessageBO.builder()
                .dataId(11L)
                .dataInfo(DataInfoBO.builder()
                        .id(11L)
                        .content(List.of(fileNode("scene/camera_config/frame.json", "http://minio/camera-config")))
                        .build())
                .build();

        IllegalArgumentException exception = assertThrows(IllegalArgumentException.class,
                () -> ImageKeypointLiftedModelReqConverter.convert(message));

        assertEquals("dataId=11 has no camera_image_N files", exception.getMessage());
    }

    private static DataInfoBO.FileNodeBO fileNode(String path, String url) {
        return fileNode(path, url, null);
    }

    private static DataInfoBO.FileNodeBO fileNode(String path, String url, String internalUrl) {
        RelationFileBO file = new RelationFileBO();
        file.setPath(path);
        file.setUrl(url);
        file.setInternalUrl(internalUrl);
        return DataInfoBO.FileNodeBO.builder().type(FILE).file(file).build();
    }
}
