package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.SceneLocationDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocation;
import ai.basic.x1.entity.*;
import ai.basic.x1.entity.enums.DataFormatEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.http.HttpUtil;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.springframework.beans.factory.annotation.Autowired;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Native LiDAR Fusion scene exporters.  This deliberately keeps the existing
 * Xtreme1/COCO pipeline untouched: KITTI and nuScenes need scene-wide links,
 * poses and calibration rather than independent per-frame JSON files.
 */
public class LidarSceneFormatExportUseCase {
    @Autowired
    private SceneLocationDAO sceneLocationDAO;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    public void export(String root, List<DataExportBO> frames, BaseQueryBO query) {
        if (query.getDataFormat() != DataFormatEnum.KITTI && query.getDataFormat() != DataFormatEnum.NUSCENES) {
            throw new IllegalArgumentException("Unsupported LiDAR scene export format");
        }
        if (CollUtil.isEmpty(frames)) throw new IllegalArgumentException("No scene frames selected for export");
        if (frames.stream().anyMatch(frame -> StrUtil.isBlank(frame.getSceneName())
                || !(frame.getData() instanceof LidarFusionDataExportBO))) {
            throw new IllegalArgumentException("KITTI and nuScenes export requires complete LiDAR Fusion scenes");
        }
        Map<Long, SceneLocation> poses = sceneLocationDAO.list(Wrappers.lambdaQuery(SceneLocation.class)
                        .in(SceneLocation::getDataId, frames.stream().map(f -> f.getData().getDataId()).collect(Collectors.toList())))
                .stream().collect(Collectors.toMap(SceneLocation::getDataId, p -> p, (a, b) -> a));
        Map<String, List<Frame>> scenes = new TreeMap<>();
        for (DataExportBO export : frames) {
            LidarFusionDataExportBO data = (LidarFusionDataExportBO) export.getData();
            Frame frame = new Frame(export.getSceneName(), export.getSceneId(), data, export.getResult(), poses.get(data.getDataId()));
            validate(frame);
            scenes.computeIfAbsent(frame.scene, ignored -> new ArrayList<>()).add(frame);
        }
        validateCompleteScenes(scenes);
        scenes.values().forEach(list -> list.sort(Comparator.comparingLong(f -> f.timestamp)));
        if (query.getDataFormat() == DataFormatEnum.KITTI) exportKitti(root, scenes, Boolean.TRUE.equals(query.getIncludeSourceData()));
        else exportNuScenes(root, scenes, Boolean.TRUE.equals(query.getIncludeSourceData()));
        writeReadme(root, query.getDataFormat(), Boolean.TRUE.equals(query.getIncludeSourceData()));
    }

