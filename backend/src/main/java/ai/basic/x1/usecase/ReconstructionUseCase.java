package ai.basic.x1.usecase;

import ai.basic.x1.adapter.dto.ReconstructionAnnotationDTO;
import ai.basic.x1.adapter.dto.ReconstructionFrameDTO;
import ai.basic.x1.adapter.dto.ReconstructionFrameImageDTO;
import ai.basic.x1.adapter.dto.ReconstructionSceneDTO;
import ai.basic.x1.adapter.port.dao.DatasetDAO;
import ai.basic.x1.adapter.port.dao.ReconstructionAnnotationDAO;
import ai.basic.x1.adapter.port.dao.ReconstructionFrameDAO;
import ai.basic.x1.adapter.port.dao.ReconstructionFrameImageDAO;
import ai.basic.x1.adapter.port.dao.ReconstructionSceneDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.ReconstructionAnnotation;
import ai.basic.x1.adapter.port.dao.mybatis.model.ReconstructionFrame;
import ai.basic.x1.adapter.port.dao.mybatis.model.ReconstructionFrameImage;
import ai.basic.x1.adapter.port.dao.mybatis.model.ReconstructionScene;
import ai.basic.x1.adapter.port.minio.MinioProp;
import ai.basic.x1.adapter.port.minio.MinioService;
import ai.basic.x1.entity.FileBO;
import ai.basic.x1.entity.RelationFileBO;
import ai.basic.x1.entity.enums.DatasetTypeEnum;
import ai.basic.x1.usecase.exception.UsecaseException;
import ai.basic.x1.util.DecompressionFileUtils;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.IdUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HttpUtil;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import javax.imageio.ImageIO;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Isolated storage and API workflow for RECONSTRUCTION_FUSION.  This class
 * deliberately never writes the legacy data or data_annotation_object tables.
 */
@Slf4j
public class ReconstructionUseCase {

    private static final Pattern CAMERA_DIRECTORY = Pattern.compile("camera_image_(\\d+)", Pattern.CASE_INSENSITIVE);
    /** Existing LiDAR Fusion flat naming: <frame-name>_<camera-index>.<image-extension>. */
    private static final Pattern FLAT_CAMERA_IMAGE = Pattern.compile("^(.+)_(\\d+)$");
    private static final Pattern TIMESTAMP = Pattern.compile("_(\\d+)_(\\d+)$");

    @Autowired private DatasetDAO datasetDAO;
    @Autowired private ReconstructionSceneDAO sceneDAO;
    @Autowired private ReconstructionFrameDAO frameDAO;
    @Autowired private ReconstructionFrameImageDAO frameImageDAO;
    @Autowired private ReconstructionAnnotationDAO annotationDAO;
    @Autowired private FileUseCase fileUseCase;
    @Autowired private MinioService minioService;
    @Autowired private MinioProp minioProp;

    @Value("${file.tempPath:/tmp/xtreme1/}")
    private String tempPath;

    @Value("${upload.url.whitelist:}")
    private String uploadUrlWhitelist;

    /** Downloads and imports an archive synchronously so callers get actionable validation errors. */
    @Transactional(rollbackFor = Exception.class)
    public List<Long> upload(Long datasetId, String fileUrl, Long userId) {
        ensureReconstructionDataset(datasetId);
        if (!UploadDataUseCase.checkUrlIsValid(uploadUrlWhitelist, fileUrl)) {
            throw new UsecaseException("reconstruction archive URL is not permitted");
        }
        String workDir = tempPath + "reconstruction-" + IdUtil.fastSimpleUUID() + "/";
        String archivePath = workDir + "archive" + archiveSuffix(fileUrl);
        try {
            FileUtil.mkParentDirs(archivePath);
            HttpUtil.downloadFileFromUrl(fileUrl, FileUtil.file(archivePath));
            return importArchive(datasetId, userId, workDir, archivePath);
        } catch (IOException e) {
            throw new UsecaseException("reconstruction archive import failed: " + e.getMessage());
        } finally {
            FileUtil.clean(workDir);
        }
    }

