package ai.basic.x1.usecase;

import ai.basic.x1.adapter.api.config.DatasetInitialInfo;
import ai.basic.x1.adapter.api.context.RequestContextHolder;
import ai.basic.x1.adapter.port.dao.*;
import ai.basic.x1.adapter.port.dao.mybatis.extension.ExtendLambdaQueryWrapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.*;
import ai.basic.x1.adapter.port.dao.mybatis.query.DataInfoQuery;
import ai.basic.x1.adapter.port.minio.MinioProp;
import ai.basic.x1.adapter.port.minio.MinioService;
import ai.basic.x1.entity.*;
import ai.basic.x1.entity.enums.*;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import ai.basic.x1.util.Constants;
import ai.basic.x1.util.DefaultConverter;
import ai.basic.x1.util.NaturalSortUtil;
import ai.basic.x1.util.Page;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.collection.CollectionUtil;
import cn.hutool.core.collection.ListUtil;
import cn.hutool.core.date.DatePattern;
import cn.hutool.core.date.TemporalAccessorUtil;
import cn.hutool.core.io.FileUtil;
import cn.hutool.core.io.IoUtil;
import cn.hutool.core.lang.UUID;
import cn.hutool.core.thread.ThreadUtil;
import cn.hutool.core.util.IdUtil;
import cn.hutool.core.util.ObjectUtil;
import cn.hutool.core.util.StrUtil;
import cn.hutool.core.util.ZipUtil;
import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import com.alibaba.ttl.TtlRunnable;
import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.File;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.stream.Collectors;

import static ai.basic.x1.entity.enums.DatasetTypeEnum.IMAGE;
import static ai.basic.x1.usecase.exception.UsecaseCode.DATASET_NOT_FOUND;
import static ai.basic.x1.usecase.exception.UsecaseCode.DEFAULT_DATASET_NOT_FOUND;
import static ai.basic.x1.util.Constants.*;

/**
 * @author fyb
 * @date 2022/2/21 12:12
 */
@Slf4j
public class DataInfoUseCase {

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private FileUseCase fileUseCase;

    @Autowired
    private DatasetDAO datasetDAO;

    @Autowired
    private MinioService minioService;

    @Autowired
    private ExportUseCase exportUseCase;

    @Autowired
    private MinioProp minioProp;

    @Autowired
    private DataAnnotationClassificationUseCase dataAnnotationClassificationUseCase;

    @Autowired
    private DataAnnotationObjectUseCase dataAnnotationObjectUseCase;

    @Autowired
    private UserUseCase userUseCase;

    @Autowired
    private DataEditUseCase dataEditUseCase;

    @Autowired
    private DataEditDAO dataEditDAO;

    @Autowired
    private ModelUseCase modelUseCase;

    @Autowired
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    @Autowired
    private DataAnnotationRecordDAO dataAnnotationRecordDAO;

    @Autowired
    private ModelDataResultDAO modelDataResultDAO;

    @Autowired
    private DatasetSimilarityJobUseCase datasetSimilarityJobUseCase;

    @Autowired
    private DataAnnotationClassificationDAO dataAnnotationClassificationDAO;

    @Autowired
    private DatasetClassUseCase datasetClassUseCase;

    @Autowired
    private DatasetUseCase datasetUseCase;

    @Autowired
    private ModelRunRecordUseCase modelRunRecordUseCase;

    @Autowired
    private SceneLocationImportService sceneLocationImportService;

    @Autowired
    private SceneLocationDAO sceneLocationDAO;

    @Autowired
    private UploadDataUseCase uploadDataUseCase;

    @Value("${file.tempPath:/tmp/xtreme1/}")
    private String tempPath;

    @Value("${export.data.version}")
    private String version;

    private static final ExecutorService executorService = ThreadUtil.newExecutor(2);

    private static final Long GROUND_TRUTH = -1L;

    private static final String GROUND_TRUTH_NAME = "Ground Truth";

