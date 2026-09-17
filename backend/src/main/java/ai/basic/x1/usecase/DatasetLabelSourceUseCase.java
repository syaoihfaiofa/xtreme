package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.DatasetLabelSnapshotDAO;
import ai.basic.x1.adapter.port.dao.ModelDAO;
import ai.basic.x1.adapter.port.dao.ModelRunRecordDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.DatasetLabelSnapshot;
import ai.basic.x1.adapter.port.dao.mybatis.model.Model;
import ai.basic.x1.adapter.port.dao.mybatis.model.ModelRunRecord;
import ai.basic.x1.entity.DatasetLabelSourcesBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
public class DatasetLabelSourceUseCase {

    @Autowired
    private DataInfoDAO dataInfoDAO;
    @Autowired
    private DataAnnotationObjectDAO annotationObjectDAO;
    @Autowired
    private DatasetLabelSnapshotDAO snapshotDAO;
    @Autowired
    private ModelRunRecordDAO modelRunRecordDAO;
    @Autowired
    private ModelDAO modelDAO;

    @Transactional(readOnly = true)
    public DatasetLabelSourcesBO list(Long datasetId) {
        List<DataInfo> dataInfos = dataInfoDAO.list(
                Wrappers.lambdaQuery(DataInfo.class)
                        .select(DataInfo::getId, DataInfo::getParentId)
                        .eq(DataInfo::getDatasetId, datasetId)
                        .eq(DataInfo::getIsDeleted, false));
        Map<Long, Long> sceneByDataId = dataInfos.stream()
                .filter(data -> data.getParentId() != null)
                .collect(Collectors.toMap(DataInfo::getId, DataInfo::getParentId));
        List<DataAnnotationObject> objects = annotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .eq(DataAnnotationObject::getDatasetId, datasetId));

        List<DataAnnotationObject> currentObjects = objects.stream()
                .filter(object -> object.getSourceType()
                        == DataAnnotationObjectSourceTypeEnum.DATA_FLOW)
                .collect(Collectors.toList());
        Map<Long, Long> currentCounts = currentObjects.stream()
                .map(object -> sceneByDataId.get(object.getDataId()))
                .filter(sceneId -> sceneId != null)
                .collect(Collectors.groupingBy(
                        Function.identity(),
                        Collectors.counting()));
        List<DatasetLabelSourcesBO.SceneCount> sceneCounts = currentCounts.entrySet()
                .stream()
                .map(entry -> DatasetLabelSourcesBO.SceneCount.builder()
                        .sceneId(entry.getKey())
                        .objectCount(entry.getValue())
                        .build())
                .collect(Collectors.toList());

        Map<Long, Long> snapshotCounts = objects.stream()
                .filter(object -> object.getSourceType()
                        == DataAnnotationObjectSourceTypeEnum.SNAPSHOT)
                .collect(Collectors.groupingBy(
                        DataAnnotationObject::getSourceId,
                        Collectors.counting()));
        List<DatasetLabelSourcesBO.SnapshotSource> snapshots = snapshotDAO.list(
                        Wrappers.lambdaQuery(DatasetLabelSnapshot.class)
                                .eq(DatasetLabelSnapshot::getDatasetId, datasetId)
                                .orderByDesc(DatasetLabelSnapshot::getCreatedAt))
                .stream()
                .map(snapshot -> DatasetLabelSourcesBO.SnapshotSource.builder()
                        .id(snapshot.getId())
                        .sceneId(snapshot.getSceneId())
                        .name(snapshot.getName())
                        .objectCount(snapshotCounts.getOrDefault(snapshot.getId(), 0L))
                        .createdAt(snapshot.getCreatedAt())
                        .build())
                .collect(Collectors.toList());

        Map<Long, Long> modelRunCounts = objects.stream()
                .filter(object -> object.getSourceType()
                        == DataAnnotationObjectSourceTypeEnum.MODEL)
                .collect(Collectors.groupingBy(
                        DataAnnotationObject::getSourceId,
                        Collectors.counting()));
        List<Long> runIds = new ArrayList<>(modelRunCounts.keySet());
        List<ModelRunRecord> runs = runIds.isEmpty()
                ? List.of()
                : modelRunRecordDAO.listByIds(runIds);
        List<Long> modelIds = runs.stream()
                .map(ModelRunRecord::getModelId)
                .distinct()
                .collect(Collectors.toList());
        Map<Long, Model> models = modelIds.isEmpty()
                ? Map.of()
                : modelDAO.listByIds(modelIds).stream()
                        .collect(Collectors.toMap(Model::getId, model -> model));
        List<DatasetLabelSourcesBO.ModelRunSource> modelRuns = runs.stream()
                .filter(run -> datasetId.equals(run.getDatasetId()))
                .map(run -> DatasetLabelSourcesBO.ModelRunSource.builder()
                        .recordId(run.getId())
                        .modelName(models.containsKey(run.getModelId())
                                ? models.get(run.getModelId()).getName()
                                : "")
                        .status(run.getStatus())
                        .objectCount(modelRunCounts.getOrDefault(run.getId(), 0L))
                        .createdAt(run.getCreatedAt())
                        .build())
                .collect(Collectors.toList());

        return DatasetLabelSourcesBO.builder()
                .current(DatasetLabelSourcesBO.CurrentSource.builder()
                        .objectCount(currentObjects.size())
                        .sceneCounts(sceneCounts)
                        .build())
                .snapshots(snapshots)
                .modelRuns(modelRuns)
                .build();
    }

    @Transactional(readOnly = true)
    public List<DatasetLabelSourcesBO.SnapshotSource> listSnapshotsForData(Long dataId) {
        List<Long> snapshotIds = annotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .select(DataAnnotationObject::getSourceId)
                                .eq(DataAnnotationObject::getDataId, dataId)
                                .eq(DataAnnotationObject::getSourceType,
                                        DataAnnotationObjectSourceTypeEnum.SNAPSHOT))
                .stream()
                .map(DataAnnotationObject::getSourceId)
                .distinct()
                .collect(Collectors.toList());
        if (snapshotIds.isEmpty()) {
            return List.of();
        }
        Map<Long, Long> counts = annotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .eq(DataAnnotationObject::getDataId, dataId)
                                .eq(DataAnnotationObject::getSourceType,
                                        DataAnnotationObjectSourceTypeEnum.SNAPSHOT)
                                .in(DataAnnotationObject::getSourceId, snapshotIds))
                .stream()
                .collect(Collectors.groupingBy(
                        DataAnnotationObject::getSourceId,
                        Collectors.counting()));
        return snapshotDAO.listByIds(snapshotIds).stream()
                .map(snapshot -> DatasetLabelSourcesBO.SnapshotSource.builder()
                        .id(snapshot.getId())
                        .sceneId(snapshot.getSceneId())
                        .name(snapshot.getName())
                        .objectCount(counts.getOrDefault(snapshot.getId(), 0L))
                        .createdAt(snapshot.getCreatedAt())
                        .build())
                .collect(Collectors.toList());
    }
}