    /** Direct upload is intentionally separate from the legacy /data upload endpoint. */
    @Transactional(rollbackFor = Exception.class)
    public List<Long> uploadFile(Long datasetId, MultipartFile archive, Long userId) {
        ensureReconstructionDataset(datasetId);
        if (archive == null || archive.isEmpty()) {
            throw new UsecaseException("reconstruction archive cannot be empty");
        }
        String workDir = tempPath + "reconstruction-" + IdUtil.fastSimpleUUID() + "/";
        String archivePath = workDir + "archive" + archiveSuffix(archive.getOriginalFilename());
        try {
            FileUtil.mkParentDirs(archivePath);
            archive.transferTo(FileUtil.file(archivePath));
            return importArchive(datasetId, userId, workDir, archivePath);
        } catch (IOException e) {
            throw new UsecaseException("reconstruction archive import failed: " + e.getMessage());
        } finally {
            FileUtil.clean(workDir);
        }
    }

    private List<Long> importArchive(Long datasetId, Long userId, String workDir, String archivePath) throws IOException {
        DecompressionFileUtils.decompress(archivePath, workDir);
        List<File> sceneDirectories = findSceneDirectories(new File(workDir));
        if (sceneDirectories.isEmpty()) {
            throw new UsecaseException("archive contains no scene with global_point_cloud, camera_config and location");
        }
        List<Long> ids = new ArrayList<>();
        for (File sceneDirectory : sceneDirectories) {
            ids.add(importScene(datasetId, userId, workDir, sceneDirectory));
        }
        return ids;
    }

    public List<ReconstructionSceneDTO> listScenes(Long datasetId) {
        ensureReconstructionDataset(datasetId);
        return sceneDAO.list(Wrappers.lambdaQuery(ReconstructionScene.class)
                        .eq(ReconstructionScene::getDatasetId, datasetId)
                        .orderByAsc(ReconstructionScene::getName))
                .stream().map(scene -> toSceneDto(scene, false)).collect(Collectors.toList());
    }

    public ReconstructionSceneDTO getScene(Long sceneId) {
        return toSceneDto(requireScene(sceneId), true);
    }

    public List<ReconstructionAnnotationDTO> listAnnotations(Long sceneId) {
        ReconstructionScene scene = requireScene(sceneId);
        return annotationDAO.list(Wrappers.lambdaQuery(ReconstructionAnnotation.class)
                        .eq(ReconstructionAnnotation::getSceneId, scene.getId())
                        .orderByAsc(ReconstructionAnnotation::getId))
                .stream().map(this::toAnnotationDto).collect(Collectors.toList());
    }

    @Transactional(rollbackFor = Exception.class)
    public List<ReconstructionAnnotationDTO> saveAnnotations(Long sceneId,
                                                               Collection<ReconstructionAnnotationDTO> annotations,
                                                               Long userId) {
        ReconstructionScene scene = requireScene(sceneId);
        if (annotations == null || annotations.isEmpty()) {
            return List.of();
        }
        List<ReconstructionAnnotationDTO> result = new ArrayList<>();
        for (ReconstructionAnnotationDTO dto : annotations) {
            if (dto.getGeometry() == null || dto.getClassId() == null) {
                throw new UsecaseException("annotation classId and geometry are required");
            }
            ReconstructionAnnotation annotation;
            if (dto.getId() == null) {
                annotation = ReconstructionAnnotation.builder()
                        .datasetId(scene.getDatasetId()).sceneId(sceneId).classId(dto.getClassId())
                        .geometry(dto.getGeometry()).classAttributes(dto.getClassAttributes())
                        .createdAt(OffsetDateTime.now()).createdBy(userId)
                        .updatedAt(OffsetDateTime.now()).updatedBy(userId).build();
                annotationDAO.save(annotation);
            } else {
                annotation = annotationDAO.getById(dto.getId());
                if (annotation == null || !sceneId.equals(annotation.getSceneId())) {
                    throw new UsecaseException("annotation does not belong to reconstruction scene");
                }
                annotation.setClassId(dto.getClassId());
                annotation.setGeometry(dto.getGeometry());
                annotation.setClassAttributes(dto.getClassAttributes());
                annotation.setUpdatedAt(OffsetDateTime.now());
                annotation.setUpdatedBy(userId);
                annotationDAO.updateById(annotation);
            }
            result.add(toAnnotationDto(annotation));
        }
        return result;
    }

    @Transactional(rollbackFor = Exception.class)
    public void deleteAnnotation(Long sceneId, Long annotationId) {
        ReconstructionAnnotation annotation = annotationDAO.getById(annotationId);
        if (annotation == null || !sceneId.equals(annotation.getSceneId())) {
            throw new UsecaseException("annotation does not belong to reconstruction scene");
        }
        annotationDAO.removeById(annotationId);
    }

