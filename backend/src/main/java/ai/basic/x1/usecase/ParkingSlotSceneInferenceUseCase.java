package ai.basic.x1.usecase;

import ai.basic.x1.adapter.api.job.converter.ImageKeypointLiftedModelResultConverter;
import ai.basic.x1.adapter.api.job.converter.ParkingSlotDetectionModelReqConverter;
import ai.basic.x1.adapter.dto.ApiResult;
import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.ModelClassDAO;
import ai.basic.x1.adapter.port.dao.SceneLocationDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.Model;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelClass;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocation;
import ai.basic.x1.adapter.port.rpc.ParkingSlotDetectionHttpCaller;
import ai.basic.x1.adapter.port.rpc.dto.ImageKeypointLiftedDetectionRespDTO;
import ai.basic.x1.entity.DatasetInferenceConfig;
import ai.basic.x1.entity.ImageKeypointLiftedObjectBO;
import ai.basic.x1.entity.ModelMessageBO;
import ai.basic.x1.entity.RelationFileBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import ai.basic.x1.entity.enums.InferenceMotionModeEnum;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import cn.hutool.http.HttpUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

/** Scene runner for static four-corner parking slots.  Association is deliberately done in
 * world coordinates: local LiDAR coordinates differ on every frame. */
@Service
public class ParkingSlotSceneInferenceUseCase {
    private static final double PARKING_SLOT_SYNC_DISTANCE_METERS = 10.0;
    @Autowired private DataInfoDAO dataInfoDAO;
    @Autowired private SceneLocationDAO sceneLocationDAO;
    @Autowired private DataAnnotationObjectDAO dataAnnotationObjectDAO;
    @Autowired private ModelClassDAO modelClassDAO;
    @Autowired private DataInfoUseCase dataInfoUseCase;
    @Autowired private ParkingSlotDetectionHttpCaller parkingCaller;