    private void validateCompleteScenes(Map<String, List<Frame>> scenes) {
        for (List<Frame> sceneFrames : scenes.values()) {
            Long sceneId = sceneFrames.get(0).sceneId;
            if (sceneId == null || sceneId == 0 || sceneFrames.stream().anyMatch(frame -> !Objects.equals(sceneId, frame.sceneId))) {
                throw new IllegalArgumentException("KITTI and nuScenes export requires selecting complete scenes, not individual frames");
            }
            long expected = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                    .eq(DataInfo::getParentId, sceneId).eq(DataInfo::getType, ItemTypeEnum.SINGLE_DATA)
                    .eq(DataInfo::getIsDeleted, false)).size();
            if (expected != sceneFrames.size()) {
                throw new IllegalArgumentException("Scene " + sceneFrames.get(0).scene + " is incomplete; select the whole scene before export");
            }
        }
    }

    private void validate(Frame frame) {
        if (frame.timestamp < 0) throw new IllegalArgumentException("Frame " + frame.data.getName() + " has no parseable timestamp");
        if (frame.pose == null) throw new IllegalArgumentException("Frame " + frame.data.getName() + " has no ego pose (upload location.txt)");
        if (CollUtil.isEmpty(frame.data.getLidarPointClouds())) throw new IllegalArgumentException("Frame " + frame.data.getName() + " has no point cloud");
        if (findImage0(frame.data) == null) throw new IllegalArgumentException("Frame " + frame.data.getName() + " has no image_0");
        if (calibration(frame.data) == null) throw new IllegalArgumentException("Frame " + frame.data.getName() + " has no valid camera calibration");
    }

    private void exportKitti(String root, Map<String, List<Frame>> scenes, boolean source) {
        File base = new File(root, "training");
        for (Map.Entry<String, List<Frame>> entry : scenes.entrySet()) {
            String sequence = safe(entry.getKey());
            StringBuilder labels = new StringBuilder();
            StringBuilder calib = new StringBuilder();
            int index = 0;
            for (Frame frame : entry.getValue()) {
                Calibration c = calibration(frame.data);
                if (index == 0) calib.append(c.kittiCalibration());
                for (DataResultObjectExportBO object : objects(frame.results)) {
                    if (!isCuboid(object)) continue;
                    Box box = box(object);
                    if (box == null) continue;
                    double[] cam = c.transform(box.x, box.y, box.z);
                    double alpha = normalize(box.yaw - Math.atan2(cam[0], Math.max(cam[2], 1e-6)));
                    // The source system has no visibility/truncation nor projected contour.  KITTI's
                    // conventional unknown values and a conservative full-image bbox are explicit.
                    labels.append(String.format(Locale.ROOT,
                            "%d %s %s 0.00 3 0.00 0.00 0.00 %.3f %.3f %.3f %.3f %.3f %.3f %.3f %.6f%n",
                            index, track(object), category(object), c.width, c.height,
                            box.h, box.w, box.l, cam[0], cam[1], cam[2], box.yaw, alpha));
                }
                writeExtensions(root, sequence, String.format("%06d", index), frame);
                if (source) {
                    copy(first(frame.data.getLidarPointClouds()), new File(base, "velodyne/" + sequence + "/" + String.format("%06d.bin", index)));
                    ExportDataImageFileBO image = findImage0(frame.data);
                    copy(image, new File(base, "image_02/" + sequence + "/" + String.format("%06d", index) + suffix(image.getFilename())));
                }
                index++;
            }
            FileUtil.writeString(labels.toString(), new File(base, "label_02/" + sequence + ".txt"), StandardCharsets.UTF_8);
            FileUtil.writeString(calib.toString(), new File(base, "calib/" + sequence + ".txt"), StandardCharsets.UTF_8);
        }
    }

    private void exportNuScenes(String root, Map<String, List<Frame>> scenes, boolean source) {
        File tableDir = new File(root, "v1.0-x1");
        Tables t = new Tables();
        String log = token("log");
        t.add("log", obj("token", log, "logfile", "", "vehicle", "Xtreme1", "date_captured", "", "location", "x1"));
        t.add("map", obj("token", token("map"), "log_tokens", array(log), "filename", "", "mask", obj("filename", "", "aname", "", "h", 0, "w", 0)));
        Map<String, String> categories = new LinkedHashMap<>();
        Map<String, String> instances = new LinkedHashMap<>();
        int sceneIndex = 0;
        for (Map.Entry<String, List<Frame>> entry : scenes.entrySet()) {
            String sceneToken = token("scene:" + entry.getKey());
            String prevSample = "";
            List<String> samples = new ArrayList<>();
            int frameIndex = 0;
            for (Frame frame : entry.getValue()) {
                String sample = token("sample:" + entry.getKey() + ":" + frame.timestamp);
                samples.add(sample);
                JSONObject sampleRecord = obj("token", sample, "timestamp", frame.timestamp / 1000, "scene_token", sceneToken,
                        "next", "", "prev", prevSample, "data", new JSONObject(), "anns", new JSONArray());
                if (!prevSample.isEmpty()) t.get("sample").getJSONObject(t.get("sample").size() - 1).set("next", sample);
                t.add("sample", sampleRecord);
                String pose = token("pose:" + frame.data.getDataId());
                t.add("ego_pose", pose(frame.pose, pose, frame.timestamp / 1000));
                addNuSensorData(root, t, frame, sample, pose, entry.getKey(), frameIndex, source);
                for (DataResultObjectExportBO object : objects(frame.results)) {
                    if (!isCuboid(object)) continue;
                    Box box = box(object);
                    if (box == null) continue;
                    String category = categories.computeIfAbsent(category(object), name -> {
                        String value = token("category:" + name);
                        t.add("category", obj("token", value, "name", name, "description", name));
                        return value;
                    });
                    String id = track(object);
                    String instance = instances.computeIfAbsent(id, key -> {
                        String value = token("instance:" + key);
                        t.add("instance", obj("token", value, "category_token", category, "nbr_annotations", 0, "first_annotation_token", "", "last_annotation_token", ""));
                        return value;
                    });
                    String annotation = token("annotation:" + sample + ":" + object.getId());
                    double[] global = rotate(frame.pose.getYaw(), box.x, box.y);
                    global[0] += frame.pose.getPosX(); global[1] += frame.pose.getPosY();
                    double z = box.z + frame.pose.getPosZ();
                    JSONObject annotationRecord = obj("token", annotation, "sample_token", sample, "instance_token", instance,
                            "attribute_tokens", new JSONArray(), "visibility_token", "", "translation", array(global[0], global[1], z),
                            "size", array(box.w, box.l, box.h), "rotation", quaternion(frame.pose.getYaw() + box.yaw),
                            "num_lidar_pts", 0, "num_radar_pts", 0, "next", "", "prev", "");
                    linkAnnotation(t, instance, annotation, annotationRecord);
                    t.add("sample_annotation", annotationRecord);
                    sampleRecord.getJSONArray("anns").add(annotation);
                }
                writeExtensions(root, safe(entry.getKey()), String.format("%06d", frameIndex), frame);
                prevSample = sample; frameIndex++;
            }
            t.add("scene", obj("token", sceneToken, "name", safe(entry.getKey()), "description", "Xtreme1 export",
                    "log_token", log, "nbr_samples", samples.size(), "first_sample_token", samples.get(0), "last_sample_token", samples.get(samples.size() - 1)));
            sceneIndex++;
        }
        for (Object value : t.get("instance")) {
            JSONObject instance = (JSONObject) value;
            instance.set("nbr_annotations", countAnnotations(t, instance.getStr("token")));
        }
        for (String name : Arrays.asList("attribute", "visibility", "lidarseg", "panoptic")) t.ensure(name);
        t.write(tableDir);
    }

    private void addNuSensorData(String root, Tables t, Frame frame, String sample, String pose, String scene, int index, boolean source) {
        List<ExportDataFileBaseBO> sensors = new ArrayList<>();
        sensors.add(first(frame.data.getLidarPointClouds()));
        sensors.addAll(frame.data.getCameraImages());
        int sensorIndex = 0;
        for (ExportDataFileBaseBO file : sensors) {
            boolean lidar = sensorIndex == 0;
            String channel = lidar ? "LIDAR_TOP" : "CAM_" + (sensorIndex - 1);
            String sensor = token("sensor:" + channel);
            if (t.find("sensor", sensor) == null) t.add("sensor", obj("token", sensor, "channel", channel, "modality", lidar ? "lidar" : "camera"));
            String calibrated = token("calibrated:" + channel);
            if (t.find("calibrated_sensor", calibrated) == null) {
                Calibration c = calibration(frame.data);
                t.add("calibrated_sensor", obj("token", calibrated, "sensor_token", sensor,
                        "translation", lidar ? array(0, 0, 0) : array(c.tx, c.ty, c.tz),
                        "rotation", lidar ? quaternion(0) : c.quaternion(), "camera_intrinsic", lidar ? new JSONArray() : c.intrinsic()));
            }
            String relative = "samples/" + channel + "/" + safe(scene) + "/" + String.format("%06d", index) + suffix(file.getFilename());
            String sd = token("sample_data:" + sample + ":" + channel);
            t.add("sample_data", obj("token", sd, "sample_token", sample, "ego_pose_token", pose, "calibrated_sensor_token", calibrated,
                    "filename", relative, "fileformat", suffix(file.getFilename()).replace(".", ""), "width", lidar ? 0 : width(file),
                    "height", lidar ? 0 : height(file), "timestamp", frame.timestamp / 1000, "is_key_frame", true, "next", "", "prev", ""));
            JSONObject sampleRecord = t.find("sample", sample);
            sampleRecord.getJSONObject("data").set(channel, sd);
            if (source) copy(file, new File(root, relative));
            sensorIndex++;
        }
    }

    private void linkAnnotation(Tables t, String instance, String token, JSONObject annotation) {
        JSONObject instanceRecord = t.find("instance", instance);
        String previous = instanceRecord.getStr("last_annotation_token");
        if (StrUtil.isNotBlank(previous)) {
            JSONObject previousRecord = t.find("sample_annotation", previous);
            if (previousRecord != null) previousRecord.set("next", token);
            annotation.set("prev", previous);
        } else instanceRecord.set("first_annotation_token", token);
        instanceRecord.set("last_annotation_token", token);
    }

    private int countAnnotations(Tables t, String instance) {
        return (int) t.get("sample_annotation").stream().filter(v -> instance.equals(((JSONObject) v).getStr("instance_token"))).count();
    }

    private void writeExtensions(String root, String scene, String frame, Frame data) {
        JSONArray extensions = new JSONArray();
        for (DataResultObjectExportBO object : objects(data.results)) if (!isCuboid(object))
            extensions.add(obj("id", object.getId(), "className", category(object), "type", object.getType(), "trackId", track(object),
                    "contour", object.getContour(), "attributes", object.getClassValues()));
        if (!extensions.isEmpty()) FileUtil.writeString(extensions.toStringPretty(), new File(root, "x1_extensions/" + scene + "/" + frame + ".json"), StandardCharsets.UTF_8);
    }

    private void writeReadme(String root, DataFormatEnum format, boolean source) {
        String text = "Xtreme1 " + format + " scene export\n\n"
                + "Source point clouds and images: " + (source ? "included" : "not included") + ".\n"
                + "Format-required calibration and nuScenes metadata are always included.\n"
                + "Unsupported Xtreme1 geometry is stored under x1_extensions/ and is not part of the official format.\n";
        FileUtil.writeString(text, new File(root, "README.md"), StandardCharsets.UTF_8);
    }

    private static List<DataResultObjectExportBO> objects(List<DataResultExportBO> results) {
        if (CollUtil.isEmpty(results)) return Collections.emptyList();
        return results.stream().filter(Objects::nonNull).flatMap(r -> CollUtil.emptyIfNull(r.getObjects()).stream()).collect(Collectors.toList());
    }
    private static boolean isCuboid(DataResultObjectExportBO o) { return o != null && ("CUBOID".equalsIgnoreCase(o.getType()) || "3D_BOX".equalsIgnoreCase(o.getType())); }
    private static String category(DataResultObjectExportBO o) { return StrUtil.blankToDefault(o.getClassName(), "Unknown"); }
    private static String track(DataResultObjectExportBO o) { return StrUtil.blankToDefault(o.getTrackId(), StrUtil.blankToDefault(o.getId(), "0")); }
    private static <T> T first(List<T> list) { return list.get(0); }
    private static String suffix(String name) { int i = name == null ? -1 : name.lastIndexOf('.'); return i < 0 ? ".bin" : name.substring(i); }
    private static String safe(String value) { return value.replaceAll("[^A-Za-z0-9_.-]", "_"); }
    private static long timestamp(String name) { try { return Long.parseLong(name.replaceAll("\\D", "")); } catch (Exception e) { return -1; } }
    private static JSONArray array(Object... values) { JSONArray a = new JSONArray(); for (Object v : values) a.add(v); return a; }
    private static JSONObject obj(Object... values) { JSONObject o = new JSONObject(); for (int i = 0; i < values.length; i += 2) o.set(String.valueOf(values[i]), values[i + 1]); return o; }
    private static String token(String value) { return UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8)).toString().replace("-", ""); }
    private static double normalize(double angle) { while (angle > Math.PI) angle -= Math.PI * 2; while (angle < -Math.PI) angle += Math.PI * 2; return angle; }
    private static double[] rotate(double yaw, double x, double y) { double c = Math.cos(yaw), s = Math.sin(yaw); return new double[]{c * x - s * y, s * x + c * y}; }
    private static JSONArray quaternion(double yaw) { return array(Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)); }
    private static JSONObject pose(SceneLocation p, String token, long timestamp) { return obj("token", token, "timestamp", timestamp, "translation", array(p.getPosX(), p.getPosY(), p.getPosZ()), "rotation", quaternion(p.getYaw())); }
    private static long width(ExportDataFileBaseBO f) { return f instanceof ExportDataImageFileBO ? ((ExportDataImageFileBO) f).getWidth() : 0; }
    private static long height(ExportDataFileBaseBO f) { return f instanceof ExportDataImageFileBO ? ((ExportDataImageFileBO) f).getHeight() : 0; }
    private static void copy(ExportDataFileBaseBO source, File target) { FileUtil.mkParentDirs(target); HttpUtil.downloadFile(source.getInternalUrl(), target); }

    private static ExportDataImageFileBO findImage0(LidarFusionDataExportBO data) {
        return data.getCameraImages().stream().filter(f -> "image_0".equalsIgnoreCase(f.getDeviceName())).findFirst().orElse(null);
    }
    private static Calibration calibration(LidarFusionDataExportBO data) {
        try {
            String raw = HttpUtil.get(data.getCameraConfig().getInternalUrl());
            Object parsed = JSONUtil.parse(raw);
            JSONObject c = parsed instanceof JSONArray ? ((JSONArray) parsed).getJSONObject(0) : (JSONObject) parsed;
            JSONObject k = c.getJSONObject("cameraInternal"); if (k == null) k = c.getJSONObject("camera_internal");
            JSONArray ext = c.getJSONArray("cameraExternal"); if (ext == null) ext = c.getJSONArray("camera_external");
            if (k == null || ext == null || ext.size() != 16) return null;
            double[] m = new double[16]; for (int i = 0; i < 16; i++) m[i] = ext.getDouble(i);
            if (Boolean.FALSE.equals(c.getBool("rowMajor"))) { for (int r = 0; r < 4; r++) for (int col = r + 1; col < 4; col++) { double x = m[r * 4 + col]; m[r * 4 + col] = m[col * 4 + r]; m[col * 4 + r] = x; } }
            return new Calibration(k.getDouble("fx"), k.getDouble("fy"), k.getDouble("cx"), k.getDouble("cy"), c.getLong("width", 0L), c.getLong("height", 0L), m);
        } catch (Exception ignored) { return null; }
    }

    private static class Frame {
        final String scene; final Long sceneId; final LidarFusionDataExportBO data; final List<DataResultExportBO> results; final SceneLocation pose; final long timestamp;
        Frame(String scene, Long sceneId, LidarFusionDataExportBO data, List<DataResultExportBO> results, SceneLocation pose) { this.scene = scene; this.sceneId = sceneId; this.data = data; this.results = results; this.pose = pose; this.timestamp = timestamp(data.getName()); }
    }
    private static class Box {
        final double x,y,z,w,l,h,yaw;
        Box(double x,double y,double z,double w,double l,double h,double yaw) { this.x=x;this.y=y;this.z=z;this.w=w;this.l=l;this.h=h;this.yaw=yaw; }
    }
    private static Box box(DataResultObjectExportBO object) {
        try { JSONObject c = object.getContour(); JSONObject center = c.getJSONObject("center3D"), size = c.getJSONObject("size3D"), rotation = c.getJSONObject("rotation3D");
            return new Box(center.getDouble("x"), center.getDouble("y"), center.getDouble("z"), size.getDouble("x"), size.getDouble("y"), size.getDouble("z"), rotation == null ? 0 : rotation.getDouble("z", 0D));
        } catch (Exception ignored) { return null; }
    }
    private static class Calibration {
        final double fx,fy,cx,cy; final long width,height; final double[] m; final double tx,ty,tz;
        Calibration(double fx,double fy,double cx,double cy,long width,long height,double[] m) { this.fx=fx;this.fy=fy;this.cx=cx;this.cy=cy;this.width=width;this.height=height;this.m=m;this.tx=m[3];this.ty=m[7];this.tz=m[11]; }
        double[] transform(double x,double y,double z) { return new double[]{m[0]*x+m[1]*y+m[2]*z+m[3],m[4]*x+m[5]*y+m[6]*z+m[7],m[8]*x+m[9]*y+m[10]*z+m[11]}; }
        JSONArray intrinsic() { return array(array(fx,0,cx),array(0,fy,cy),array(0,0,1)); }
        JSONArray quaternion() { double yaw = Math.atan2(m[4], m[0]); return LidarSceneFormatExportUseCase.quaternion(yaw); }
        String kittiCalibration() { return String.format(Locale.ROOT, "P0: %.9f 0 %.9f 0 0 %.9f %.9f 0 0 0 1 0%nP1: %.9f 0 %.9f 0 0 %.9f %.9f 0 0 0 1 0%nP2: %.9f 0 %.9f 0 0 %.9f %.9f 0 0 0 1 0%nP3: %.9f 0 %.9f 0 0 %.9f %.9f 0 0 0 1 0%nR0_rect: 1 0 0 0 1 0 0 0 1%nTr_velo_to_cam: %.9f %.9f %.9f %.9f %.9f %.9f %.9f %.9f %.9f %.9f %.9f %.9f%n", fx,cx,fy,cy,fx,cx,fy,cy,fx,cx,fy,cy,fx,cx,fy,cy,m[0],m[1],m[2],m[3],m[4],m[5],m[6],m[7],m[8],m[9],m[10],m[11]); }
    }
    private static class Tables {
        final Map<String, JSONArray> tables = new LinkedHashMap<>();
        JSONArray get(String name) { return tables.computeIfAbsent(name, ignored -> new JSONArray()); }
        void ensure(String name) { get(name); }
        void add(String name, JSONObject value) { get(name).add(value); }
        JSONObject find(String table, String token) { for (Object value : get(table)) { JSONObject o = (JSONObject) value; if (token.equals(o.getStr("token"))) return o; } return null; }
        void write(File dir) { for (Map.Entry<String, JSONArray> e : tables.entrySet()) FileUtil.writeString(e.getValue().toStringPretty(), new File(dir, e.getKey() + ".json"), StandardCharsets.UTF_8); }
    }
}