    private Long importScene(Long datasetId, Long userId, String workDir, File sceneDir) throws IOException {
        File pointCloud = exactlyOnePcd(new File(sceneDir, "global_point_cloud"));
        File cameraConfig = exactlyOneJson(new File(sceneDir, "camera_config"));
        File location = new File(sceneDir, "location/location.txt");
        if (!location.isFile()) {
            throw new UsecaseException("scene " + sceneDir.getName() + " has no location/location.txt");
        }
        Map<Long, Pose> poses = parseLocations(Files.readAllLines(location.toPath(), StandardCharsets.UTF_8));
        if (poses.isEmpty()) {
            throw new UsecaseException("scene " + sceneDir.getName() + " has no valid location samples");
        }
        Map<Long, List<CameraImage>> imagesByTimestamp = collectImages(sceneDir);
        imagesByTimestamp.keySet().removeIf(timestamp -> !poses.containsKey(timestamp));
        if (imagesByTimestamp.isEmpty()) {
            throw new UsecaseException("scene " + sceneDir.getName() + " has no timestamped images matching location.txt");
        }

        List<File> assets = new ArrayList<>();
        assets.add(pointCloud);
        assets.add(cameraConfig);
        imagesByTimestamp.values().forEach(images -> images.forEach(image -> assets.add(image.file)));
        List<FileBO> stored = storeAssets(workDir, datasetId, userId, assets);
        Map<String, FileBO> storedBySource = new HashMap<>();
        for (int i = 0; i < assets.size(); i++) {
            storedBySource.put(assets.get(i).getAbsolutePath(), stored.get(i));
        }

        ReconstructionScene scene = ReconstructionScene.builder().datasetId(datasetId).name(sceneDir.getName())
                .pointCloudFileId(storedBySource.get(pointCloud.getAbsolutePath()).getId())
                .cameraConfigFileId(storedBySource.get(cameraConfig.getAbsolutePath()).getId())
                .createdBy(userId).updatedBy(userId).build();
        sceneDAO.save(scene);

        List<Long> orderedTimestamps = new ArrayList<>(imagesByTimestamp.keySet());
        orderedTimestamps.sort(Comparator.naturalOrder());
        for (Long timestamp : orderedTimestamps) {
            Pose pose = poses.get(timestamp);
            ReconstructionFrame frame = ReconstructionFrame.builder().sceneId(scene.getId()).timestampNs(timestamp)
                    .posX(pose.x).posY(pose.y).posZ(pose.z).yaw(pose.yaw).roll(pose.roll).pitch(pose.pitch).build();
            frameDAO.save(frame);
            List<ReconstructionFrameImage> frameImages = imagesByTimestamp.get(timestamp).stream()
                    .map(image -> ReconstructionFrameImage.builder().frameId(frame.getId()).cameraIndex(image.cameraIndex)
                            .fileId(storedBySource.get(image.file.getAbsolutePath()).getId()).build())
                    .collect(Collectors.toList());
            frameImageDAO.saveBatch(frameImages);
        }
        return scene.getId();
    }

    private List<FileBO> storeAssets(String workDir, Long datasetId, Long userId, List<File> assets) throws IOException {
        String root = userId + "/" + datasetId + "/reconstruction";
        try {
            minioService.uploadFileList(minioProp.getBucketName(), root, workDir, assets);
        } catch (Exception e) {
            throw new UsecaseException("reconstruction asset upload failed: " + e.getMessage());
        }
        List<FileBO> files = new ArrayList<>();
        String normalizedRoot = new File(workDir).getAbsolutePath();
        for (File asset : assets) {
            String absolute = asset.getAbsolutePath();
            String relative = absolute.substring(normalizedRoot.length()).replace(File.separatorChar, '/');
            String path = root + relative;
            var builder = FileBO.builder().name(asset.getName()).originalName(asset.getName())
                    .path(path).zipPath(relative).bucketName(minioProp.getBucketName())
                    .type(FileUtil.getMimeType(asset.getAbsolutePath())).size(asset.length());
            if (isImage(asset)) {
                var image = ImageIO.read(asset);
                if (image != null) {
                    builder.extraInfo(JSONUtil.createObj().set("width", image.getWidth()).set("height", image.getHeight()));
                }
            }
            files.add(builder.build());
        }
        return fileUseCase.saveBatchFile(userId, files);
    }

