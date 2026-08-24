package ai.basic.x1.adapter.api.job;

import ai.basic.x1.adapter.port.rpc.ImageKeypointLiftedDetectionHttpCaller;
import ai.basic.x1.entity.DataInfoBO;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.RelationFileBO;
import ai.basic.x1.usecase.exception.UsecaseException;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.IOException;
import java.util.List;

import static ai.basic.x1.util.Constants.FILE;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;

class ImageKeypointLiftedDetectionModelMessageHandlerTest {

    @Test
    void callRemoteService_wrapsHttpTimeoutWithDataAndUrlContext() throws Exception {
        ImageKeypointLiftedDetectionHttpCaller caller = mock(ImageKeypointLiftedDetectionHttpCaller.class);
        doThrow(new IOException("request timed out"))
                .when(caller).call(any(), eq("http://model/recognition"));
        ImageKeypointLiftedDetectionModelMessageHandler handler = handlerWith(caller);

        UsecaseException exception = assertThrows(UsecaseException.class,
                () -> handler.callRemoteService(validMessage()));

        org.junit.jupiter.api.Assertions.assertTrue(exception.getMessage().contains("dataId=9"));
        org.junit.jupiter.api.Assertions.assertTrue(exception.getMessage().contains("http://model/recognition"));
        org.junit.jupiter.api.Assertions.assertTrue(exception.getMessage().contains("request timed out"));
    }

    @Test
    void callRemoteService_propagatesHttpServiceError() throws Exception {
        ImageKeypointLiftedDetectionHttpCaller caller = mock(ImageKeypointLiftedDetectionHttpCaller.class);
        doThrow(new UsecaseException("keypoint-lifted model request failed: status=500, response=unavailable"))
                .when(caller).call(any(), eq("http://model/recognition"));
        ImageKeypointLiftedDetectionModelMessageHandler handler = handlerWith(caller);

        UsecaseException exception = assertThrows(UsecaseException.class,
                () -> handler.callRemoteService(validMessage()));

        org.junit.jupiter.api.Assertions.assertTrue(exception.getMessage().contains("status=500"));
    }

    private static ImageKeypointLiftedDetectionModelMessageHandler handlerWith(
            ImageKeypointLiftedDetectionHttpCaller caller) {
        ImageKeypointLiftedDetectionModelMessageHandler handler =
                new ImageKeypointLiftedDetectionModelMessageHandler();
        ReflectionTestUtils.setField(handler, "modelHttpCaller", caller);
        return handler;
    }

    private static ModelMessageBO validMessage() {
        return ModelMessageBO.builder()
                .dataId(9L)
                .url("http://model/recognition")
                .dataInfo(DataInfoBO.builder().id(9L).content(List.of(
                        fileNode("scene/camera_image_0/frame.jpg", "http://minio/image-0"),
                        fileNode("scene/camera_config/frame.json", "http://minio/camera-config"))).build())
                .build();
    }

    private static DataInfoBO.FileNodeBO fileNode(String path, String url) {
        RelationFileBO file = new RelationFileBO();
        file.setPath(path);
        file.setUrl(url);
        return DataInfoBO.FileNodeBO.builder().type(FILE).file(file).build();
    }
}
