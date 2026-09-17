package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.ModelDAO;
import ai.basic.x1.adapter.port.dao.ModelRunRecordDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.Model;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelRunRecord;
import ai.basic.x1.entity.CompletedSceneModelRunBO;
import ai.basic.x1.entity.MergeModelRunsToGtBO;
import ai.basic.x1.entity.MergeModelRunsToGtResultBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import ai.basic.x1.entity.enums.ModelRunMergeModeEnum;
import ai.basic.x1.entity.enums.RunStatusEnum;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

@Service
public class ModelRunGroundTruthMergeUseCase {

    private static final long WITHOUT_TASK_SOURCE_ID = -1L;
    private static final double MIN_CONFIDENCE = 0.5;
    private static final double DUPLICATE_IOU_THRESHOLD = 0.3;

    @Autowired
    private ModelRunRecordDAO modelRunRecordDAO;

    @Autowired
    private ModelDAO modelDAO;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private DataAnnotationObjectDAO annotationObjectDAO;

    @Autowired
    private DatasetLabelSnapshotUseCase snapshotUseCase;

    @Transactional(rollbackFor = Exception.class)
    public MergeModelRunsToGtResultBO merge(
            MergeModelRunsToGtBO request,
            Long userId) {
        validateRequest(request);
        List<Long> frameIds = findSceneFrameIds(
                request.getDatasetId(),
                request.getSceneId());
        List<Long> runIds = new ArrayList<>(
                new LinkedHashSet<>(request.getModelRunRecordIds()));
        validateRuns(request.getDatasetId(), request.getSceneId(), runIds);

        List<DataAnnotationObject> modelObjects = loadModelObjects(
                request.getDatasetId(),
                frameIds,
                runIds);
        Map<Long, List<DataAnnotationObject>> objectsByRun = modelObjects.stream()
                .collect(Collectors.groupingBy(DataAnnotationObject::getSourceId));
        for (Long runId : runIds) {
            if (CollUtil.isEmpty(objectsByRun.get(runId))) {
                throw new UsecaseException(
                        UsecaseCode.PARAM_ERROR,
                        "Model Run has no result in scene: datasetId="
                                + request.getDatasetId()
                                + ", sceneId=" + request.getSceneId()
                                + ", modelRunRecordId=" + runId);
            }
        }

        List<DataAnnotationObject> candidates = orderAndFilterCandidates(
                request,
                runIds,
                objectsByRun);
        if (candidates.isEmpty()) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Selected Model Runs have no result at confidence threshold: datasetId="
                            + request.getDatasetId()
                            + ", sceneId=" + request.getSceneId()
                            + ", modelRunRecordIds=" + runIds);
        }

        Long snapshotId = null;
        List<DataAnnotationObject> protectedObjects = List.of();
        if (request.getMode() == ModelRunMergeModeEnum.REPLACE) {
            snapshotId = snapshotUseCase.backupCurrentLayer(
                    request.getDatasetId(),
                    request.getSceneId(),
                    userId);
            removeCurrentLayer(request.getDatasetId(), frameIds);
        } else {
            protectedObjects = loadCurrentLayer(request.getDatasetId(), frameIds);
        }

        List<DataAnnotationObject> accepted = acceptCandidates(
                candidates,
                protectedObjects,
                userId);
        if (!accepted.isEmpty()) {
            annotationObjectDAO.saveBatch(accepted);
        }
        removeSelectedModelPredictions(
                request.getDatasetId(),
                frameIds,
                runIds);
        Set<Long> writtenFrameIds = accepted.stream()
                .map(DataAnnotationObject::getDataId)
                .collect(Collectors.toSet());
        List<Long> skippedFrames = frameIds.stream()
                .filter(frameId -> !writtenFrameIds.contains(frameId))
                .collect(Collectors.toList());
        return MergeModelRunsToGtResultBO.builder()
                .writtenObjectCount(accepted.size())
                .frameCount(frameIds.size())
                .skippedFrames(skippedFrames)
                .snapshotId(snapshotId)
                .build();
    }

    @Transactional(readOnly = true)
    public List<CompletedSceneModelRunBO> listCompletedRuns(Long sceneId) {
        DataInfo scene = dataInfoDAO.getById(sceneId);
        if (scene == null
                || scene.getType() != ItemTypeEnum.SCENE
                || Boolean.TRUE.equals(scene.getIsDeleted())) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Scene was not found: sceneId=" + sceneId);
        }
        List<Long> frameIds = findSceneFrameIds(scene.getDatasetId(), sceneId);
        if (frameIds.isEmpty()) {
            return List.of();
        }
        List<DataAnnotationObject> modelObjects = annotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .eq(DataAnnotationObject::getDatasetId, scene.getDatasetId())
                        .in(DataAnnotationObject::getDataId, frameIds)
                        .eq(DataAnnotationObject::getSourceType,
                                DataAnnotationObjectSourceTypeEnum.MODEL));
        List<Long> runIds = modelObjects.stream()
                .map(DataAnnotationObject::getSourceId)
                .filter(id -> id != null)
                .distinct()
                .collect(Collectors.toList());
        if (runIds.isEmpty()) {
            return List.of();
        }
        Map<Long, List<DataAnnotationObject>> objectsByRun = modelObjects.stream()
                .collect(Collectors.groupingBy(DataAnnotationObject::getSourceId));
        List<ModelRunRecord> completedRuns = modelRunRecordDAO.listByIds(runIds)
                .stream()
                .filter(run -> scene.getDatasetId().equals(run.getDatasetId()))
                .filter(run -> !Boolean.TRUE.equals(run.getIsDeleted()))
                .filter(run -> isCompleted(run.getStatus()))
                .collect(Collectors.toList());
        List<Long> modelIds = completedRuns.stream()
                .map(ModelRunRecord::getModelId)
                .distinct()
                .collect(Collectors.toList());
        Map<Long, Model> modelById = modelIds.isEmpty()
                ? Map.of()
                : modelDAO.listByIds(modelIds).stream()
                        .collect(Collectors.toMap(Model::getId, model -> model));

        List<CompletedSceneModelRunBO> result = new ArrayList<>();
        for (ModelRunRecord run : completedRuns) {
            Model model = modelById.get(run.getModelId());
            List<DataAnnotationObject> runObjects = objectsByRun.get(run.getId());
            long frameCount = runObjects.stream()
                    .map(DataAnnotationObject::getDataId)
                    .distinct()
                    .count();
            result.add(CompletedSceneModelRunBO.builder()
                    .recordId(run.getId())
                    .modelId(run.getModelId())
                    .modelName(model == null ? "" : model.getName())
                    .modelCode(model == null ? null : model.getModelCode())
                    .createdAt(run.getCreatedAt())
                    .frameCount(frameCount)
                    .objectCount(runObjects.size())
                    .build());
        }
        return result;
    }

    private void validateRequest(MergeModelRunsToGtBO request) {
        if (request == null
                || request.getDatasetId() == null
                || request.getSceneId() == null
                || request.getMode() == null) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Merge request requires datasetId, sceneId, and mode");
        }
        if (CollUtil.isEmpty(request.getModelRunRecordIds())) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "At least one Model Run is required: datasetId="
                            + request.getDatasetId()
                            + ", sceneId=" + request.getSceneId());
        }
    }

    private List<Long> findSceneFrameIds(Long datasetId, Long sceneId) {
        DataInfo scene = dataInfoDAO.getById(sceneId);
        if (scene == null
                || !datasetId.equals(scene.getDatasetId())
                || scene.getType() != ItemTypeEnum.SCENE
                || Boolean.TRUE.equals(scene.getIsDeleted())) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Scene was not found in dataset: datasetId=" + datasetId
                            + ", sceneId=" + sceneId);
        }
        return dataInfoDAO.list(
                        Wrappers.lambdaQuery(DataInfo.class)
                                .select(DataInfo::getId)
                                .eq(DataInfo::getDatasetId, datasetId)
                                .eq(DataInfo::getParentId, sceneId)
                                .eq(DataInfo::getIsDeleted, false))
                .stream()
                .map(DataInfo::getId)
                .collect(Collectors.toList());
    }

    private void validateRuns(Long datasetId, Long sceneId, List<Long> runIds) {
        Map<Long, ModelRunRecord> runById = modelRunRecordDAO.listByIds(runIds)
                .stream()
                .collect(Collectors.toMap(ModelRunRecord::getId, run -> run));
        for (Long runId : runIds) {
            ModelRunRecord run = runById.get(runId);
            if (run == null
                    || !datasetId.equals(run.getDatasetId())
                    || Boolean.TRUE.equals(run.getIsDeleted())
                    || !isCompleted(run.getStatus())) {
                throw new UsecaseException(
                        UsecaseCode.PARAM_ERROR,
                        "Model Run is not completed in dataset: datasetId=" + datasetId
                                + ", sceneId=" + sceneId
                                + ", modelRunRecordId=" + runId);
            }
        }
    }

    private boolean isCompleted(RunStatusEnum status) {
        return status == RunStatusEnum.SUCCESS
                || status == RunStatusEnum.SUCCESS_WITH_ERROR;
    }

    private List<DataAnnotationObject> loadModelObjects(
            Long datasetId,
            List<Long> frameIds,
            List<Long> runIds) {
        if (frameIds.isEmpty()) {
            return List.of();
        }
        return annotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .eq(DataAnnotationObject::getDatasetId, datasetId)
                        .in(DataAnnotationObject::getDataId, frameIds)
                        .eq(DataAnnotationObject::getSourceType,
                                DataAnnotationObjectSourceTypeEnum.MODEL)
                        .in(DataAnnotationObject::getSourceId, runIds));
    }

    private List<DataAnnotationObject> orderAndFilterCandidates(
            MergeModelRunsToGtBO request,
            List<Long> runIds,
            Map<Long, List<DataAnnotationObject>> objectsByRun) {
        List<DataAnnotationObject> candidates = new ArrayList<>();
        for (Long runId : runIds) {
            for (DataAnnotationObject object : objectsByRun.get(runId)) {
                if (object.getClassId() == null || object.getClassAttributes() == null) {
                    throw new UsecaseException(
                            UsecaseCode.PARAM_ERROR,
                            "Model Run object is missing class or geometry: datasetId="
                                    + request.getDatasetId()
                                    + ", sceneId=" + request.getSceneId()
                                    + ", modelRunRecordId=" + runId
                                    + ", objectId=" + object.getId());
                }
                Double confidence = object.getClassAttributes().getDouble("confidence");
                if (confidence == null || confidence >= MIN_CONFIDENCE) {
                    candidates.add(object);
                }
            }
        }
        return candidates;
    }

    private List<DataAnnotationObject> loadCurrentLayer(
            Long datasetId,
            List<Long> frameIds) {
        if (frameIds.isEmpty()) {
            return List.of();
        }
        return annotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .eq(DataAnnotationObject::getDatasetId, datasetId)
                        .in(DataAnnotationObject::getDataId, frameIds)
                        .eq(DataAnnotationObject::getSourceType,
                                DataAnnotationObjectSourceTypeEnum.DATA_FLOW));
    }

    private void removeCurrentLayer(Long datasetId, List<Long> frameIds) {
        if (frameIds.isEmpty()) {
            return;
        }
        annotationObjectDAO.remove(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .eq(DataAnnotationObject::getDatasetId, datasetId)
                        .in(DataAnnotationObject::getDataId, frameIds)
                        .eq(DataAnnotationObject::getSourceType,
                                DataAnnotationObjectSourceTypeEnum.DATA_FLOW));
    }

    private void removeSelectedModelPredictions(
            Long datasetId,
            List<Long> frameIds,
            List<Long> runIds) {
        if (frameIds.isEmpty() || runIds.isEmpty()) {
            return;
        }
        annotationObjectDAO.remove(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .eq(DataAnnotationObject::getDatasetId, datasetId)
                        .in(DataAnnotationObject::getDataId, frameIds)
                        .eq(DataAnnotationObject::getSourceType,
                                DataAnnotationObjectSourceTypeEnum.MODEL)
                        .in(DataAnnotationObject::getSourceId, runIds));
    }

    private List<DataAnnotationObject> acceptCandidates(
            List<DataAnnotationObject> candidates,
            List<DataAnnotationObject> protectedObjects,
            Long userId) {
        Map<Long, List<DataAnnotationObject>> acceptedByFrame = new HashMap<>();
        for (DataAnnotationObject object : protectedObjects) {
            acceptedByFrame.computeIfAbsent(
                    object.getDataId(),
                    ignored -> new ArrayList<>()).add(object);
        }

        List<DataAnnotationObject> result = new ArrayList<>();
        for (DataAnnotationObject candidate : candidates) {
            List<DataAnnotationObject> frameObjects = acceptedByFrame.computeIfAbsent(
                    candidate.getDataId(),
                    ignored -> new ArrayList<>());
            if (isDuplicateCuboid(candidate, frameObjects)) {
                continue;
            }
            DataAnnotationObject copy = copyAsGroundTruth(candidate, userId);
            result.add(copy);
            frameObjects.add(copy);
        }
        return result;
    }

    private boolean isDuplicateCuboid(
            DataAnnotationObject candidate,
            Collection<DataAnnotationObject> accepted) {
        SceneInferenceFinalizer.Box candidateBox =
                SceneInferenceFinalizer.boxFromAttributes(candidate.getClassAttributes());
        if (candidateBox == null) {
            return false;
        }
        for (DataAnnotationObject object : accepted) {
            if (!candidate.getClassId().equals(object.getClassId())) {
                continue;
            }
            SceneInferenceFinalizer.Box acceptedBox =
                    SceneInferenceFinalizer.boxFromAttributes(object.getClassAttributes());
            if (acceptedBox != null
                    && SceneInferenceFinalizer.bevIou(candidateBox, acceptedBox)
                    >= DUPLICATE_IOU_THRESHOLD) {
                return true;
            }
        }
        return false;
    }

    private DataAnnotationObject copyAsGroundTruth(
            DataAnnotationObject source,
            Long userId) {
        JSONObject classAttributes = JSONUtil.parseObj(
                source.getClassAttributes().toString());
        classAttributes.set("sourceType", DataAnnotationObjectSourceTypeEnum.DATA_FLOW.name());
        classAttributes.set("sourceId", WITHOUT_TASK_SOURCE_ID);
        return DataAnnotationObject.builder()
                .datasetId(source.getDatasetId())
                .dataId(source.getDataId())
                .classId(source.getClassId())
                .classAttributes(classAttributes)
                .sourceType(DataAnnotationObjectSourceTypeEnum.DATA_FLOW)
                .sourceId(WITHOUT_TASK_SOURCE_ID)
                .createdBy(userId)
                .updatedBy(userId)
                .build();
    }
}