    private ReconstructionSceneDTO toSceneDto(ReconstructionScene scene, boolean includeFrames) {
        RelationFileBO pointCloud = fileUseCase.findById(scene.getPointCloudFileId());
        RelationFileBO cameraConfig = fileUseCase.findById(scene.getCameraConfigFileId());
        ReconstructionSceneDTO.ReconstructionSceneDTOBuilder builder = ReconstructionSceneDTO.builder().id(scene.getId())
                .datasetId(scene.getDatasetId()).name(scene.getName()).pointCloudUrl(pointCloud.getUrl())
                .cameraConfigUrl(cameraConfig.getUrl());
        if (includeFrames) {
            List<ReconstructionFrame> frames = frameDAO.list(Wrappers.lambdaQuery(ReconstructionFrame.class)
                    .eq(ReconstructionFrame::getSceneId, scene.getId()).orderByAsc(ReconstructionFrame::getTimestampNs));
            Map<Long, List<ReconstructionFrameImage>> images = frameImageDAO.list(
                    Wrappers.lambdaQuery(ReconstructionFrameImage.class).in(ReconstructionFrameImage::getFrameId,
                            frames.stream().map(ReconstructionFrame::getId).collect(Collectors.toList())))
                    .stream().collect(Collectors.groupingBy(ReconstructionFrameImage::getFrameId));
            builder.frames(frames.stream().map(frame -> ReconstructionFrameDTO.builder().id(frame.getId())
                    .timestampNs(frame.getTimestampNs()).posX(frame.getPosX()).posY(frame.getPosY()).posZ(frame.getPosZ())
                    .yaw(frame.getYaw()).roll(frame.getRoll()).pitch(frame.getPitch())
                    .images(images.getOrDefault(frame.getId(), List.of()).stream().map(image ->
                            ReconstructionFrameImageDTO.builder().cameraIndex(image.getCameraIndex())
                                    .url(fileUseCase.findById(image.getFileId()).getUrl()).build())
                            .sorted(Comparator.comparing(ReconstructionFrameImageDTO::getCameraIndex)).collect(Collectors.toList()))
                    .build()).collect(Collectors.toList()));
        }
        return builder.build();
    }

    private ReconstructionAnnotationDTO toAnnotationDto(ReconstructionAnnotation annotation) {
        ReconstructionAnnotationDTO dto = new ReconstructionAnnotationDTO();
        dto.setId(annotation.getId());
        dto.setClassId(annotation.getClassId());
        dto.setGeometry(annotation.getGeometry());
        dto.setClassAttributes(annotation.getClassAttributes());
        return dto;
    }

    private ReconstructionScene requireScene(Long sceneId) {
        ReconstructionScene scene = sceneDAO.getById(sceneId);
        if (scene == null) throw new UsecaseException("reconstruction scene not found");
        ensureReconstructionDataset(scene.getDatasetId());
        return scene;
    }

    private void ensureReconstructionDataset(Long datasetId) {
        var dataset = datasetDAO.getById(datasetId);
        if (dataset == null || !DatasetTypeEnum.RECONSTRUCTION_FUSION.equals(dataset.getType())) {
            throw new UsecaseException("dataset is not a RECONSTRUCTION_FUSION dataset");
        }
    }

    private List<File> findSceneDirectories(File root) {
        List<File> result = new ArrayList<>();
        File[] children = root.listFiles();
        if (children == null) return result;
        for (File child : children) {
            if (!child.isDirectory()) continue;
            if (new File(child, "global_point_cloud").isDirectory()) result.add(child);
            else result.addAll(findSceneDirectories(child));
        }
        return result;
    }

    private File exactlyOnePcd(File directory) {
        return exactlyOne(directory, file -> file.isFile() && "pcd".equalsIgnoreCase(FileUtil.getSuffix(file)), "PCD");
    }

    private File exactlyOneJson(File directory) {
        return exactlyOne(directory, file -> file.isFile() && "json".equalsIgnoreCase(FileUtil.getSuffix(file)), "camera config JSON");
    }

    private File exactlyOne(File directory, java.io.FileFilter filter, String label) {
        File[] files = directory.listFiles(filter);
        if (files == null || files.length != 1) {
            throw new UsecaseException(directory.getParentFile().getName() + " must contain exactly one " + label);
        }
        return files[0];
    }