    public List<String> runForModelRun(Long runId, Long datasetId, Long sceneId, Model model,
                               DatasetInferenceConfig config) {
        List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sceneId).eq(DataInfo::getIsDeleted, false)
                .orderByAsc(DataInfo::getOrderName).orderByAsc(DataInfo::getId));
        if (frames.isEmpty()) throw new UsecaseException("Scene has no frames: sceneId=" + sceneId);
        Map<Long, SceneLocation> poses = sceneLocationDAO.list(Wrappers.lambdaQuery(SceneLocation.class)
                        .in(SceneLocation::getDataId, frames.stream().map(DataInfo::getId).collect(Collectors.toList())))
                .stream().collect(Collectors.toMap(SceneLocation::getDataId, p -> p, (a, b) -> a));
        Map<String, DatasetInferenceConfig.ClassMapping> mappings = config.getClassMappings().stream()
                .collect(Collectors.toMap(m -> key(m.getModelClassCode()), m -> m, (a, b) -> a));
        Map<String, ModelClass> modelClasses = modelClassDAO.list(Wrappers.lambdaQuery(ModelClass.class)
                        .eq(ModelClass::getModelId, model.getId())).stream()
                .collect(Collectors.toMap(ModelClass::getCode, c -> c, (a, b) -> a));
        // The shared converter returns the configured display name, while the Run request
        // contains model-class codes.  Accept both representations deterministically.
        for (ModelClass modelClass : modelClasses.values()) {
            DatasetInferenceConfig.ClassMapping mapping = mappings.get(key(modelClass.getCode()));
            if (mapping != null && modelClass.getName() != null) mappings.put(key(modelClass.getName()), mapping);
        }
        List<Track> tracks = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        for (DataInfo frame : frames) {
            SceneLocation pose = poses.get(frame.getId());
            if (!complete(pose)) { skipped.add(frame.getId() + ": missing pose"); continue; }
            var frameInfo = dataInfoUseCase.findById(frame.getId());
            if (!ParkingSlotDetectionModelReqConverter.hasStitchedImage(frameInfo)) { skipped.add(frame.getId() + ": missing stitched_img"); continue; }
            List<Point> cameraCenters = cameraCenters(frameInfo);
            List<ImageKeypointLiftedObjectBO.ObjectBO> objects;
            try {
                objects = detect(runId, datasetId, frame.getId(), model, frameInfo, modelClasses, config);
            } catch (RuntimeException exception) {
                skipped.add(frame.getId() + ": " + exception.getMessage());
                continue;
            }
            for (ImageKeypointLiftedObjectBO.ObjectBO object : objects) {
                DatasetInferenceConfig.ClassMapping mapping = mappings.get(key(object.getModelClass()));
                if (mapping == null || object.getPoints() == null || object.getPoints().size() != 4) continue;
                List<Point> local = object.getPoints().stream()
                        .map(point -> new Point(point.getX().doubleValue(), point.getY().doubleValue(), point.getZ().doubleValue()))
                        .collect(Collectors.toList());
                List<Point> world = object.getPoints().stream().map(p -> localToWorld(p, pose)).collect(Collectors.toList());
                double cameraDistance = distanceToNearestCameraFootprint(local, cameraCenters);
                Track track = tracks.stream().filter(t -> t.classId.equals(mapping.getDatasetClassId()))
                        .filter(t -> iou(t.world, world) >= config.getAssociationIou()).findFirst().orElse(null);
                if (track == null) {
                    track = new Track(mapping.getDatasetClassId(), object.getModelClass(), object.getConfidence(), world,
                            cameraDistance, frame.getId(), object.getSourceViewIndexes(), object.getSourceKeypoints());
                    tracks.add(track);
                } else if (cameraDistance < track.cameraDistance) {
                    // For a static slot, geometry from the camera-nearest observation is the representative.
                    track.world = world; track.confidence = object.getConfidence(); track.modelClass = object.getModelClass();
                    track.cameraDistance = cameraDistance; track.sourceDataId = frame.getId();
                    track.sourceViewIndexes = object.getSourceViewIndexes(); track.sourceKeypoints = object.getSourceKeypoints();
                }
            }
        }
        writeTracks(runId, datasetId, frames, poses, tracks, config.getAssociationIou());
        return skipped;
    }

    private List<ImageKeypointLiftedObjectBO.ObjectBO> detect(Long runId, Long datasetId, Long dataId, Model model,
            ai.basic.x1.entity.DataInfoBO info, Map<String, ModelClass> classes, DatasetInferenceConfig config) {
        try {
            ModelMessageBO message = ModelMessageBO.builder().datasetId(datasetId).dataId(dataId).modelId(model.getId())
                    .modelCode(model.getModelCode()).modelVersion(model.getVersion()).url(model.getUrl()).dataInfo(info).build();
            ApiResult<List<ImageKeypointLiftedDetectionRespDTO>> response = parkingCaller.call(
                    ParkingSlotDetectionModelReqConverter.convert(message), model.getUrl());
            ImageKeypointLiftedObjectBO converted = ImageKeypointLiftedModelResultConverter.convert(response, classes,
                    ai.basic.x1.util.DefaultConverter.convert(JSONUtil.createObj().set("classes", config.getClassMappings().stream()
                            .map(DatasetInferenceConfig.ClassMapping::getModelClassCode).collect(Collectors.toList()))
                            .set("minConfidence", config.getMinConfidence()), ai.basic.x1.adapter.dto.PreModelParamDTO.class));
            if (!UsecaseCode.OK.getCode().equals(converted.getCode()) || converted.getObjects() == null) return List.of();
            return converted.getObjects();
        } catch (IOException | RuntimeException exception) {
            throw new UsecaseException("parking-slot detection failed: runId=" + runId + ", dataId=" + dataId + ": " + exception.getMessage());
        }
    }

    private void writeTracks(Long runId, Long datasetId, List<DataInfo> frames, Map<Long, SceneLocation> poses,
                             List<Track> tracks, double protectedIou) {
        List<Long> ids = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        List<DataAnnotationObject> protectedObjects = dataAnnotationObjectDAO.list(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .in(DataAnnotationObject::getDataId, ids).in(DataAnnotationObject::getSourceType,
                        DataAnnotationObjectSourceTypeEnum.DATA_FLOW, DataAnnotationObjectSourceTypeEnum.IMPORTED));
        dataAnnotationObjectDAO.remove(Wrappers.lambdaQuery(DataAnnotationObject.class).in(DataAnnotationObject::getDataId, ids)
                .eq(DataAnnotationObject::getSourceType, DataAnnotationObjectSourceTypeEnum.MODEL)
                .eq(DataAnnotationObject::getSourceId, runId));
        for (int index = 0; index < tracks.size(); index++) tracks.get(index).trackName = String.valueOf(index + 1);
        List<DataAnnotationObject> inserts = new ArrayList<>();
        for (DataInfo frame : frames) {
            SceneLocation pose = poses.get(frame.getId()); if (!complete(pose)) continue;
            for (Track track : tracks) {
                List<Point> local = track.world.stream().map(p -> worldToLocal(p, pose)).collect(Collectors.toList());
                // The sync radius is measured from the rear-axle center, the local-coordinate origin.
                if (distanceToFootprint(local) > PARKING_SLOT_SYNC_DISTANCE_METERS) continue;
                if (overlapsProtected(local, track.classId, protectedObjects, frame.getId(), protectedIou)) continue;
                inserts.add(DataAnnotationObject.builder().datasetId(datasetId).dataId(frame.getId()).classId(track.classId)
                        .sourceType(DataAnnotationObjectSourceTypeEnum.MODEL).sourceId(runId)
                        .classAttributes(attributes(track, local, frame.getId())).build());
            }
        }
        if (!inserts.isEmpty()) dataAnnotationObjectDAO.saveBatch(inserts);
    }

    private boolean overlapsProtected(List<Point> candidate, Long classId, List<DataAnnotationObject> objects, Long dataId, double threshold) {
        for (DataAnnotationObject object : objects) {
            if (!dataId.equals(object.getDataId()) || !classId.equals(object.getClassId())) continue;
            JSONArray points = object.getClassAttributes() == null ? null : object.getClassAttributes()
                    .getJSONObject("contour") == null ? null : object.getClassAttributes().getJSONObject("contour").getJSONArray("points");
            if (points == null || points.size() != 4) continue;
            List<Point> other = new ArrayList<>();
            for (Object point : points) { var p = (cn.hutool.json.JSONObject) point; other.add(new Point(p.getDouble("x"), p.getDouble("y"), p.getDouble("z"))); }
            if (iou(candidate, other) > threshold) return true;
        }
        return false;
    }

    private cn.hutool.json.JSONObject attributes(Track track, List<Point> points, Long dataId) {
        JSONArray jsonPoints = new JSONArray();
        for (Point p : points) jsonPoints.add(JSONUtil.createObj().set("x", p.x).set("y", p.y).set("z", p.z));
        JSONObject result = JSONUtil.createObj().set("type", "GROUND_POLYGON").set("contour", JSONUtil.createObj().set("points", jsonPoints))
                .set("trackId", track.trackId).set("trackName", track.trackName)
                .set("sourceDataId", track.sourceDataId).set("motionMode", InferenceMotionModeEnum.STATIC.name())
                .set("syncDistance", PARKING_SLOT_SYNC_DISTANCE_METERS)
                .set("parkingOpeningEdge", "P3_P0").set("modelClass", track.modelClass)
                .set("confidence", track.confidence);
        // Only the representative/source frame has model-authored 2D points.  Keeping
        // those points avoids a second 3D-to-image projection and makes it identical to
        // a single-frame model run. Other frames intentionally use their final 3D projection.
        if (dataId.equals(track.sourceDataId) && track.sourceViewIndexes != null && track.sourceKeypoints != null) {
            result.set("sourceViewIndexes", track.sourceViewIndexes);
            result.set("sourceKeypoints", track.sourceKeypoints);
        }
        return result;
    }

    private static boolean complete(SceneLocation p) { return p != null && p.getPosX() != null && p.getPosY() != null && p.getPosZ() != null && p.getYaw() != null; }
    private static String key(String value) { return value == null ? "" : value.trim().toLowerCase(Locale.ROOT); }
    private static Point localToWorld(ImageKeypointLiftedObjectBO.Point p, SceneLocation pose) { return localToWorld(new Point(p.getX().doubleValue(), p.getY().doubleValue(), p.getZ().doubleValue()), pose); }
    private static Point localToWorld(Point p, SceneLocation pose) { double c=Math.cos(pose.getYaw()), s=Math.sin(pose.getYaw()); return new Point(pose.getPosX()+c*p.x-s*p.y, pose.getPosY()+s*p.x+c*p.y, pose.getPosZ()+p.z); }
    private static Point worldToLocal(Point p, SceneLocation pose) { double c=Math.cos(pose.getYaw()), s=Math.sin(pose.getYaw()), x=p.x-pose.getPosX(), y=p.y-pose.getPosY(); return new Point(c*x+s*y, -s*x+c*y, p.z-pose.getPosZ()); }
    private List<Point> cameraCenters(ai.basic.x1.entity.DataInfoBO frame) {
        String url = findCameraConfigUrl(frame == null ? null : frame.getContent());
        if (url == null) return List.of(new Point(0, 0, 0));
        try {
            JSONObject config = JSONUtil.parseObj(HttpUtil.get(url));
            List<Point> centers = new ArrayList<>();
            for (Object value : config.values()) {
                if (!(value instanceof JSONObject)) continue;
                JSONObject camera = (JSONObject) value;
                JSONArray external = camera.getJSONArray("cameraExternal");
                if (external == null) external = camera.getJSONArray("camera_external");
                if (external == null || external.size() != 16) continue;
                boolean rowMajor = Boolean.TRUE.equals(camera.getBool("rowMajor"));
                centers.add(cameraCenterInLidar(external, rowMajor));
            }
            return centers.isEmpty() ? List.of(new Point(0, 0, 0)) : centers;
        } catch (RuntimeException exception) {
            return List.of(new Point(0, 0, 0));
        }
    }

    private static String findCameraConfigUrl(List<ai.basic.x1.entity.DataInfoBO.FileNodeBO> nodes) {
        if (nodes == null) return null;
        for (ai.basic.x1.entity.DataInfoBO.FileNodeBO node : nodes) {
            RelationFileBO file = node.getFile();
            if (file != null && file.getPath() != null && file.getPath().replace('\\', '/').matches("(?:^|.*/)camera_config/[^/]+$")) {
                return file.getInternalUrl() != null && !file.getInternalUrl().isEmpty() ? file.getInternalUrl() : file.getUrl();
            }
            String nested = findCameraConfigUrl(node.getFiles());
            if (nested != null) return nested;
        }
        return null;
    }

    /** cameraExternal maps LiDAR coordinates into camera coordinates. */
    static Point cameraCenterInLidar(JSONArray external, boolean rowMajor) {
        double[][] matrix = new double[4][4];
        for (int row = 0; row < 4; row++) for (int column = 0; column < 4; column++)
            matrix[row][column] = external.getDouble(rowMajor ? row * 4 + column : column * 4 + row);
        double tx = matrix[0][3], ty = matrix[1][3], tz = matrix[2][3];
        return new Point(-(matrix[0][0] * tx + matrix[1][0] * ty + matrix[2][0] * tz),
                -(matrix[0][1] * tx + matrix[1][1] * ty + matrix[2][1] * tz),
                -(matrix[0][2] * tx + matrix[1][2] * ty + matrix[2][2] * tz));
    }
    static double distanceToNearestCameraFootprint(List<Point> footprint, List<Point> cameraCenters) {
        return cameraCenters.stream().mapToDouble(camera -> distanceToFootprint(footprint, camera)).min()
                .orElse(Double.POSITIVE_INFINITY);
    }
    static double distanceToFootprint(List<Point> points) {
        return distanceToFootprint(points, new Point(0, 0, 0));
    }
    static double distanceToFootprint(List<Point> points, Point origin) {
        if (points == null || points.isEmpty()) return Double.POSITIVE_INFINITY;
        double result = Double.POSITIVE_INFINITY;
        for (int index = 0; index < points.size(); index++) {
            Point end = points.get(index);
            result = Math.min(result, Math.hypot(end.x - origin.x, end.y - origin.y));
            Point start = points.get((index + points.size() - 1) % points.size());
            double dx = end.x - start.x, dy = end.y - start.y;
            double lengthSquared = dx * dx + dy * dy;
            if (lengthSquared > 0.0000001) {
                double ratio = Math.max(0, Math.min(1, ((origin.x - start.x) * dx + (origin.y - start.y) * dy) / lengthSquared));
                result = Math.min(result, Math.hypot(start.x + ratio * dx - origin.x, start.y + ratio * dy - origin.y));
            }
        }
        return result;
    }
    static double iou(List<Point> a, List<Point> b) { double aa=Math.abs(area(a)), bb=Math.abs(area(b)); if(aa==0||bb==0)return 0; List<Point> clipped=new ArrayList<>(a); for(int i=0;i<b.size()&&!clipped.isEmpty();i++) clipped=clip(clipped,b.get(i),b.get((i+1)%b.size()),area(b)>=0); double inter=Math.abs(area(clipped)); return inter/(aa+bb-inter); }
    private static List<Point> clip(List<Point> subject, Point a, Point b, boolean ccw) { List<Point> out=new ArrayList<>(); for(int i=0;i<subject.size();i++){Point p=subject.get(i),q=subject.get((i+1)%subject.size()); boolean pi=inside(p,a,b,ccw), qi=inside(q,a,b,ccw); if(pi)out.add(p); if(pi!=qi)out.add(intersection(p,q,a,b));} return out; }
    private static boolean inside(Point p,Point a,Point b,boolean ccw){double cross=(b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);return ccw?cross>=0:cross<=0;}
    private static Point intersection(Point p,Point q,Point a,Point b){double dx=q.x-p.x,dy=q.y-p.y,ex=b.x-a.x,ey=b.y-a.y,d=dx*ey-dy*ex; if(Math.abs(d)<1e-9)return p; double t=((a.x-p.x)*ey-(a.y-p.y)*ex)/d;return new Point(p.x+t*dx,p.y+t*dy,p.z+t*(q.z-p.z));}
    private static double area(List<Point> points){double sum=0;for(int i=0;i<points.size();i++){Point a=points.get(i),b=points.get((i+1)%points.size());sum+=a.x*b.y-b.x*a.y;}return sum/2;}
    static class Point { final double x,y,z; Point(double x,double y,double z){this.x=x;this.y=y;this.z=z;} }
    private static class Track {
        final Long classId; final String trackId=UUID.randomUUID().toString(); String trackName;
        String modelClass; java.math.BigDecimal confidence; List<Point> world; double cameraDistance; Long sourceDataId;
        List<Integer> sourceViewIndexes; List<List<java.math.BigDecimal>> sourceKeypoints;
        Track(Long id, String label, java.math.BigDecimal confidence, List<Point> world, double cameraDistance,
              Long sourceDataId, List<Integer> sourceViewIndexes, List<List<java.math.BigDecimal>> sourceKeypoints) {
            this.classId=id; this.modelClass=label; this.confidence=confidence; this.world=world;
            this.cameraDistance=cameraDistance; this.sourceDataId=sourceDataId;
            this.sourceViewIndexes=sourceViewIndexes; this.sourceKeypoints=sourceKeypoints;
        }
    }
}
