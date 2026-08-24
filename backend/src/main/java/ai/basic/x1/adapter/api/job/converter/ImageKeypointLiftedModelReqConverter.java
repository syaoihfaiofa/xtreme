package ai.basic.x1.adapter.api.job.converter;

import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionReqDTO;
import ai.basic.x1.entity.DataInfoBO;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.RelationFileBO;

import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static ai.basic.x1.util.Constants.DIRECTORY;
import static ai.basic.x1.util.Constants.FILE;

public class ImageKeypointLiftedModelReqConverter {
    private static final Pattern CAMERA_IMAGE_DIRECTORY = Pattern.compile("(^|[\\\\/])camera_image_(\\d+)([\\\\/]|$)");
    private static final Pattern CAMERA_CONFIG_DIRECTORY = Pattern.compile("(^|[\\\\/])camera_config([\\\\/]|$)");

    private ImageKeypointLiftedModelReqConverter() {
    }

    public static ImageKeypointLiftedDetectionReqDTO convert(ModelMessageBO message) {
        DataInfoBO dataInfo = message.getDataInfo();
        if (dataInfo == null || dataInfo.getContent() == null) {
            throw new IllegalArgumentException("dataId=" + message.getDataId() + " has no Fusion content");
        }

        TreeMap<Integer, String> imageUrls = new TreeMap<>();
        List<String> cameraConfigUrls = new ArrayList<>();
        for (DataInfoBO.FileNodeBO node : dataInfo.getContent()) {
            collectFiles(node, imageUrls, cameraConfigUrls);
        }
        if (imageUrls.isEmpty()) {
            throw new IllegalArgumentException("dataId=" + message.getDataId() + " has no camera_image_N files");
        }
        if (cameraConfigUrls.size() != 1) {
            throw new IllegalArgumentException("dataId=" + message.getDataId()
                    + " must contain exactly one camera_config file, found " + cameraConfigUrls.size());
        }
        return ImageKeypointLiftedDetectionReqDTO.builder()
                .datas(List.of(ImageKeypointLiftedDetectionReqDTO.FrameDTO.builder()
                        .id(dataInfo.getId())
                        .cameras(toCameraDtos(imageUrls))
                        .cameraConfigUrl(cameraConfigUrls.get(0))
                        .build()))
                .build();
    }

    private static List<ImageKeypointLiftedDetectionReqDTO.CameraDTO> toCameraDtos(
            TreeMap<Integer, String> imageUrls) {
        List<ImageKeypointLiftedDetectionReqDTO.CameraDTO> cameras = new ArrayList<>(imageUrls.size());
        imageUrls.forEach((viewIndex, imageUrl) -> cameras.add(
                ImageKeypointLiftedDetectionReqDTO.CameraDTO.builder()
                        .viewIndex(viewIndex)
                        .imageUrl(imageUrl)
                        .build()));
        return cameras;
    }

    private static void collectFiles(
            DataInfoBO.FileNodeBO node,
            TreeMap<Integer, String> imageUrls,
            List<String> cameraConfigUrls) {
        if (FILE.equals(node.getType())) {
            collectFile(node.getFile(), imageUrls, cameraConfigUrls);
        }
        if (DIRECTORY.equals(node.getType()) && node.getFiles() != null) {
            for (DataInfoBO.FileNodeBO child : node.getFiles()) {
                collectFiles(child, imageUrls, cameraConfigUrls);
            }
        }
    }

    private static void collectFile(
            RelationFileBO file,
            TreeMap<Integer, String> imageUrls,
            List<String> cameraConfigUrls) {
        if (file == null || file.getPath() == null) {
            return;
        }
        String resourceUrl = getResourceUrl(file);
        if (resourceUrl == null) {
            return;
        }
        Matcher imageMatcher = CAMERA_IMAGE_DIRECTORY.matcher(file.getPath());
        if (imageMatcher.find()) {
            int cameraIndex = Integer.parseInt(imageMatcher.group(2));
            String previousUrl = imageUrls.putIfAbsent(cameraIndex, resourceUrl);
            if (previousUrl != null) {
                throw new IllegalArgumentException("camera_image_" + cameraIndex + " has multiple files");
            }
            return;
        }
        if (CAMERA_CONFIG_DIRECTORY.matcher(file.getPath()).find()) {
            cameraConfigUrls.add(resourceUrl);
        }
    }

    private static String getResourceUrl(RelationFileBO file) {
        if (file.getInternalUrl() != null && !file.getInternalUrl().isEmpty()) {
            return file.getInternalUrl();
        }
        if (file.getUrl() != null && !file.getUrl().isEmpty()) {
            return file.getUrl();
        }
        return null;
    }
}