    /**
     * Data split
     *
     * @param dataIds   Data id collection
     * @param splitType split type
     */
    public void splitByDataIds(List<Long> dataIds, SplitTypeEnum splitType) {
        var dataInfoLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataInfo.class);
        dataInfoLambdaUpdateWrapper.nested(wq -> wq.in(DataInfo::getId, dataIds)
                .or()
                .in(DataInfo::getParentId, dataIds));
        dataInfoLambdaUpdateWrapper.set(DataInfo::getSplitType, splitType);
        dataInfoDAO.update(dataInfoLambdaUpdateWrapper);
    }

    /**
     * Organize existing root-level single data rows under a newly created scene.
     *
     * @param datasetId dataset id
     * @param dataIds   root-level single data ids to move into the scene
     * @param sceneName scene display name
     * @param userId    current user id
     * @return created scene id
     */
    @Transactional(rollbackFor = Exception.class)
    public Long organizeAsScene(Long datasetId, List<Long> dataIds, String sceneName, Long userId) {
        if (ObjectUtil.isNull(datasetId) || CollUtil.isEmpty(dataIds)) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }
        var dataset = datasetDAO.getById(datasetId);
        if (ObjectUtil.isNull(dataset)) {
            throw new UsecaseException(DATASET_NOT_FOUND);
        }
        if (!DatasetTypeEnum.LIDAR_FUSION.equals(dataset.getType())) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }

        var dataInfoLambdaQueryWrapper = Wrappers.lambdaQuery(DataInfo.class);
        dataInfoLambdaQueryWrapper.eq(DataInfo::getDatasetId, datasetId);
        dataInfoLambdaQueryWrapper.in(DataInfo::getId, dataIds);
        dataInfoLambdaQueryWrapper.eq(DataInfo::getIsDeleted, false);
        var dataList = dataInfoDAO.list(dataInfoLambdaQueryWrapper);
        if (dataList.size() != new HashSet<>(dataIds).size()) {
            throw new UsecaseException(UsecaseCode.DATA_NOT_FOUND);
        }
        var invalidData = dataList.stream().anyMatch(data ->
                !ItemTypeEnum.SINGLE_DATA.equals(data.getType()) || !DEFAULT_PARENT_ID.equals(data.getParentId()));
        if (invalidData) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }

        var lockedCount = dataEditDAO.count(Wrappers.lambdaQuery(DataEdit.class).in(DataEdit::getDataId, dataIds));
        if (lockedCount > 0) {
            throw new UsecaseException(UsecaseCode.DATASET_DATA_OTHERS_ANNOTATING);
        }

        var finalSceneName = StrUtil.blankToDefault(sceneName, nextSceneName(datasetId));
        var duplicateSceneCount = dataInfoDAO.count(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getDatasetId, datasetId)
                .eq(DataInfo::getName, finalSceneName)
                .eq(DataInfo::getIsDeleted, false));
        if (duplicateSceneCount > 0) {
            throw new UsecaseException(UsecaseCode.NAME_DUPLICATED);
        }

        var scene = DataInfo.builder()
                .datasetId(datasetId)
                .name(finalSceneName)
                .orderName(NaturalSortUtil.convert(finalSceneName))
                .type(ItemTypeEnum.SCENE)
                .parentId(DEFAULT_PARENT_ID)
                .status(DataStatusEnum.VALID)
                .annotationStatus(DataAnnotationStatusEnum.NOT_ANNOTATED)
                .splitType(SplitTypeEnum.NOT_SPLIT)
                .isDeleted(false)
                .createdAt(OffsetDateTime.now())
                .createdBy(userId)
                .build();
        dataInfoDAO.save(scene);

        var dataInfoLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataInfo.class);
        dataInfoLambdaUpdateWrapper.eq(DataInfo::getDatasetId, datasetId);
        dataInfoLambdaUpdateWrapper.in(DataInfo::getId, dataIds);
        dataInfoLambdaUpdateWrapper.set(DataInfo::getParentId, scene.getId());
        dataInfoLambdaUpdateWrapper.set(DataInfo::getUpdatedAt, OffsetDateTime.now());
        dataInfoLambdaUpdateWrapper.set(DataInfo::getUpdatedBy, userId);
        dataInfoDAO.update(dataInfoLambdaUpdateWrapper);
        return scene.getId();
    }

    @Transactional(rollbackFor = Exception.class)
    public SceneLocationUploadResultBO uploadSceneLocation(Long sceneId, MultipartFile file) {
        if (ObjectUtil.isNull(sceneId) || ObjectUtil.isNull(file) || file.isEmpty()) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }
        DataInfo scene = dataInfoDAO.getById(sceneId);
        if (ObjectUtil.isNull(scene) || Boolean.TRUE.equals(scene.getIsDeleted())) {
            throw new UsecaseException(UsecaseCode.DATA_NOT_FOUND);
        }
        if (!ItemTypeEnum.SCENE.equals(scene.getType())) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }
        try {
            String content = IoUtil.read(file.getInputStream(), StandardCharsets.UTF_8);
            return sceneLocationImportService.replaceSceneLocation(sceneId, Arrays.asList(content.split("\\r?\\n")));
        } catch (IOException e) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }
    }

    public Map<Long, SceneLocationBO> findPoseByDataIds(Collection<Long> dataIds) {
        if (CollUtil.isEmpty(dataIds)) {
            return Map.of();
        }
        List<SceneLocation> list = sceneLocationDAO.list(Wrappers.lambdaQuery(SceneLocation.class)
                .in(SceneLocation::getDataId, dataIds));
        return list.stream().collect(Collectors.toMap(SceneLocation::getDataId, e -> SceneLocationBO.builder()
                .dataId(e.getDataId())
                .posX(e.getPosX())
                .posY(e.getPosY())
                .posZ(e.getPosZ())
                .yaw(e.getYaw())
                .build()));
    }

    @Transactional(rollbackFor = Exception.class)
    public SceneResultImportResultBO importSceneResult(Long sceneId, MultipartFile file, Long userId) {
        if (ObjectUtil.isNull(sceneId) || ObjectUtil.isNull(file) || file.isEmpty()) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }
        DataInfo scene = dataInfoDAO.getById(sceneId);
        if (ObjectUtil.isNull(scene) || Boolean.TRUE.equals(scene.getIsDeleted())) {
            throw new UsecaseException(UsecaseCode.DATA_NOT_FOUND);
        }
        if (!ItemTypeEnum.SCENE.equals(scene.getType())) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }
        List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sceneId)
                .eq(DataInfo::getIsDeleted, false));
        Map<String, Long> nameToId = frames.stream()
                .collect(Collectors.toMap(DataInfo::getName, DataInfo::getId, (a, b) -> a));
        File workDir = FileUtil.file(String.format("%s/import_%s", tempPath, IdUtil.fastSimpleUUID()));
        FileUtil.mkdir(workDir);
        File unzipDir = FileUtil.file(workDir, "unzip");
        try {
            File zipFile = FileUtil.file(workDir, "import.zip");
            FileUtil.writeFromStream(file.getInputStream(), zipFile);
            ZipUtil.unzip(zipFile, unzipDir);
            List<File> resultFiles = FileUtil.loopFiles(unzipDir, -1, null).stream()
                    .filter(fc -> fc.getName().toUpperCase().endsWith(".JSON")
                            && fc.getParentFile().getName().equalsIgnoreCase("result"))
                    .collect(Collectors.toList());
            StringBuilder errorBuilder = new StringBuilder();
            List<Long> matchedDataIds = new ArrayList<>();
            List<DataAnnotationObjectBO> dataAnnotationObjectBOList = new ArrayList<>();
            for (File resultFile : resultFiles) {
                String dataName = FileUtil.getPrefix(resultFile);
                Long dataId = nameToId.get(dataName);
                if (ObjectUtil.isNull(dataId)) {
                    continue;
                }
                matchedDataIds.add(dataId);
                DataAnnotationObjectBO template = DataAnnotationObjectBO.builder()
                        .datasetId(scene.getDatasetId())
                        .dataId(dataId)
                        .createdBy(userId)
                        .createdAt(OffsetDateTime.now())
                        .sourceId(GROUND_TRUTH)
                        .build();
                File searchRoot = resultFile.getParentFile().getParentFile();
                uploadDataUseCase.handleDataResult(searchRoot, dataName, template, dataAnnotationObjectBOList, errorBuilder);
            }
            if (!matchedDataIds.isEmpty()) {
                dataAnnotationObjectDAO.remove(Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .in(DataAnnotationObject::getDataId, matchedDataIds));
            }
            if (!dataAnnotationObjectBOList.isEmpty()) {
                dataAnnotationObjectDAO.getBaseMapper().insertBatch(
                        DefaultConverter.convert(dataAnnotationObjectBOList, DataAnnotationObject.class));
            }
            return SceneResultImportResultBO.builder()
                    .totalFiles(resultFiles.size())
                    .matchedCount(matchedDataIds.size())
                    .unmatchedCount(resultFiles.size() - matchedDataIds.size())
                    .objectCount(dataAnnotationObjectBOList.size())
                    .errorMessage(errorBuilder.toString())
                    .build();
        } catch (IOException e) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        } finally {
            FileUtil.del(workDir);
        }
    }

    public String buildStaticGlobalMapHtml(Long sceneId) {
        DataInfo scene = dataInfoDAO.getById(sceneId);
        if (ObjectUtil.isNull(scene) || Boolean.TRUE.equals(scene.getIsDeleted())
                || !ItemTypeEnum.SCENE.equals(scene.getType())) {
            throw new UsecaseException(UsecaseCode.DATA_NOT_FOUND);
        }
        List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sceneId)
                .eq(DataInfo::getIsDeleted, false));
        if (CollUtil.isEmpty(frames)) {
            return renderStaticGlobalMap(scene.getName(), new JSONArray(), new JSONArray());
        }
        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        Map<Long, String> frameNameById = frames.stream()
                .collect(Collectors.toMap(DataInfo::getId, DataInfo::getName));
        List<SceneLocation> locations = sceneLocationDAO.list(Wrappers.lambdaQuery(SceneLocation.class)
                .in(SceneLocation::getDataId, frameIds));
        Map<Long, SceneLocation> poseByDataId = locations.stream()
                .collect(Collectors.toMap(SceneLocation::getDataId, l -> l, (a, b) -> a));
        JSONArray posesJson = new JSONArray();
        locations.forEach(location -> {
            JSONObject pose = new JSONObject();
            pose.set("frame", frameNameById.get(location.getDataId()));
            pose.set("x", valueOrZero(location.getPosX()));
            pose.set("y", valueOrZero(location.getPosY()));
            pose.set("yaw", valueOrZero(location.getYaw()));
            posesJson.add(pose);
        });
        List<DataAnnotationObject> objects = dataAnnotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class).in(DataAnnotationObject::getDataId, frameIds));
        JSONArray boxesJson = new JSONArray();
        Map<String, List<JSONObject>> boxesByTrack = new HashMap<>();
        for (DataAnnotationObject object : objects) {
            JSONObject attrs = object.getClassAttributes();
            if (ObjectUtil.isNull(attrs) || !"STATIC".equals(attrs.getStr("motionMode"))) {
                continue;
            }
            SceneLocation location = poseByDataId.get(object.getDataId());
            if (ObjectUtil.isNull(location)) {
                continue;
            }
            JSONObject contour = attrs.getJSONObject("contour");
            JSONObject center = ObjectUtil.isNull(contour) ? null : contour.getJSONObject("center3D");
            JSONObject size = ObjectUtil.isNull(contour) ? null : contour.getJSONObject("size3D");
            if (ObjectUtil.isNull(center) || ObjectUtil.isNull(size)) {
                continue;
            }
            JSONObject rotation = contour.getJSONObject("rotation3D");
            double poseX = valueOrZero(location.getPosX());
            double poseY = valueOrZero(location.getPosY());
            double poseYaw = valueOrZero(location.getYaw());
            double localX = jsonDouble(center, "x");
            double localY = jsonDouble(center, "y");
            double worldX = poseX + localX * Math.cos(poseYaw) - localY * Math.sin(poseYaw);
            double worldY = poseY + localX * Math.sin(poseYaw) + localY * Math.cos(poseYaw);
            double worldYaw = (ObjectUtil.isNull(rotation) ? 0.0 : jsonDouble(rotation, "z")) + poseYaw;
            String trackId = StrUtil.blankToDefault(attrs.getStr("trackId"),
                    attrs.getStr("id", String.valueOf(object.getId())));
            String className = StrUtil.blankToDefault(attrs.getStr("className"),
                    attrs.getStr("modelClass", String.valueOf(object.getClassId())));
            JSONObject box = new JSONObject();
            box.set("frame", frameNameById.get(object.getDataId()));
            box.set("trackId", trackId);
            box.set("trackName", attrs.getStr("trackName"));
            box.set("classId", object.getClassId());
            box.set("className", className);
            box.set("groupId", attrs.getStr("groupId"));
            box.set("x", worldX);
            box.set("y", worldY);
            box.set("yaw", worldYaw);
            box.set("length", Math.abs(jsonDouble(size, "x")));
            box.set("width", Math.abs(jsonDouble(size, "y")));
            boxesJson.add(box);
            boxesByTrack.computeIfAbsent(trackId, key -> new ArrayList<>()).add(box);
        }
        boxesByTrack.forEach((trackId, boxes) -> {
            double cx = boxes.stream().mapToDouble(b -> b.getDouble("x")).average().orElse(0.0);
            double cy = boxes.stream().mapToDouble(b -> b.getDouble("y")).average().orElse(0.0);
            double drift = boxes.stream()
                    .mapToDouble(b -> Math.hypot(b.getDouble("x") - cx, b.getDouble("y") - cy))
                    .max().orElse(0.0);
            boxes.forEach(b -> b.set("drift", drift));
        });
        return renderStaticGlobalMap(scene.getName(), posesJson, boxesJson);
    }

    private String renderStaticGlobalMap(String sceneName, JSONArray poses, JSONArray boxes) {
        String posesJson = JSONUtil.toJsonStr(poses).replace("</", "<\\/");
        String boxesJson = JSONUtil.toJsonStr(boxes).replace("</", "<\\/");
        return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Static Global Map</title><style>body{margin:0;font-family:Arial,sans-serif;background:#f3f5f8;color:#172033}.app{display:grid;grid-template-columns:360px 1fr;height:100vh}aside{background:#fff;border-right:1px solid #dfe5ef;padding:18px;overflow:auto}.viewport{margin:14px;background:#0f172a;border-radius:14px;overflow:hidden;height:calc(100vh - 28px)}svg{width:100%;height:100%;cursor:grab}.muted{color:#64748b;font-size:13px}.stats{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px}.card strong{display:block;font-size:20px}input,select,button{width:100%;margin:4px 0;border:1px solid #cbd5e1;border-radius:8px;padding:8px;background:#fff}.info{margin:12px 0;padding:10px;border-radius:10px;background:#eff6ff;border:1px solid #bfdbfe;font-size:13px;white-space:pre-wrap}.legend-item{display:grid;grid-template-columns:14px 1fr auto;gap:8px;align-items:center;font-size:13px;padding:4px 0}.swatch{width:14px;height:14px;border-radius:4px}.box{cursor:pointer}.box:hover{stroke-width:4}.label{pointer-events:none;paint-order:stroke;stroke:#0f172a;stroke-width:3px}.dimmed{opacity:.08}.trajectory{fill:none;stroke:#e2e8f0;stroke-width:2.4;stroke-dasharray:7 7}table{width:100%;border-collapse:collapse;font-size:12px}td,th{border-bottom:1px solid #e2e8f0;padding:6px 4px;text-align:left}.bad{color:#dc2626;font-weight:700}.warn{color:#d97706;font-weight:700}</style></head><body><div class=\"app\"><aside><h2>" + htmlEscape(sceneName) + " Static Global Map</h2><div class=\"muted\">\u6eda\u8f6e\u7f29\u653e\uff0c\u62d6\u62fd\u5e73\u79fb\u3002\u70b9\u51fb box \u67e5\u770b\u8be6\u60c5\u3002\u989c\u8272\u6309\u7c7b\u522b\u663e\u793a\u3002</div><div class=\"stats\"><div class=\"card\"><span>Frames</span><strong id=\"frameCount\">0</strong></div><div class=\"card\"><span>Static Boxes</span><strong id=\"boxCount\">0</strong></div></div><input id=\"search\" placeholder=\"\u641c\u7d22\u7c7b\u522b / trackId / frame\"><select id=\"trackSelect\"><option value=\"\">\u9009\u62e9\u6f02\u79fb track</option></select><button id=\"reset\">\u91cd\u7f6e\u89c6\u56fe</button><button id=\"clear\">\u6e05\u9664\u641c\u7d22</button><div id=\"info\" class=\"info\">\u672a\u9009\u62e9\u76ee\u6807</div><h3>Class Legend</h3><div id=\"legend\"></div><h3>Drift Summary</h3><table><thead><tr><th>class</th><th>trackId</th><th>frames</th><th>drift</th></tr></thead><tbody id=\"summary\"></tbody></table></aside><main><div class=\"viewport\"><svg id=\"map\"><g id=\"layer\"></g></svg></div></main></div><script>const poses=" + posesJson + ";const boxes=" + boxesJson + ";const svg=document.getElementById('map'),layer=document.getElementById('layer'),info=document.getElementById('info');let vb=[0,0,100,100],init=[...vb],drag=false,start=null;const esc=s=>String(s??'');const color=s=>{let h=0;for(const c of esc(s))h=(h*31+c.charCodeAt(0))%360;return `hsl(${h},75%,55%)`};function corners(b){const hx=b.length/2,hy=b.width/2,c=Math.cos(b.yaw),s=Math.sin(b.yaw);return [[-hx,-hy],[hx,-hy],[hx,hy],[-hx,hy]].map(p=>[b.x+p[0]*c-p[1]*s,b.y+p[0]*s+p[1]*c])}function bounds(){let xs=poses.map(p=>p.x),ys=poses.map(p=>p.y);boxes.forEach(b=>corners(b).forEach(p=>{xs.push(p[0]);ys.push(p[1])}));let pad=10;return [Math.min(...xs)-pad,Math.min(...ys)-pad,Math.max(...xs)+pad,Math.max(...ys)+pad]}function sx(x,minX,scale){return (x-minX)*scale}function sy(y,maxY,scale){return (maxY-y)*scale}function render(){document.getElementById('frameCount').textContent=poses.length;document.getElementById('boxCount').textContent=boxes.length;const [minX,minY,maxX,maxY]=bounds();const scale=8;const w=Math.max((maxX-minX)*scale,640),h=Math.max((maxY-minY)*scale,480);vb=[0,0,w,h];init=[...vb];svg.setAttribute('viewBox',vb.join(' '));let html='';html+=`<polyline class=\"trajectory\" points=\"${poses.map(p=>`${sx(p.x,minX,scale)},${sy(p.y,maxY,scale)}`).join(' ')}\"/>`;boxes.forEach((b,i)=>{const cls=b.className||b.classId||'Unknown',col=color(cls),pts=corners(b).map(p=>`${sx(p[0],minX,scale)},${sy(p[1],maxY,scale)}`).join(' '),tx=sx(b.x,minX,scale),ty=sy(b.y,maxY,scale);html+=`<polygon class=\"box\" data-i=\"${i}\" data-text=\"${esc(cls)} ${esc(b.trackId)} ${esc(b.frame)}\" points=\"${pts}\" fill=\"${col}\" fill-opacity=\".16\" stroke=\"${col}\" stroke-width=\"1.5\"></polygon><text class=\"label\" data-text=\"${esc(cls)} ${esc(b.trackId)} ${esc(b.frame)}\" x=\"${tx}\" y=\"${ty}\" font-size=\"10\" fill=\"${col}\">${esc(cls)} | ${esc(b.trackName||b.trackId)}</text>`});layer.innerHTML=html;document.querySelectorAll('.box').forEach(el=>el.onclick=()=>show(boxes[el.dataset.i]));renderLegend();renderSummary();}function show(b){info.textContent=Object.entries(b).map(([k,v])=>`${k}: ${typeof v==='number'?v.toFixed(3):esc(v)}`).join('\\n')}function renderLegend(){const m={};boxes.forEach(b=>{const k=b.className||b.classId||'Unknown';m[k]=(m[k]||0)+1});document.getElementById('legend').innerHTML=Object.entries(m).sort().map(([k,v])=>`<div class=\"legend-item\"><span class=\"swatch\" style=\"background:${color(k)}\"></span><span>${esc(k)}</span><strong>${v}</strong></div>`).join('')}function renderSummary(){const m={};boxes.forEach(b=>{(m[b.trackId]||(m[b.trackId]=[])).push(b)});const rows=Object.entries(m).map(([t,arr])=>[t,arr.length,Math.max(...arr.map(b=>b.drift||0)),arr[0].className||arr[0].classId||'-']).sort((a,b)=>b[2]-a[2]);trackSelect.innerHTML+=rows.map(r=>`<option value=\"${r[0]}\">${r[0]} | ${r[2].toFixed(2)}m</option>`).join('');document.getElementById('summary').innerHTML=rows.map(r=>`<tr><td>${r[3]}</td><td>${r[0]}</td><td>${r[1]}</td><td class=\"${r[2]>=1?'bad':r[2]>=.3?'warn':''}\">${r[2].toFixed(3)} m</td></tr>`).join('')}function setV(){svg.setAttribute('viewBox',vb.join(' '))}function pt(e){const r=svg.getBoundingClientRect();return [vb[0]+(e.clientX-r.left)/r.width*vb[2],vb[1]+(e.clientY-r.top)/r.height*vb[3]]}svg.onwheel=e=>{e.preventDefault();const p=pt(e),f=e.deltaY<0?.85:1.18;vb[0]=p[0]-(p[0]-vb[0])*f;vb[1]=p[1]-(p[1]-vb[1])*f;vb[2]*=f;vb[3]*=f;setV()};svg.onmousedown=e=>{drag=true;start=pt(e)};window.onmouseup=()=>drag=false;window.onmousemove=e=>{if(!drag)return;const p=pt(e);vb[0]-=p[0]-start[0];vb[1]-=p[1]-start[1];setV()};search.oninput=()=>{const q=search.value.toLowerCase();document.querySelectorAll('.box,.label').forEach(el=>el.classList.toggle('dimmed',q&&!el.dataset.text.toLowerCase().includes(q)))};trackSelect.onchange=()=>{const b=boxes.find(x=>x.trackId===trackSelect.value);if(b)show(b)};reset.onclick=()=>{vb=[...init];setV()};clear.onclick=()=>{search.value='';document.querySelectorAll('.dimmed').forEach(e=>e.classList.remove('dimmed'))};render();</script></body></html>";
    }

    private static double valueOrZero(Double value) {
        return value == null ? 0.0 : value;
    }

    private static double jsonDouble(JSONObject obj, String key) {
        Object value = obj.get(key);
        return value instanceof Number ? ((Number) value).doubleValue() : 0.0;
    }

    private static String htmlEscape(String value) {
        return value == null ? "" : value.replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace("\"", "&quot;").replace("'", "&#39;");
    }

    private String nextSceneName(Long datasetId) {
        var sceneCount = dataInfoDAO.count(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getDatasetId, datasetId)
                .eq(DataInfo::getType, ItemTypeEnum.SCENE)
                .eq(DataInfo::getIsDeleted, false));
        return String.format("Scene-%s", sceneCount + 1);
    }

    /**
     * Split scenes back into root-level single data rows.
     *
     * @param datasetId dataset id
     * @param sceneIds  scene ids to split
     * @param userId    current user id
     */
    @Transactional(rollbackFor = Exception.class)
    public void splitScene(Long datasetId, List<Long> sceneIds, Long userId) {
        if (ObjectUtil.isNull(datasetId) || CollUtil.isEmpty(sceneIds)) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }
        var dataset = datasetDAO.getById(datasetId);
        if (ObjectUtil.isNull(dataset)) {
            throw new UsecaseException(DATASET_NOT_FOUND);
        }
        if (!DatasetTypeEnum.LIDAR_FUSION.equals(dataset.getType())) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }

        var sceneLambdaQueryWrapper = Wrappers.lambdaQuery(DataInfo.class);
        sceneLambdaQueryWrapper.eq(DataInfo::getDatasetId, datasetId);
        sceneLambdaQueryWrapper.in(DataInfo::getId, sceneIds);
        sceneLambdaQueryWrapper.eq(DataInfo::getIsDeleted, false);
        var sceneList = dataInfoDAO.list(sceneLambdaQueryWrapper);
        if (sceneList.size() != new HashSet<>(sceneIds).size()) {
            throw new UsecaseException(UsecaseCode.DATA_NOT_FOUND);
        }
        var invalidScene = sceneList.stream().anyMatch(scene ->
                !ItemTypeEnum.SCENE.equals(scene.getType()) || !DEFAULT_PARENT_ID.equals(scene.getParentId()));
        if (invalidScene) {
            throw new UsecaseException(UsecaseCode.PARAM_ERROR);
        }

        var childLambdaQueryWrapper = Wrappers.lambdaQuery(DataInfo.class);
        childLambdaQueryWrapper.eq(DataInfo::getDatasetId, datasetId);
        childLambdaQueryWrapper.in(DataInfo::getParentId, sceneIds);
        childLambdaQueryWrapper.eq(DataInfo::getIsDeleted, false);
        var childList = dataInfoDAO.list(childLambdaQueryWrapper);
        var childIds = childList.stream().map(DataInfo::getId).collect(Collectors.toList());

        var lockedCount = dataEditDAO.count(Wrappers.lambdaQuery(DataEdit.class).in(DataEdit::getSceneId, sceneIds));
        if (lockedCount > 0) {
            throw new UsecaseException(UsecaseCode.DATASET_DATA_OTHERS_ANNOTATING);
        }
        if (CollUtil.isNotEmpty(childIds)) {
            lockedCount = dataEditDAO.count(Wrappers.lambdaQuery(DataEdit.class).in(DataEdit::getDataId, childIds));
            if (lockedCount > 0) {
                throw new UsecaseException(UsecaseCode.DATASET_DATA_OTHERS_ANNOTATING);
            }

            var childLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataInfo.class);
            childLambdaUpdateWrapper.eq(DataInfo::getDatasetId, datasetId);
            childLambdaUpdateWrapper.in(DataInfo::getId, childIds);
            childLambdaUpdateWrapper.set(DataInfo::getParentId, DEFAULT_PARENT_ID);
            childLambdaUpdateWrapper.set(DataInfo::getUpdatedAt, OffsetDateTime.now());
            childLambdaUpdateWrapper.set(DataInfo::getUpdatedBy, userId);
            dataInfoDAO.update(childLambdaUpdateWrapper);
        }

        var sceneLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataInfo.class);
        sceneLambdaUpdateWrapper.setSql("del_unique_key=id,is_deleted=1");
        sceneLambdaUpdateWrapper.eq(DataInfo::getDatasetId, datasetId);
        sceneLambdaUpdateWrapper.in(DataInfo::getId, sceneIds);
        sceneLambdaUpdateWrapper.set(DataInfo::getUpdatedAt, OffsetDateTime.now());
        sceneLambdaUpdateWrapper.set(DataInfo::getUpdatedBy, userId);
        dataInfoDAO.update(sceneLambdaUpdateWrapper);
    }

    /**
     * Data split
     *
     * @param splitFilterBO split filter parameter
     */
    @Transactional(rollbackFor = Exception.class)
    public void splitByFilter(DataInfoSplitFilterBO splitFilterBO) {
        var dataInfoLambdaQueryWrapper = getCommonSplitWrapper(splitFilterBO.getDatasetId(), splitFilterBO.getTargetDataType());
        var dataCount = dataInfoDAO.count(dataInfoLambdaQueryWrapper);
        var oneHundred = BigDecimal.valueOf(100);
        var limit = (int) Math.round(BigDecimal.valueOf(dataCount).multiply(BigDecimal.valueOf(splitFilterBO.getTotalSizeRatio())).divide(oneHundred).doubleValue());
        if (limit == 0) {
            return;
        }
        if (SplittingByEnum.RANDOM.equals(splitFilterBO.getSplittingBy())) {
            dataInfoLambdaQueryWrapper.last(" ORDER BY RAND()");
        } else {
            boolean isAsc = ObjectUtil.isNull(splitFilterBO.getAscOrDesc()) || SortEnum.ASC.equals(splitFilterBO.getAscOrDesc());
            dataInfoLambdaQueryWrapper.orderBy(SortByEnum.NAME.equals(splitFilterBO.getSortBy()), isAsc, DataInfo::getName);
            dataInfoLambdaQueryWrapper.orderBy(SortByEnum.CREATE_TIME.equals(splitFilterBO.getSortBy()), isAsc, DataInfo::getCreatedAt);
        }
        dataInfoLambdaQueryWrapper.last(" limit " + limit + "");
        var dataList = dataInfoDAO.list(dataInfoLambdaQueryWrapper);
        var dataIdList = dataList.stream().map(DataInfo::getId).collect(Collectors.toList());
        int indexTraining = (int) Math.round(BigDecimal.valueOf(limit).multiply(BigDecimal.valueOf(splitFilterBO.getTrainingRatio())).divide(oneHundred).doubleValue());
        int indexValidation = (int) Math.round(BigDecimal.valueOf(limit).multiply(BigDecimal.valueOf(splitFilterBO.getValidationRatio())).divide(oneHundred).doubleValue()) + indexTraining;
        var trainingDataIdList = dataIdList.subList(0, indexTraining);
        var validationDataIdList = dataIdList.subList(indexTraining, indexValidation);
        var testDataIdList = dataIdList.subList(indexValidation, limit);
        this.updateBatchByIds(trainingDataIdList, SplitTypeEnum.TRAINING);
        this.updateBatchByIds(validationDataIdList, SplitTypeEnum.VALIDATION);
        this.updateBatchByIds(testDataIdList, SplitTypeEnum.TEST);
    }

    private void updateBatchByIds(List<Long> dataIds, SplitTypeEnum splitType) {
        if (CollUtil.isNotEmpty(dataIds)) {
            var dataInfoLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataInfo.class);
            dataInfoLambdaUpdateWrapper.nested(wq -> wq.in(DataInfo::getId, dataIds)
                    .or()
                    .in(DataInfo::getParentId, dataIds));
            dataInfoLambdaUpdateWrapper.set(DataInfo::getSplitType, splitType);
            dataInfoDAO.update(dataInfoLambdaUpdateWrapper);
        }
    }

    /**
     * Total amount of segmented data obtained
     *
     * @param datasetId      Dataset id
     * @param targetDataType Data type
     * @return Total count
     */
    public Long getSplitDataTotalCount(Long datasetId, SplitTargetDataTypeEnum targetDataType) {
        var dataInfoLambdaQueryWrapper = getCommonSplitWrapper(datasetId, targetDataType);
        return dataInfoDAO.count(dataInfoLambdaQueryWrapper);
    }

    private LambdaQueryWrapper<DataInfo> getCommonSplitWrapper(Long datasetId, SplitTargetDataTypeEnum targetDataType) {
        var dataInfoLambdaQueryWrapper = Wrappers.lambdaQuery(DataInfo.class);
        dataInfoLambdaQueryWrapper.eq(DataInfo::getDatasetId, datasetId);
        dataInfoLambdaQueryWrapper.select(DataInfo::getId);
        dataInfoLambdaQueryWrapper.ne(SplitTargetDataTypeEnum.SPLIT.equals(targetDataType), DataInfo::getSplitType, SplitTargetDataTypeEnum.NOT_SPLIT);
        dataInfoLambdaQueryWrapper.eq(SplitTargetDataTypeEnum.NOT_SPLIT.equals(targetDataType), DataInfo::getSplitType, targetDataType);
        dataInfoLambdaQueryWrapper.eq(DataInfo::getParentId, DEFAULT_PARENT_ID);
        return dataInfoLambdaQueryWrapper;
    }


    /**
     * Batch delete
     *
     * @param datasetId dataset id
     * @param ids       Data id collection
     */
    @Transactional(rollbackFor = Exception.class)
    public void deleteBatch(Long datasetId, List<Long> ids) {

        var dataInfoLambdaQueryWrapper = Wrappers.lambdaQuery(DataInfo.class);
        dataInfoLambdaQueryWrapper.eq(DataInfo::getDatasetId, datasetId);
        dataInfoLambdaQueryWrapper.in(DataInfo::getId, ids);
        var dataCount = dataInfoDAO.count(dataInfoLambdaQueryWrapper);
        if (dataCount <= 0) {
            throw new UsecaseException(UsecaseCode.DATA_NOT_FOUND);
        }
        var count = dataEditDAO.count(Wrappers.lambdaQuery(DataEdit.class).in(DataEdit::getDataId, ids).or().in(DataEdit::getSceneId, ids));
        if (count > 0) {
            throw new UsecaseException(UsecaseCode.DATASET_DATA_OTHERS_ANNOTATING);
        }

        var dataInfoLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataInfo.class);
        dataInfoLambdaUpdateWrapper.setSql("del_unique_key=id,is_deleted=1");
        dataInfoLambdaUpdateWrapper.eq(DataInfo::getDatasetId, datasetId);
        dataInfoLambdaUpdateWrapper.nested(wq -> wq.in(DataInfo::getId, ids)
                .or()
                .in(DataInfo::getParentId, ids));
        dataInfoDAO.update(dataInfoLambdaUpdateWrapper);

        executorService.execute(Objects.requireNonNull(TtlRunnable.get(() -> {
            var dataAnnotationObjectLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataAnnotationObject.class);
            dataAnnotationObjectLambdaUpdateWrapper.eq(DataAnnotationObject::getDatasetId, datasetId);
            dataAnnotationObjectLambdaUpdateWrapper.in(DataAnnotationObject::getDataId, ids);
            dataAnnotationObjectDAO.remove(dataAnnotationObjectLambdaUpdateWrapper);
            var dataAnnotationClassificationLambdaUpdateWrapper = Wrappers.lambdaUpdate(DataAnnotationClassification.class);
            dataAnnotationClassificationLambdaUpdateWrapper.eq(DataAnnotationClassification::getDatasetId, datasetId);
            dataAnnotationClassificationLambdaUpdateWrapper.in(DataAnnotationClassification::getDataId, ids);
            dataAnnotationClassificationDAO.remove(dataAnnotationClassificationLambdaUpdateWrapper);
            datasetSimilarityJobUseCase.submitJob(datasetId);
        })));
    }

    /**
     * Paging query dataInfo
     *
     * @param queryBO Query parameter object
     * @return DataInfo page
     */
    public Page<DataInfoBO> findByPage(DataInfoQueryBO queryBO) {
        var lambdaQueryWrapper = commonDataQueryWrapper(queryBO);
        var dataInfoPage = dataInfoDAO.getBaseMapper().selectDataPage(new com.baomidou.mybatisplus.extension.plugins.pagination.Page<>(queryBO.getPageNo(), queryBO.getPageSize()),
                lambdaQueryWrapper, DefaultConverter.convert(queryBO, DataInfoQuery.class));
        var dataInfoBOPage = DefaultConverter.convert(dataInfoPage, DataInfoBO.class);
        var dataInfoBOList = dataInfoBOPage.getList();
        if (CollectionUtil.isNotEmpty(dataInfoBOList)) {
            setSceneFirstData(queryBO.getDatasetId(), dataInfoBOList);
            setDataInfoBOListFile(dataInfoBOList);
            var dataIds = dataInfoBOList.stream().map(DataInfoBO::getId).collect(Collectors.toList());
            var userIdMap = dataEditUseCase.getDataEditByDataIds(dataIds);
            var userIds = userIdMap.values();
            if (CollectionUtil.isNotEmpty(userIds)) {
                var userBOS = userUseCase.findByIds(ListUtil.toList(userIds));
                var userMap = userBOS.stream()
                        .collect(Collectors.toMap(UserBO::getId, UserBO::getNickname, (k1, k2) -> k1));
                dataInfoBOList.forEach(dataInfoBO -> dataInfoBO.setLockedBy(userMap.get(userIdMap.get(dataInfoBO.getId()))));
            }
        }
        return dataInfoBOPage;
    }


    /**
     * Query export data and return all data IDs
     *
     * @param dataInfoQueryBO Query object
     * @return Data id
     */
    @Deprecated
    public List<Long> findExportDataIds(DataInfoQueryBO dataInfoQueryBO) {
        var dataInfoQuery = DefaultConverter.convert(dataInfoQueryBO, DataInfoQuery.class);
        var lambdaQueryWrapper = commonDataQueryWrapper(dataInfoQueryBO);
        var dataList = dataInfoDAO.getBaseMapper().getExportData(lambdaQueryWrapper, dataInfoQuery);
        var dataIds = new ArrayList<Long>();
        var batchOrSceneIds = new ArrayList<Long>();
        if (CollUtil.isNotEmpty(dataList)) {
            dataList.forEach(dataInfo -> {
                if (ItemTypeEnum.SINGLE_DATA.equals(dataInfo.getType())) {
                    dataIds.add(dataInfo.getId());
                } else {
                    batchOrSceneIds.add(dataInfo.getId());
                }
            });
        }
        dataIds.addAll(this.getDataIdBySceneId(dataInfoQueryBO.getDatasetId(), batchOrSceneIds));
        return dataIds;
    }

    private List<Long> getDataIdBySceneId(Long datasetId, List<Long> sceneIds) {
        if (CollUtil.isEmpty(sceneIds)) {
            return ListUtil.empty();
        }
        var lambdaQueryWrapper = Wrappers.lambdaQuery(DataInfo.class)
                .select(DataInfo::getId)
                .eq(DataInfo::getDatasetId, datasetId)
                .eq(DataInfo::getType, ItemTypeEnum.SINGLE_DATA)
                .in(DataInfo::getParentId, sceneIds);
        var dataInfoList = dataInfoDAO.list(lambdaQueryWrapper);
        return CollUtil.isEmpty(dataInfoList) ? ListUtil.empty() : dataInfoList.stream().map(DataInfo::getId).collect(Collectors.toList());
    }

    public Wrapper<DataInfo> commonDataQueryWrapper(DataInfoQueryBO queryBO) {
        var lambdaQueryWrapper = new ExtendLambdaQueryWrapper<DataInfo>();
        lambdaQueryWrapper.eq(DataInfo::getDatasetId, queryBO.getDatasetId());
        lambdaQueryWrapper.eq(DataInfo::getIsDeleted, false);
        lambdaQueryWrapper.like(StrUtil.isNotEmpty(queryBO.getName()), DataInfo::getName, queryBO.getName());
        lambdaQueryWrapper.eq(ObjectUtil.isNotNull(queryBO.getAnnotationStatus()), DataInfo::getAnnotationStatus, queryBO.getAnnotationStatus());
        lambdaQueryWrapper.ge(ObjectUtil.isNotEmpty(queryBO.getCreateStartTime()), DataInfo::getCreatedAt, queryBO.getCreateStartTime());
        lambdaQueryWrapper.le(ObjectUtil.isNotEmpty(queryBO.getCreateEndTime()), DataInfo::getCreatedAt, queryBO.getCreateEndTime());
        lambdaQueryWrapper.in(CollUtil.isNotEmpty(queryBO.getIds()), DataInfo::getId, queryBO.getIds());
        lambdaQueryWrapper.eq(ObjectUtil.isNotNull(queryBO.getSplitType()), DataInfo::getSplitType, queryBO.getSplitType());
        lambdaQueryWrapper.eq(DataInfo::getParentId, ObjectUtil.isNotNull(queryBO.getParentId()) ? queryBO.getParentId() : Constants.DEFAULT_PARENT_ID);
        return lambdaQueryWrapper;
    }


    private void setSceneFirstData(Long datasetId, List<DataInfoBO> dataInfoBOList) {
        List<Long> dataIds = null;
        var sceneIds = dataInfoBOList.stream().filter(dataInfoBO -> ItemTypeEnum.SCENE.equals(dataInfoBO.getType())).map(DataInfoBO::getId).collect(Collectors.toList());
        if (CollectionUtil.isNotEmpty(sceneIds)) {
            dataIds = dataInfoDAO.getBaseMapper().selectFirstDataIdBySceneIds(datasetId, sceneIds);
        }
        if (CollectionUtil.isNotEmpty(dataIds)) {
            var dataInfoList = dataInfoDAO.listByIds(dataIds);
            var sceneDataInfoMap = dataInfoList.stream()
                    .collect(Collectors.toMap(DataInfo::getParentId, dataInfo -> dataInfo, (k1, k2) -> k1));
            dataInfoBOList.forEach(dataInfoBO -> {
                if (ItemTypeEnum.SCENE.equals(dataInfoBO.getType())) {
                    var dataInfo = sceneDataInfoMap.get(dataInfoBO.getId());
                    if (ObjectUtil.isNotNull(dataInfo)) {
                        dataInfoBO.setContent(DefaultConverter.convert(dataInfo.getContent(), DataInfoBO.FileNodeBO.class));
                        dataInfoBO.setFirstDataId(dataInfo.getId());
                    }
                }
            });
        }

    }

    /**
     * Query details by id
     *
     * @param id Data id
     * @return Data information
     */
    public DataInfoBO findById(Long id) {
        var dataInfoBO = DefaultConverter.convert(dataInfoDAO.getById(id), DataInfoBO.class);
        if (dataInfoBO == null) {
            throw new UsecaseException(UsecaseCode.NOT_FOUND);
        }
        var content = dataInfoBO.getContent();
        if (CollectionUtil.isNotEmpty(content)) {
            var fileIds = getFileIds(content);
            var fileMap = findFileByFileIds(fileIds);
            setFile(content, fileMap);
        }
        return dataInfoBO;
    }


    /**
     * Query data object list according to id collection
     *
     * @param ids                id collection
     * @param isQueryDeletedData Whether to query to delete data
     * @return Collection of data objects
     */
    public List<DataInfoBO> listByIds(List<Long> ids, Boolean isQueryDeletedData) {
        var dataInfoBOList = DefaultConverter.convert(dataInfoDAO.getBaseMapper().listByIds(ids, isQueryDeletedData), DataInfoBO.class);
        if (CollectionUtil.isNotEmpty(dataInfoBOList)) {
            setSceneFirstData(CollUtil.getFirst(dataInfoBOList).getDatasetId(), dataInfoBOList);
            setDataInfoBOListFile(dataInfoBOList);
        }
        return dataInfoBOList;
    }

    /**
     * Query data object list according to id collection
     *
     * @param ids                id collection
     * @param isQueryDeletedData Whether to query to delete data
     * @return Collection of data objects
     */
    public List<DataInfoBO> listRelationByIds(List<Long> ids, Boolean isQueryDeletedData) {
        var dataInfoBOList = DefaultConverter.convert(dataInfoDAO.getBaseMapper().listByIds(ids, isQueryDeletedData), DataInfoBO.class);
        if (CollectionUtil.isNotEmpty(dataInfoBOList)) {
            setDataInfoBOListFile(dataInfoBOList);
            var dataIds = new ArrayList<Long>();
            var datasetIds = new HashSet<Long>();
            dataInfoBOList.forEach(dataInfoBO -> {
                dataIds.add(dataInfoBO.getId());
                datasetIds.add(dataInfoBO.getDatasetId());
            });
            var userIdMap = dataEditUseCase.getDataEditByDataIds(dataIds);
            var userIds = userIdMap.values();
            if (CollectionUtil.isNotEmpty(userIds)) {
                var userBOS = userUseCase.findByIds(ListUtil.toList(userIds));
                var userMap = userBOS.stream()
                        .collect(Collectors.toMap(UserBO::getId, UserBO::getNickname, (k1, k2) -> k1));
                dataInfoBOList.forEach(dataInfoBO -> dataInfoBO.setLockedBy(userMap.get(userIdMap.get(dataInfoBO.getId()))));
            }
            var datasetList = datasetDAO.listByIds(datasetIds);
            var datasetMap = datasetList.stream().collect(Collectors.toMap(Dataset::getId, Dataset::getName));
            dataInfoBOList.forEach(dataInfoBO -> dataInfoBO.setDatasetName(datasetMap.get(dataInfoBO.getDatasetId())));
        }
        return dataInfoBOList;
    }

    /**
     * Query data object list according to id collection
     *
     * @param ids id collection
     * @return Collection of data objects
     */
    public List<DataInfoBO> getDataStatusByIds(List<Long> ids) {
        return DefaultConverter.convert(dataInfoDAO.listByIds(ids), DataInfoBO.class);
    }


    /**
     * Query dataset statistics based on dataset id collection
     *
     * @param datasetIds dataset id collection
     * @return Dataset Statistics
     */
    public Map<Long, DatasetStatisticsBO> getDatasetStatisticsByDatasetIds(List<Long> datasetIds) {
        var datasetStatisticsList = dataInfoDAO.getBaseMapper().getDatasetStatisticsByDatasetIds(datasetIds);
        return datasetStatisticsList.stream()
                .collect(Collectors.toMap(DatasetStatistics::getDatasetId, datasetStatistics -> DefaultConverter.convert(datasetStatistics, DatasetStatisticsBO.class), (k1, k2) -> k1));
    }

    /**
     * Get dataset statistics based on dataset id
     *
     * @param datasetId Dataset id
     * @return Dataset statistics
     */
    public DatasetStatisticsBO getDatasetStatisticsByDatasetId(Long datasetId) {
        var datasetStatisticsList = dataInfoDAO.getBaseMapper().getDatasetStatisticsByDatasetIds(Collections.singletonList(datasetId));
        return DefaultConverter.convert(datasetStatisticsList.stream().findFirst()
                .orElse(new DatasetStatistics(datasetId, 0, 0, 0)), DatasetStatisticsBO.class);
    }

    /**
     * Generate pre-signed url
     *
     * @param fileName  file name
     * @param datasetId dataset id
     * @param userId    user id
     */
    public PresignedUrlBO generatePresignedUrl(String fileName, Long datasetId, Long userId) {
        var objectName = String.format("%s/%s/%s/%s", userId, datasetId, UUID.randomUUID().toString().replace("-", ""), fileName);
        try {
            return minioService.generatePresignedUrl(minioProp.getBucketName(), objectName, Boolean.TRUE);
        } catch (Exception e) {
            log.error("Minio generate presigned url error", e);
            throw new UsecaseException("Minio generate presigned url error!");
        }
    }

    /**
     * Batch insert
     *
     * @param dataInfoBOList Collection of data details
     */
    public List<DataInfoBO> insertBatch(List<DataInfoBO> dataInfoBOList, Long datasetId, StringBuilder errorBuilder) {
        var names = dataInfoBOList.stream().map(DataInfoBO::getName).collect(Collectors.toList());
        var existDataInfoList = this.findByNames(datasetId, names);
        if (CollUtil.isNotEmpty(existDataInfoList)) {
            var existNames = existDataInfoList.stream().map(DataInfoBO::getName).collect(Collectors.toList());
            dataInfoBOList = dataInfoBOList.stream().filter(dataInfoBO -> !existNames.contains(dataInfoBO.getName())).collect(Collectors.toList());
            if (!errorBuilder.toString().contains("Duplicate")) {
                errorBuilder.append("Duplicate data names;");
            }
        }
        if (CollUtil.isEmpty(dataInfoBOList)) {
            return List.of();
        }
        try {
            List<DataInfo> infos = DefaultConverter.convert(dataInfoBOList, DataInfo.class);
            dataInfoDAO.saveBatch(infos);
            return DefaultConverter.convert(infos, DataInfoBO.class);
        } catch (DuplicateKeyException e) {
            log.error("Duplicate data name", e);
            if (!errorBuilder.toString().contains("Duplicate")) {
                errorBuilder.append("Duplicate data names;");
            }
            return List.of();
        }
    }

    /**
     * Export data
     *
     * @param dataInfoQueryBO Query parameters
     * @return Serial number
     */
    public Long export(DataInfoQueryBO dataInfoQueryBO) {
        var dataset = datasetDAO.getById(dataInfoQueryBO.getDatasetId());
        var fileName = String.format("%s-%s.zip", dataset.getName(), TemporalAccessorUtil.format(OffsetDateTime.now(), DatePattern.PURE_DATETIME_PATTERN));
        var serialNumber = exportUseCase.createExportRecord(fileName);
        dataInfoQueryBO.setPageNo(PAGE_NO);
        dataInfoQueryBO.setPageSize(PAGE_SIZE);
        dataInfoQueryBO.setDatasetType(dataset.getType());
        var datasetClassBOList = datasetClassUseCase.findAll(dataInfoQueryBO.getDatasetId());
        var classMap = new HashMap<Long, String>();
        if (CollectionUtil.isNotEmpty(datasetClassBOList)) {
            classMap.putAll(datasetClassBOList.stream().collect(Collectors.toMap(DatasetClassBO::getId, DatasetClassBO::getName)));
        }
        var resultMap = new HashMap<Long, String>();
        if (CollectionUtil.isNotEmpty(dataInfoQueryBO.getSelectModelRunIds())) {
            var modelRunRecordBOList = modelRunRecordUseCase.findByIds(dataInfoQueryBO.getSelectModelRunIds());
            if (CollUtil.isNotEmpty(modelRunRecordBOList)) {
                resultMap.putAll(modelRunRecordBOList.stream().collect(Collectors.toMap(ModelRunRecordBO::getId, ModelRunRecordBO::getRunNo)));
            }
            if (dataInfoQueryBO.getSelectModelRunIds().contains(GROUND_TRUTH)) {
                resultMap.put(GROUND_TRUTH, GROUND_TRUTH_NAME);
            }
        }
        dataInfoQueryBO.setIsAllResult(false);
        dataInfoQueryBO.setDataFormat(IMAGE.equals(dataInfoQueryBO.getDatasetType()) ? dataInfoQueryBO.getDataFormat() : DataFormatEnum.XTREME1);
        executorService.execute(Objects.requireNonNull(TtlRunnable.get(() ->
                exportUseCase.asyncExportDataZip(fileName, serialNumber, classMap, resultMap, dataInfoQueryBO,
                        this::findExportDataIds,
                        this::processData))));
        return serialNumber;
    }


    private List<DataInfoBO> findByNames(Long datasetId, List<String> names) {
        var dataInfoLambdaQueryWrapper = Wrappers.lambdaQuery(DataInfo.class);
        dataInfoLambdaQueryWrapper.eq(DataInfo::getDatasetId, datasetId);
        dataInfoLambdaQueryWrapper.in(DataInfo::getName, names);
        return DefaultConverter.convert(dataInfoDAO.list(dataInfoLambdaQueryWrapper), DataInfoBO.class);
    }

    /**
     * Data annotation
     *
     * @param dataPreAnnotationBO Data pre-annotation parameter
     * @param userId              User id
     * @return Annotation record id
     */
    @Transactional(rollbackFor = Throwable.class)
    public Long annotate(DataPreAnnotationBO dataPreAnnotationBO, Long userId) {
        return annotateCommon(dataPreAnnotationBO, null, userId);
    }

    private Long annotateCommon(DataPreAnnotationBO dataPreAnnotationBO, Long serialNo, Long userId) {
        var lambdaQueryWrapper = Wrappers.lambdaQuery(DataAnnotationRecord.class);
        lambdaQueryWrapper.eq(DataAnnotationRecord::getDatasetId, dataPreAnnotationBO.getDatasetId());
        lambdaQueryWrapper.eq(DataAnnotationRecord::getCreatedBy, userId);
        log.info("userId:{}", RequestContextHolder.getContext().getUserInfo().getId());
        log.info("datasetId:{},userId:{}", dataPreAnnotationBO.getDatasetId(), userId);
        var isFilterData = ObjectUtil.isNotNull(dataPreAnnotationBO.getIsFilterData()) ? dataPreAnnotationBO.getIsFilterData() : false;
        var boo = true;
        var dataAnnotationRecord = DataAnnotationRecord.builder()
                .datasetId(dataPreAnnotationBO.getDatasetId()).itemType(dataPreAnnotationBO.getOperateItemType()).createdBy(userId).serialNo(serialNo).build();
        try {
            dataAnnotationRecordDAO.save(dataAnnotationRecord);
        } catch (DuplicateKeyException duplicateKeyException) {
            boo = false;
            dataAnnotationRecord = dataAnnotationRecordDAO.getOne(lambdaQueryWrapper);
            if (!dataAnnotationRecord.getItemType().equals(dataPreAnnotationBO.getOperateItemType())) {
                throw new UsecaseException(UsecaseCode.DATASET_DATA_EXIST_OTHER_TYPE_ANNOTATE);
            }
            var dataEditLambdaQueryWrapper = Wrappers.lambdaQuery(DataEdit.class);
            dataEditLambdaQueryWrapper.eq(DataEdit::getAnnotationRecordId, dataAnnotationRecord.getId());
            var list = dataEditDAO.list(dataEditLambdaQueryWrapper);
            var dataIds = list.stream().map(DataEdit::getDataId).collect(Collectors.toList());
            if (dataPreAnnotationBO.getOperateItemType().equals(ItemTypeEnum.SCENE)) {
                dataIds = list.stream().map(DataEdit::getSceneId).collect(Collectors.toList());
            }
            if (CollectionUtil.isNotEmpty(dataIds) && dataIds.contains(dataPreAnnotationBO.getDataIds().get(0)) && isFilterData) {
                return dataAnnotationRecord.getId();
            }
        }
        var insertCount = batchInsertDataEdit(dataAnnotationRecord.getId(), dataPreAnnotationBO, userId);
        if (isFilterData) {
            if (insertCount == 0) {
                throw new UsecaseException(UsecaseCode.DATASET_DATA_EXIST_ANNOTATE);
            }
        } else {
            // Indicates that no new data is locked and there is no old lock record
            if (insertCount == 0 && boo) {
                throw new UsecaseException(UsecaseCode.DATASET_DATA_EXIST_ANNOTATE);
            }
        }
        return dataAnnotationRecord.getId();
    }

    /**
     * Data annotation with model
     *
     * @param dataPreAnnotationBO Data pre-annotation parameter
     * @param userId              User id
     * @return Annotation record id
     */
    @Transactional(rollbackFor = Throwable.class)
    public Long annotateWithModel(DataPreAnnotationBO dataPreAnnotationBO, Long userId) {
        Long serialNo = IdUtil.getSnowflakeNextId();
        ModelBO modelBO = modelUseCase.findById(dataPreAnnotationBO.getModelId());
        if (ObjectUtil.isNull(modelBO)) {
            throw new UsecaseException(UsecaseCode.MODEL_DOES_NOT_EXIST);
        }
        if (ObjectUtil.isNotNull(modelBO)) {
            batchInsertModelDataResult(dataPreAnnotationBO, modelBO, userId, serialNo);
        }
        return annotateCommon(dataPreAnnotationBO, serialNo, userId);
    }

    /**
     * Batch insert lock data
     *
     * @param dataAnnotationRecord Data annotation record
     */
    private Integer batchInsertDataEdit(Long dataAnnotationRecordId, DataPreAnnotationBO dataAnnotationRecord, Long userId) {
        var dataIds = dataAnnotationRecord.getDataIds();
        var insertCount = 0;
        if (CollectionUtil.isEmpty(dataIds)) {
            return insertCount;
        }
        var dataInfos = dataIds.stream().map(dataId -> DataInfoBO.builder().id(dataId).build()).collect(Collectors.toList());
        if (dataAnnotationRecord.getOperateItemType().equals(ItemTypeEnum.SCENE)) {
            dataInfos = getDataInfoBySceneIds(dataAnnotationRecord.getDatasetId(), dataIds);
        }
        var dataEditSubList = new ArrayList<DataEdit>();
        int i = 1;
        var dataEditBuilder = DataEdit.builder()
                .annotationRecordId(dataAnnotationRecordId)
                .datasetId(dataAnnotationRecord.getDatasetId())
                .modelId(dataAnnotationRecord.getModelId())
                .modelVersion(dataAnnotationRecord.getModelVersion())
                .createdBy(userId);
        for (var dataInfo : dataInfos) {
            var dataEdit = dataEditBuilder.dataId(dataInfo.getId()).sceneId(dataInfo.getParentId()).build();
            dataEditSubList.add(dataEdit);
            if ((i % BATCH_SIZE == 0) || i == dataInfos.size()) {
                insertCount += dataEditDAO.getBaseMapper().insertIgnoreBatch(dataEditSubList);
                dataEditSubList.clear();
            }
            i++;
        }
        return insertCount;
    }

    public Map<Long, List<Long>> getDataIdBySceneIds(Long datasetId, List<Long> sceneIds) {
        var dataInfoList = getDataInfoBySceneIds(datasetId, sceneIds);
        var sceneDataMap = new HashMap<Long, List<Long>>();
        if (CollUtil.isEmpty(dataInfoList)) {
            return sceneDataMap;

        }
        dataInfoList.forEach(dataInfo -> sceneDataMap.computeIfAbsent(dataInfo.getParentId(),
                k -> new ArrayList<>()).add(dataInfo.getId()));
        return sceneDataMap;
    }

    public List<DataInfoBO> getDataInfoBySceneIds(Long datasetId, List<Long> sceneIds) {
        var lambdaQueryWrapper = new LambdaQueryWrapper<DataInfo>();
        lambdaQueryWrapper.select(DataInfo::getId, DataInfo::getName, DataInfo::getOrderName, DataInfo::getParentId);
        lambdaQueryWrapper.in(DataInfo::getParentId, sceneIds);
        lambdaQueryWrapper.eq(DataInfo::getType, ItemTypeEnum.SINGLE_DATA);
        lambdaQueryWrapper.eq(DataInfo::getDatasetId, datasetId);
        lambdaQueryWrapper.orderByAsc(DataInfo::getOrderName);
        var dataInfoList = dataInfoDAO.list(lambdaQueryWrapper);
        return DefaultConverter.convert(dataInfoList, DataInfoBO.class);
    }

    /**
     * Model annotate
     *
     * @param dataPreAnnotationBO Data pre-annotation parameter
     * @param userId              User id
     * @return Serial number
     */
    @Transactional(rollbackFor = Throwable.class)
    public String modelAnnotate(DataPreAnnotationBO dataPreAnnotationBO, Long userId) {
        var modelBO = modelUseCase.findById(dataPreAnnotationBO.getModelId());
        var serialNo = IdUtil.getSnowflakeNextId();
        batchInsertModelDataResult(dataPreAnnotationBO, modelBO, userId, serialNo);
        return String.valueOf(serialNo);
    }

    /**
     * Batch insert data model results
     *
     * @param dataPreAnnotationBO Data pre-annotation parameter
     * @param modelBO             Model information
     * @param userId              User id
     */
    private void batchInsertModelDataResult(DataPreAnnotationBO dataPreAnnotationBO, ModelBO modelBO, Long userId, Long serialNo) {
        var modelDataResultList = new ArrayList<ModelDataResult>();
        var dataIds = dataPreAnnotationBO.getDataIds();
        if (ItemTypeEnum.SCENE.equals(dataPreAnnotationBO.getOperateItemType())) {
            var dataInfos = getDataInfoBySceneIds(dataPreAnnotationBO.getDatasetId(), dataIds);
            dataIds = dataInfos.stream().map(DataInfoBO::getId).collect(Collectors.toList());
        }
        var modelMessageBO = DefaultConverter.convert(dataPreAnnotationBO, ModelMessageBO.class);
        modelMessageBO.setCreatedBy(userId);
        modelMessageBO.setModelSerialNo(serialNo);
        modelMessageBO.setModelId(modelBO.getId());
        modelMessageBO.setModelVersion(modelBO.getVersion());
        modelMessageBO.setUrl(modelBO.getUrl());
        int i = 1;
        var modelDataResultBuilder = ModelDataResult.builder()
                .modelId(modelBO.getId())
                .modelVersion(modelBO.getVersion())
                .datasetId(dataPreAnnotationBO.getDatasetId())
                .modelSerialNo(serialNo)
                .resultFilterParam(JSONUtil.toJsonStr(dataPreAnnotationBO.getResultFilterParam()));
        for (var dataId : dataIds) {
            var modelDataResult = modelDataResultBuilder.dataId(dataId).build();
            modelDataResultList.add(modelDataResult);
            if ((i % BATCH_SIZE == 0) || i == dataIds.size()) {
                modelDataResultDAO.getBaseMapper().insertIgnoreBatch(modelDataResultList);
                modelDataResultList.clear();
            }
            i++;
        }
        var dataInfoBOList = listByIds(dataIds, false);
        var dataMap = dataInfoBOList.stream().collect(Collectors.toMap(DataInfoBO::getId, dataInfoBO -> dataInfoBO));
        for (var dataId : dataIds) {
            modelMessageBO.setDataId(dataId);
            modelMessageBO.setDataInfo(dataMap.get(dataId));
            modelMessageBO.setDatasetId(dataMap.get(dataId).getDatasetId());
            modelUseCase.sendDataModelMessageToMQ(modelMessageBO);
        }
    }

    /**
     * Get model annotation results
     *
     * @param serialNo Serial number
     * @param dataIds  Data id collection
     * @return Model annotation result
     */
    public ModelObjectBO getModelAnnotateResult(Long serialNo, List<Long> dataIds) {
        var lambdaQueryWrapper = new LambdaQueryWrapper<ModelDataResult>();
        lambdaQueryWrapper.eq(ModelDataResult::getModelSerialNo, serialNo);
        if (CollectionUtil.isNotEmpty(dataIds)) {
            lambdaQueryWrapper.in(ModelDataResult::getDataId, dataIds);
        }
        lambdaQueryWrapper.isNotNull(ModelDataResult::getModelResult);
        var modelDataResultList = modelDataResultDAO.getBaseMapper().selectList(lambdaQueryWrapper);
        if (CollectionUtil.isNotEmpty(modelDataResultList)) {
            var modelId = modelDataResultList.stream().findFirst().orElse(new ModelDataResult()).getModelId();
            var modelBO = modelUseCase.findById(modelId);
            return ModelObjectBO.builder().modelCode(modelBO.getModelCode())
                    .modelDataResults(DefaultConverter.convert(modelDataResultList, ModelDataResultBO.class)).build();
        }
        return new ModelObjectBO();
    }

    /**
     * Get Model run data id
     *
     * @param modelRunFilterData Model run Filter data parameter
     * @param datasetId          Dataset id
     * @param modelId            Model id
     * @param limit              data id count
     * @return data id
     */
    public List<Long> findModelRunDataIds(ModelRunFilterDataBO modelRunFilterData, Long datasetId, Long modelId, Long limit) {
        var lambdaQueryWrapper = this.getCommonModelRunDataWrapper(modelRunFilterData, datasetId);
        return dataInfoDAO.getBaseMapper().findModelRunDataIds(lambdaQueryWrapper, modelId, modelRunFilterData.getIsExcludeModelData(), limit);
    }

    /**
     * Get Model run data count
     *
     * @param modelRunFilterData Model run Filter data parameter
     * @param datasetId          Dataset id
     * @param modelId            Model id
     * @return data count
     */
    public Long findModelRunDataCount(ModelRunFilterDataBO modelRunFilterData, Long datasetId, Long modelId) {
        var lambdaQueryWrapper = this.getCommonModelRunDataWrapper(modelRunFilterData, datasetId);
        return dataInfoDAO.getBaseMapper().findModelRunDataCount(lambdaQueryWrapper, modelId, modelRunFilterData.getIsExcludeModelData());
    }

    private Wrapper<DataInfo> getCommonModelRunDataWrapper(ModelRunFilterDataBO modelRunFilterData, Long datasetId) {
        var lambdaQueryWrapper = Wrappers.lambdaQuery(DataInfo.class);
        lambdaQueryWrapper.eq(DataInfo::getDatasetId, datasetId);
        lambdaQueryWrapper.eq(ObjectUtil.isNotNull(modelRunFilterData.getAnnotationStatus()), DataInfo::getAnnotationStatus, modelRunFilterData.getAnnotationStatus());
        lambdaQueryWrapper.eq(ObjectUtil.isNotNull(modelRunFilterData.getSplitType()), DataInfo::getSplitType, modelRunFilterData.getSplitType());
        lambdaQueryWrapper.eq(DataInfo::getIsDeleted, false);
        lambdaQueryWrapper.eq(DataInfo::getType, ItemTypeEnum.SINGLE_DATA);
        return lambdaQueryWrapper;
    }

    /**
     * Get the file information and set the file information to the data list
     *
     * @param dataInfoBOList Data collection
     */
    private void setDataInfoBOListFile(List<DataInfoBO> dataInfoBOList) {
        var fileIds = new ArrayList<Long>();
        dataInfoBOList.forEach(dataInfoBO -> fileIds.addAll(getFileIds(dataInfoBO.getContent())));
        if (CollectionUtil.isNotEmpty(fileIds)) {
            var fileMap = findFileByFileIds(fileIds);
            dataInfoBOList.forEach(dataInfoBO -> setFile(dataInfoBO.getContent(), fileMap));
        }
    }

    /**
     * Set file information in content
     *
     * @param fileNodeBOList Data file information
     * @param fileMap        File map
     */
    private void setFile(List<DataInfoBO.FileNodeBO> fileNodeBOList, Map<Long, RelationFileBO> fileMap) {
        if (CollectionUtil.isEmpty(fileNodeBOList)) {
            return;
        }
        fileNodeBOList.forEach(fileNodeBO -> {
            if (fileNodeBO.getType().equals(FILE)) {
                fileNodeBO.setFile(fileMap.get(fileNodeBO.getFileId()));
            } else {
                setFile(fileNodeBO.getFiles(), fileMap);
            }
        });
    }

    /**
     * Query file information based on file ID collection
     *
     * @param fileIds File id collection
     * @return Relation file map
     */
    private Map<Long, RelationFileBO> findFileByFileIds(List<Long> fileIds) {
        var relationFileBOList = fileUseCase.findByIds(fileIds);
        return CollectionUtil.isNotEmpty(relationFileBOList) ?
                relationFileBOList.stream().collect(Collectors.toMap(RelationFileBO::getId, relationFileBO -> relationFileBO, (k1, k2) -> k1)) : Map.of();

    }

    /**
     * Loop to get file ID from content
     *
     * @param fileNodeBOList File node List
     * @return File id collection
     */
    private List<Long> getFileIds(List<DataInfoBO.FileNodeBO> fileNodeBOList) {
        var fileIds = new ArrayList<Long>();
        if (CollectionUtil.isEmpty(fileNodeBOList)) {
            return fileIds;
        }
        fileNodeBOList.forEach(fileNodeBO -> {
            if (fileNodeBO.getType().equals(FILE)) {
                fileIds.add(fileNodeBO.getFileId());
            } else {
                fileIds.addAll(getFileIds(fileNodeBO.getFiles()));
            }
        });
        return fileIds;
    }

    /**
     * Data process
     *
     * @param dataIds   Data id list
     * @param queryBO   Data query parameters
     * @param classMap  Class id and class name associated map
     * @param resultMap Result id and result name associated map
     * @return Data export collection
     */
    public List<DataExportBO> processData(List<Long> dataIds, DataInfoQueryBO queryBO, Map<Long, String> classMap, Map<Long, String> resultMap) {
        if (CollectionUtil.isEmpty(dataIds)) {
            return List.of();
        }
        var dataInfoExportBOList = new ArrayList<DataExportBO>();
        var dataAnnotationList = dataAnnotationClassificationUseCase.findByDataIds(dataIds);
        Map<Long, List<DataAnnotationClassificationBO>> dataAnnotationMap = CollectionUtil.isNotEmpty(dataAnnotationList) ? dataAnnotationList.stream().collect(
                Collectors.groupingBy(DataAnnotationClassificationBO::getDataId)) : Map.of();
        var dataAnnotationObjectList = dataAnnotationObjectUseCase.findByDataIds(dataIds, queryBO.getIsAllResult(), queryBO.getSelectModelRunIds());
        Map<Long, List<DataAnnotationObjectBO>> dataAnnotationObjectMap = CollectionUtil.isNotEmpty(dataAnnotationObjectList) ?
                dataAnnotationObjectList.stream().collect(Collectors.groupingBy(DataAnnotationObjectBO::getDataId))
                : Map.of();
        var dataList = this.listByIds(dataIds, true);
        this.addSceneInfo(dataList);
        dataList.forEach(dataInfoBO -> {
            var dataId = dataInfoBO.getId();
            var dataExportBaseBO = assembleExportDataContent(dataInfoBO, queryBO.getDatasetType());
            var annotationList = dataAnnotationMap.get(dataId);
            var objectList = dataAnnotationObjectMap.get(dataId);
            var dataResultExportBOList = new ArrayList<DataResultExportBO>();
            if (CollectionUtil.isNotEmpty(objectList)) {
                var objectSourceMap = objectList.stream().collect(Collectors.groupingBy(DataAnnotationObjectBO::getSourceId));
                objectSourceMap.forEach((sourceId, objectSourceList) -> {
                    var dataResultExportBO = DataResultExportBO.builder().dataId(dataId).version(version).build();
                    var objects = new ArrayList<DataResultObjectExportBO>();
                    objectSourceList.forEach(o -> {
                        var dataResultObjectExportBO = DefaultConverter.convert(o.getClassAttributes(), DataResultObjectExportBO.class);
                        dataResultObjectExportBO.setClassName(classMap.get(o.getClassId()));
                        dataResultObjectExportBO.setClassId(o.getClassId());
                        objects.add(dataResultObjectExportBO);
                    });
                    dataResultExportBO.setObjects(objects);
                    dataResultExportBO.setSourceName(resultMap.get(sourceId));

                    if (GROUND_TRUTH.equals(sourceId)) {
                        if (CollectionUtil.isNotEmpty(annotationList)) {
                            var classificationAttributes = annotationList.stream().map(DataAnnotationClassificationBO::getClassificationAttributes).collect(Collectors.toList());
                            dataResultExportBO.setClassificationValues(JSONUtil.parseArray(classificationAttributes));
                        }
                    }
                    dataResultExportBOList.add(dataResultExportBO);
                });

            }
            var dataInfoExportBO = DataExportBO.builder().data(dataExportBaseBO).build();
            dataInfoExportBO.setSceneName(dataInfoBO.getSceneName());
            if (CollectionUtil.isNotEmpty(annotationList) || CollectionUtil.isNotEmpty(objectList)) {
                dataInfoExportBO.setResult(dataResultExportBOList);
            }
            dataInfoExportBOList.add(dataInfoExportBO);
        });
        return dataInfoExportBOList;
    }

    private void addSceneInfo(List<DataInfoBO> dataInfoBOList) {
        var sceneMap = new HashMap<Long, DataInfoBO>();
        var sceneIds = dataInfoBOList.stream().filter(dataInfoBO -> ObjectUtil.isNotNull(dataInfoBO.getParentId()) && dataInfoBO.getParentId() != 0).map(DataInfoBO::getParentId).collect(Collectors.toList());
        // Find the upper Scene
        if (CollUtil.isNotEmpty(sceneIds)) {
            var sceneList = dataInfoDAO.listByIds(sceneIds);
            if (CollUtil.isNotEmpty(sceneList)) {
                sceneMap.putAll(sceneList.stream().collect(Collectors.toMap(DataInfo::getId, dataInfo -> DefaultConverter.convert(dataInfo, DataInfoBO.class))));
                handleSingleData(dataInfoBOList, sceneMap);
            }
        }
    }

    private void handleSingleData(List<DataInfoBO> singleDataList, Map<Long, DataInfoBO> sceneMap) {
        if (CollUtil.isEmpty(singleDataList)) {
            return;
        }
        singleDataList.stream().filter(dataInfoBO -> 0 != dataInfoBO.getParentId()).forEach(dataInfoBO -> {
            var scene = sceneMap.get(dataInfoBO.getParentId());
            dataInfoBO.setSceneName(scene.getName());
        });
    }

    /**
     * Assemble the export data content
     *
     * @return data information
     */
    private DataExportBaseBO assembleExportDataContent(DataInfoBO dataInfoBO, DatasetTypeEnum datasetType) {
        DataExportBaseBO dataExportBaseBO = new DataExportBaseBO();
        dataExportBaseBO.setDataId(dataInfoBO.getId());
        dataExportBaseBO.setName(dataInfoBO.getName());
        dataExportBaseBO.setType(datasetType.name());
        dataExportBaseBO.setVersion(version);
        var images = new ArrayList<ExportDataImageFileBO>();
        var lidarPointClouds = new ArrayList<ExportDataLidarPointCloudFileBO>();
        var texts = new ArrayList<ExportDataTextFileBO>();
        var cameraConfigBO = new ExportDataCameraConfigFileBO();
        for (DataInfoBO.FileNodeBO f : dataInfoBO.getContent()) {
            var fileDTO = Constants.FILE.equals(f.getType()) ? f.getFile() : CollectionUtil.getFirst(f.getFiles()).getFile();
            if (f.getName().startsWith(Constants.LIDAR_POINT_CLOUD)) {
                var lidarPointCloudBO = new ExportDataLidarPointCloudFileBO();
                lidarPointCloudBO.setUrl(fileDTO.getUrl());
                lidarPointCloudBO.setInternalUrl(fileDTO.getInternalUrl());
                lidarPointCloudBO.setFilename(fileDTO.getOriginalName());
                lidarPointCloudBO.setZipPath(fileDTO.getZipPath());
                lidarPointCloudBO.setDeviceName(f.getName());
                lidarPointClouds.add(lidarPointCloudBO);
            } else if (f.getName().equals(Constants.CAMERA_CONFIG)) {
                cameraConfigBO.setUrl(fileDTO.getUrl());
                cameraConfigBO.setFilename(fileDTO.getOriginalName());
                cameraConfigBO.setZipPath(fileDTO.getZipPath());
                cameraConfigBO.setInternalUrl(fileDTO.getInternalUrl());
                cameraConfigBO.setDeviceName(f.getName());
            } else if (f.getName().contains(Constants.IMAGE)) {
                var url = fileDTO.getUrl();
                var zipPath = fileDTO.getZipPath();
                var lidarFusionImageBO = DefaultConverter.convert(fileDTO.getExtraInfo(), ExportDataImageFileBO.class);
                lidarFusionImageBO = ObjectUtil.isNull(lidarFusionImageBO) ? new ExportDataImageFileBO() : lidarFusionImageBO;
                lidarFusionImageBO.setFilename(fileDTO.getOriginalName());
                lidarFusionImageBO.setUrl(url);
                lidarFusionImageBO.setInternalUrl(fileDTO.getInternalUrl());
                lidarFusionImageBO.setZipPath(zipPath);
                lidarFusionImageBO.setDeviceName(f.getName().equals("image0") ? "image_0" : f.getName());
                images.add(lidarFusionImageBO);
            } else if (f.getName().startsWith(Constants.TEXT)) {
                var textFileBO = DefaultConverter.convert(fileDTO.getExtraInfo(), ExportDataTextFileBO.class);
                textFileBO.setUrl(fileDTO.getUrl());
                textFileBO.setInternalUrl(fileDTO.getInternalUrl());
                textFileBO.setFilename(fileDTO.getOriginalName());
                textFileBO.setZipPath(fileDTO.getZipPath());
                textFileBO.setDeviceName(f.getName());
                texts.add(textFileBO);
            }
        }
        switch (datasetType) {
            case LIDAR_FUSION:
                dataExportBaseBO = DefaultConverter.convert(dataExportBaseBO, LidarFusionDataExportBO.class);
                ((LidarFusionDataExportBO) dataExportBaseBO).setLidarPointClouds(lidarPointClouds);
                ((LidarFusionDataExportBO) dataExportBaseBO).setCameraConfig(cameraConfigBO);
                ((LidarFusionDataExportBO) dataExportBaseBO).setCameraImages(images);
                break;
            case LIDAR_BASIC:
                dataExportBaseBO = DefaultConverter.convert(dataExportBaseBO, LidarBasicDataExportBO.class);
                ((LidarBasicDataExportBO) dataExportBaseBO).setLidarPointClouds(lidarPointClouds);
                break;
            case IMAGE:
                dataExportBaseBO = DefaultConverter.convert(dataExportBaseBO, ImageDataExportBO.class);
                ((ImageDataExportBO) dataExportBaseBO).setImages(images);
                break;
            case TEXT:
                dataExportBaseBO = DefaultConverter.convert(dataExportBaseBO, TextDataExportBO.class);
                ((TextDataExportBO) dataExportBaseBO).setTexts(texts);
                break;
            default:
                break;
        }
        return dataExportBaseBO;
    }

    /**
     * Export data
     *
     * @param scenarioQueryBO Query parameters
     * @return Serial number
     */
    public Long scenarioExport(ScenarioQueryBO scenarioQueryBO) {
        var fileName = String.format("%s-%s.zip", "export", TemporalAccessorUtil.format(OffsetDateTime.now(), DatePattern.PURE_DATETIME_PATTERN));
        var serialNumber = exportUseCase.createExportRecord(fileName);
        scenarioQueryBO.setPageNo(PAGE_NO);
        scenarioQueryBO.setPageSize(PAGE_SIZE_100);
        var datasetClassBOList = datasetClassUseCase.findByIds(scenarioQueryBO.getDatasetId(), scenarioQueryBO.getClassIds());
        var classMap = new HashMap<Long, String>();
        if (CollectionUtil.isNotEmpty(datasetClassBOList)) {
            classMap.putAll(datasetClassBOList.stream().collect(Collectors.toMap(DatasetClassBO::getId, DatasetClassBO::getName)));
        }
        var resultMap = this.getResultMap(scenarioQueryBO.getDatasetId());
        executorService.execute(Objects.requireNonNull(TtlRunnable.get(() ->
                exportUseCase.asyncExportDataZip(fileName, serialNumber, classMap, resultMap, scenarioQueryBO,
                        dataAnnotationObjectUseCase::findDataIdByScenario,
                        this::processScenarioData))));
        return serialNumber;
    }


    public List<DataExportBO> processScenarioData(List<Long> dataIds, ScenarioQueryBO queryBO, Map<Long, String> classMap, Map<Long, String> resultMap) {
        if (CollectionUtil.isEmpty(dataIds)) {
            return List.of();
        }
        var dataInfoExportBOList = new ArrayList<DataExportBO>();
        queryBO.setDataIds(dataIds);
        var dataAnnotationObjectList = dataAnnotationObjectUseCase.listByScenario(queryBO);
        Map<Long, List<DataAnnotationObjectBO>> dataAnnotationObjectMap = CollectionUtil.isNotEmpty(dataAnnotationObjectList) ?
                dataAnnotationObjectList.stream().collect(Collectors.groupingBy(DataAnnotationObjectBO::getDataId))
                : Map.of();
        var dataList = listByIds(dataIds, false);
        dataList.forEach(dataInfoBO -> {
            var dataId = dataInfoBO.getId();
            var dataExportBaseBO = assembleExportDataContent(dataInfoBO, queryBO.getDatasetType());
            var objectList = dataAnnotationObjectMap.get(dataId);
            var dataResultExportBO = DataResultExportBO.builder().dataId(dataId).version(version).build();
            if (CollectionUtil.isNotEmpty(objectList)) {
                var objects = new ArrayList<DataResultObjectExportBO>();
                objectList.forEach(o -> {
                    var dataResultObjectExportBO = DefaultConverter.convert(o.getClassAttributes(), DataResultObjectExportBO.class);
                    dataResultObjectExportBO.setClassName(classMap.get(o.getClassId()));
                    objects.add(dataResultObjectExportBO);
                });
                dataResultExportBO.setObjects(objects);
            }
            var dataInfoExportBO = DataExportBO.builder().data(dataExportBaseBO).build();
            if (CollectionUtil.isNotEmpty(objectList)) {
                dataInfoExportBO.setResult(List.of(dataResultExportBO));
            }
            dataInfoExportBOList.add(dataInfoExportBO);
        });
        return dataInfoExportBOList;
    }

    public DataResultBO getDataAndResult(Long datasetId, List<Long> dataIds) {
        var dataset = datasetDAO.getById(datasetId);
        if (ObjectUtil.isNull(dataset)) {
            throw new UsecaseException(DATASET_NOT_FOUND);
        }
        var dataInfoQueryBO = DataInfoQueryBO.builder().datasetType(dataset.getType()).build();
        var datasetClassBOList = datasetClassUseCase.findAll(datasetId);
        var classMap = new HashMap<Long, String>();
        if (CollectionUtil.isNotEmpty(datasetClassBOList)) {
            classMap.putAll(datasetClassBOList.stream().collect(Collectors.toMap(DatasetClassBO::getId, DatasetClassBO::getName)));
        }

        var resultMap = this.getResultMap(datasetId);
        dataInfoQueryBO.setIsAllResult(true);
        var dataExportBOList = processData(dataIds, dataInfoQueryBO, classMap, resultMap);
        var exportTime = TemporalAccessorUtil.format(OffsetDateTime.now(), DatePattern.PURE_DATETIME_PATTERN);
        var data = new ArrayList<DataExportBaseBO>();
        var results = new ArrayList<DataResultExportBO>();
        dataExportBOList.forEach(dataExportBO -> {
            if (ObjectUtil.isNotNull(dataExportBO.getData())) {
                data.add(dataExportBO.getData());
            }
            if (CollUtil.isNotEmpty(dataExportBO.getResult())) {
                results.addAll(dataExportBO.getResult());
            }
        });
        return DataResultBO.builder().version(version).datasetId(dataset.getId())
                .datasetName(dataset.getName()).exportTime(exportTime).data(data).results(results).build();
    }

    private Map<Long, String> getResultMap(Long datasetId) {
        var resultMap = new HashMap<Long, String>();
        var modelRunRecordBOList = modelRunRecordUseCase.findByDatasetId(datasetId);
        if (CollUtil.isNotEmpty(modelRunRecordBOList)) {
            resultMap.putAll(modelRunRecordBOList.stream().collect(Collectors.toMap(ModelRunRecordBO::getId, ModelRunRecordBO::getRunNo)));
        }
        resultMap.put(GROUND_TRUTH, GROUND_TRUTH_NAME);
        return resultMap;
    }

    public void setDatasetSixData(List<DatasetBO> datasetBOList) {
        if (CollectionUtil.isEmpty(datasetBOList)) {
            return;
        }
        var datasetIds = new ArrayList<Long>();
        var datasetTypeMap = new HashMap<Long, DatasetTypeEnum>();
        datasetBOList.forEach(datasetBO -> {
            datasetIds.add(datasetBO.getId());
            datasetTypeMap.put(datasetBO.getId(), datasetBO.getType());
        });
        var datasetSixDataList = dataInfoDAO.getBaseMapper().selectSixDataIdByDatasetIds(datasetIds);
        var dataIds = new HashSet<Long>();
        datasetSixDataList.forEach(datasetSixData -> {
            var datasetType = datasetTypeMap.get(datasetSixData.getDatasetId());
            var ids = StrUtil.splitToLong(datasetSixData.getDataIds(), ",");
            if (null != ids && ids.length > 0) {
                if (IMAGE.equals(datasetType)) {
                    CollectionUtil.addAll(dataIds, ids);
                } else {
                    dataIds.add(ids[0]);
                }
            }
        });
        if (CollectionUtil.isNotEmpty(dataIds)) {
            var dataInfoBOList = listByIds(new ArrayList<>(dataIds), false);
            var dataMap = dataInfoBOList.stream().collect(Collectors.groupingBy(DataInfoBO::getDatasetId));
            datasetBOList.forEach(datasetBO -> datasetBO.setDatas(dataMap.get(datasetBO.getId())));
        }
    }

    public DataInfoBO getInitDataInfoBO(DatasetInitialInfo datasetInitialInfo) {
        var dataset = datasetUseCase.getInitDataset(datasetInitialInfo);
        if (ObjectUtil.isNull(dataset)) {
            throw new UsecaseException(DEFAULT_DATASET_NOT_FOUND);
        }
        var dataInfoLambdaQueryWrapper = Wrappers.lambdaQuery(DataInfo.class);
        dataInfoLambdaQueryWrapper.eq(DataInfo::getDatasetId, dataset.getId());
        dataInfoLambdaQueryWrapper.last("limit 1");
        var dataInfoBO = DefaultConverter.convert(dataInfoDAO.getOne(dataInfoLambdaQueryWrapper), DataInfoBO.class);
        setDataInfoBOListFile(List.of(dataInfoBO));
        return dataInfoBO;
    }


}
