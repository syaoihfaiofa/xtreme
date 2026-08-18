package ai.basic.x1.usecase;

import ai.basic.x1.util.Constants;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.ReUtil;
import org.springframework.beans.factory.annotation.Autowired;

import java.io.File;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public class PointCloudUploadUseCase {

    private static final Pattern FLAT_CAMERA_IMAGE_PATTERN = Pattern.compile("^(.+)_(\\d+)\\.(?i)(jpe?g|png)$");

    @Autowired
    private UploadDataUseCase uploadDataUseCase;

    /**
     * Normalize common export layouts into Xtreme1 upload structure before parsing.
     */
    public void normalizeUploadLayout(String baseSavePath) {
        normalizeSceneDirectoryRecursive(new File(baseSavePath));
    }

    private void normalizeSceneDirectoryRecursive(File directory) {
        if (!directory.isDirectory()) {
            return;
        }
        if (hasLidarPointCloudFolder(directory)) {
            normalizeSceneDirectory(directory);
        }
        for (var child : Objects.requireNonNull(directory.listFiles())) {
            if (child.isDirectory()) {
                normalizeSceneDirectoryRecursive(child);
            }
        }
    }

    private boolean hasLidarPointCloudFolder(File directory) {
        for (var child : Objects.requireNonNull(directory.listFiles())) {
            if (!child.isDirectory()) {
                continue;
            }
            var folderName = child.getName().toLowerCase();
            if (ReUtil.isMatch(Constants.LIDAR_POINT_CLOUD_PATTERN, folderName)) {
                return true;
            }
        }
        return false;
    }

    private void normalizeSceneDirectory(File sceneDirectory) {
        var bareLidarFolder = new File(sceneDirectory, Constants.LIDAR_POINT_CLOUD);
        var numberedLidarFolder = new File(sceneDirectory, Constants.LIDAR_POINT_CLOUD + "_0");
        if (bareLidarFolder.isDirectory() && bareLidarFolder.getName().equalsIgnoreCase(Constants.LIDAR_POINT_CLOUD)
                && !numberedLidarFolder.exists()) {
            FileUtil.rename(bareLidarFolder, numberedLidarFolder.getName(), true);
        }

        var flatCameraImageFolder = new File(sceneDirectory, Constants.CAMERA_IMAGE);
        if (flatCameraImageFolder.isDirectory()) {
            var movedFlatImages = false;
            for (var file : Objects.requireNonNull(flatCameraImageFolder.listFiles())) {
                if (!file.isFile()) {
                    continue;
                }
                var matcher = FLAT_CAMERA_IMAGE_PATTERN.matcher(file.getName());
                if (!matcher.matches()) {
                    continue;
                }
                movedFlatImages = true;
                var frameName = matcher.group(1);
                var cameraIndex = matcher.group(2);
                var extension = matcher.group(3);
                var targetDirectory = new File(sceneDirectory, Constants.CAMERA_IMAGE + "_" + cameraIndex);
                FileUtil.mkdir(targetDirectory);
                FileUtil.move(file, new File(targetDirectory, frameName + "." + extension), true);
            }
            if (movedFlatImages && Objects.requireNonNull(flatCameraImageFolder.listFiles()).length == 0) {
                FileUtil.del(flatCameraImageFolder);
            }
        }

        normalizeCameraConfigDirectory(sceneDirectory);
    }

    private void normalizeCameraConfigDirectory(File sceneDirectory) {
        var cameraConfigDirectory = new File(sceneDirectory, Constants.CAMERA_CONFIG);
        if (cameraConfigDirectory.isDirectory()) {
            return;
        }
        var legacyConfigFile = new File(sceneDirectory, "config/camera_config.json");
        if (legacyConfigFile.isFile()) {
            FileUtil.mkdir(cameraConfigDirectory);
            FileUtil.move(legacyConfigFile, new File(cameraConfigDirectory, legacyConfigFile.getName()), true);
            cleanupEmptyDirectory(legacyConfigFile.getParentFile());
            return;
        }
        var legacyConfigDirectory = new File(sceneDirectory, "config");
        if (!legacyConfigDirectory.isDirectory()) {
            return;
        }
        var jsonFiles = Arrays.stream(Objects.requireNonNull(legacyConfigDirectory.listFiles()))
                .filter(File::isFile)
                .filter(file -> file.getName().toLowerCase().endsWith(".json"))
                .toArray(File[]::new);
        if (jsonFiles.length == 0) {
            return;
        }
        FileUtil.mkdir(cameraConfigDirectory);
        for (var jsonFile : jsonFiles) {
            FileUtil.move(jsonFile, new File(cameraConfigDirectory, jsonFile.getName()), true);
        }
        cleanupEmptyDirectory(legacyConfigDirectory);
    }

    private void cleanupEmptyDirectory(File directory) {
        if (directory == null || !directory.isDirectory()) {
            return;
        }
        var children = directory.listFiles();
        if (children != null && children.length == 0) {
            FileUtil.del(directory);
        }
    }

    /**
     * Get the name of point cloud data
     *
     * @param sceneFile Continuous frames folder
     */
    public List<String> getDataNames(File sceneFile) {
        var sceneNames = new LinkedHashSet<String>();
        for (var f : sceneFile.listFiles()) {
            var filename = f.getName().toLowerCase();
            var boo = f.isDirectory() && ReUtil.isMatch(Constants.LIDAR_POINT_CLOUD_PATTERN, filename);
            if (boo) {
                var list = Arrays.stream(f.listFiles()).filter(fl -> Constants.PCD_SUFFIX.equalsIgnoreCase(FileUtil.getSuffix(fl))).map(uploadDataUseCase::getFilename).collect(Collectors.toSet());
                sceneNames.addAll(list);
            }
        }
        return sceneNames.stream().sorted().collect(Collectors.toList());
    }

    /**
     * Find folders for all point clouds
     *
     * @param path                 path
     * @param pointCloudParentList lidar_point_cloud folder parent directory collection
     */
    public void findPointCloudParentList(String path, Set<File> pointCloudParentList) {
        var file = new File(path);
        if (FileUtil.isDirectory(path)) {
            for (var f : file.listFiles()) {
                getPointCloudParentFile(f, pointCloudParentList);
                if (f.isDirectory()) {
                    findPointCloudParentList(f.getAbsolutePath(), pointCloudParentList);
                }
            }
        }
    }

    /**
     * Get lidar_point_cloud upper-level directory
     *
     * @param file                 file
     * @param pointCloudParentList lidar_point_cloud folder parent directory collection
     */
    private void getPointCloudParentFile(File file, Set<File> pointCloudParentList) {
        var filename = file.getName().toLowerCase().trim();
        if (ReUtil.isMatch(Constants.LIDAR_POINT_CLOUD_PATTERN, filename) && FileUtil.isDirectory(file)) {
            pointCloudParentList.add(file.getParentFile());
        }
    }
}