    private Map<Long, List<CameraImage>> collectImages(File sceneDir) {
        Map<Long, List<CameraImage>> result = new LinkedHashMap<>();
        File[] children = sceneDir.listFiles();
        if (children == null) return result;
        for (File directory : children) {
            if (directory.isDirectory() && "camera_image".equalsIgnoreCase(directory.getName())) {
                collectFlatCameraImages(directory, result);
                continue;
            }
            Matcher matcher = CAMERA_DIRECTORY.matcher(directory.getName());
            if (!directory.isDirectory() || !matcher.matches()) continue;
            int cameraIndex = Integer.parseInt(matcher.group(1));
            File[] images = directory.listFiles(this::isImage);
            if (images == null) continue;
            for (File image : images) {
                Long timestamp = timestampOf(FileUtil.getPrefix(image.getName()));
                if (timestamp == null) {
                    log.warn("Skip reconstruction image without _seconds_nanoseconds suffix: {}", image.getName());
                    continue;
                }
                result.computeIfAbsent(timestamp, ignored -> new ArrayList<>()).add(new CameraImage(cameraIndex, image));
            }
        }
        result.values().forEach(images -> {
            Map<Integer, CameraImage> unique = new HashMap<>();
            for (CameraImage image : images) {
                if (unique.put(image.cameraIndex, image) != null) {
                    throw new UsecaseException("duplicate camera image for timestamp " + image.file.getName());
                }
            }
        });
        return result;
    }

    private void collectFlatCameraImages(File directory, Map<Long, List<CameraImage>> result) {
        File[] images = directory.listFiles(this::isImage);
        if (images == null) return;
        for (File image : images) {
            Matcher matcher = FLAT_CAMERA_IMAGE.matcher(FileUtil.getPrefix(image.getName()));
            if (!matcher.matches()) {
                log.warn("Skip reconstruction image without _cameraIndex suffix: {}", image.getName());
                continue;
            }
            Long timestamp = timestampOf(matcher.group(1));
            if (timestamp == null) {
                log.warn("Skip reconstruction image without _seconds_nanoseconds timestamp: {}", image.getName());
                continue;
            }
            int cameraIndex = Integer.parseInt(matcher.group(2));
            result.computeIfAbsent(timestamp, ignored -> new ArrayList<>()).add(new CameraImage(cameraIndex, image));
        }
    }

    private boolean isImage(File file) {
        String suffix = FileUtil.getSuffix(file.getName()).toLowerCase();
        return file.isFile() && ("jpg".equals(suffix) || "jpeg".equals(suffix) || "png".equals(suffix));
    }

    private Map<Long, Pose> parseLocations(List<String> lines) {
        Map<Long, Pose> result = new LinkedHashMap<>();
        for (String raw : lines) {
            String line = StrUtil.trim(raw);
            if (StrUtil.isBlank(line)) continue;
            int colon = line.indexOf(':');
            if (colon < 0) continue;
            Long timestamp = timestampOf(line.substring(0, colon));
            String[] parts = line.substring(colon + 1).trim().split("\\s+");
            if (timestamp == null || parts.length < 4) continue;
            try {
                result.put(timestamp, new Pose(Double.parseDouble(parts[0]), Double.parseDouble(parts[1]),
                        Double.parseDouble(parts[2]), Double.parseDouble(parts[3]),
                        parts.length > 4 ? Double.parseDouble(parts[4]) : null,
                        parts.length > 5 ? Double.parseDouble(parts[5]) : null));
            } catch (NumberFormatException ignored) {
                log.warn("Skip invalid reconstruction location line: {}", line);
            }
        }
        return result;
    }

    private Long timestampOf(String value) {
        Matcher matcher = TIMESTAMP.matcher(value.trim());
        if (!matcher.find()) return null;
        try {
            return Long.parseLong(matcher.group(1)) * 1_000_000_000L + Long.parseLong(matcher.group(2));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private String archiveSuffix(String fileUrl) {
        String value = fileUrl.toLowerCase().split("\\?", 2)[0];
        if (value.endsWith(".tar.gz")) return ".tar.gz";
        if (value.endsWith(".tar.bz2")) return ".tar.bz2";
        if (value.endsWith(".tar")) return ".tar";
        return ".zip";
    }

    private static final class Pose {
        private final double x, y, z, yaw;
        private final Double roll, pitch;
        private Pose(double x, double y, double z, double yaw, Double roll, Double pitch) {
            this.x = x; this.y = y; this.z = z; this.yaw = yaw; this.roll = roll; this.pitch = pitch;
        }
    }

    private static final class CameraImage {
        private final int cameraIndex;
        private final File file;
        private CameraImage(int cameraIndex, File file) { this.cameraIndex = cameraIndex; this.file = file; }
    }
}
