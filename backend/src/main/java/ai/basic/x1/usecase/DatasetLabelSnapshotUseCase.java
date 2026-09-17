package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.DatasetLabelSnapshotDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.DatasetLabelSnapshot;
import ai.basic.x1.entity.LabelSnapshotRestoreBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import ai.basic.x1.usecase.exception.UsecaseCode;
import ai.basic.x1.usecase.exception.UsecaseException;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.stream.Collectors;

@Component
public class DatasetLabelSnapshotUseCase {

    private static final long WITHOUT_TASK_SOURCE_ID = -1L;
    private static final DateTimeFormatter SNAPSHOT_NAME_FORMAT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd-HH:mm");

    @Autowired
    private DatasetLabelSnapshotDAO snapshotDAO;

    @Autowired
    private DataAnnotationObjectDAO annotationObjectDAO;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Transactional(rollbackFor = Exception.class)
    public Long backupCurrentLayer(Long datasetId, Long sceneId, Long userId) {
        List<Long> frameIds = findSceneFrameIds(datasetId, sceneId);
        if (frameIds.isEmpty()) {
            return null;
        }
        List<DataAnnotationObject> currentObjects = annotationObjectDAO.list(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .eq(DataAnnotationObject::getDatasetId, datasetId)
                        .in(DataAnnotationObject::getDataId, frameIds)
                        .eq(DataAnnotationObject::getSourceType,
                                DataAnnotationObjectSourceTypeEnum.DATA_FLOW));
        if (CollUtil.isEmpty(currentObjects)) {
            return null;
        }

        DatasetLabelSnapshot snapshot = DatasetLabelSnapshot.builder()
                .datasetId(datasetId)
                .sceneId(sceneId)
                .name("replace-" + SNAPSHOT_NAME_FORMAT.format(OffsetDateTime.now()))
                .createdBy(userId)
                .build();
        snapshotDAO.save(snapshot);

        List<DataAnnotationObject> copies = currentObjects.stream()
                .map(object -> copyObject(
                        object,
                        DataAnnotationObjectSourceTypeEnum.SNAPSHOT,
                        snapshot.getId(),
                        userId))
                .collect(Collectors.toList());
        annotationObjectDAO.saveBatch(copies);
        return snapshot.getId();
    }

    @Transactional(rollbackFor = Exception.class)
    public LabelSnapshotRestoreBO restore(Long datasetId, Long snapshotId, Long userId) {
        DatasetLabelSnapshot snapshot = getSnapshot(datasetId, snapshotId);
        Long newSnapshotId = backupCurrentLayer(datasetId, snapshot.getSceneId(), userId);
        List<Long> frameIds = findSceneFrameIds(datasetId, snapshot.getSceneId());

        List<DataAnnotationObject> snapshotObjects = frameIds.isEmpty()
                ? List.of()
                : annotationObjectDAO.list(
                        Wrappers.lambdaQuery(DataAnnotationObject.class)
                                .eq(DataAnnotationObject::getDatasetId, datasetId)
                                .in(DataAnnotationObject::getDataId, frameIds)
                                .eq(DataAnnotationObject::getSourceType,
                                        DataAnnotationObjectSourceTypeEnum.SNAPSHOT)
                                .eq(DataAnnotationObject::getSourceId, snapshotId));

        if (!frameIds.isEmpty()) {
            annotationObjectDAO.remove(
                    Wrappers.lambdaQuery(DataAnnotationObject.class)
                            .eq(DataAnnotationObject::getDatasetId, datasetId)
                            .in(DataAnnotationObject::getDataId, frameIds)
                            .eq(DataAnnotationObject::getSourceType,
                                    DataAnnotationObjectSourceTypeEnum.DATA_FLOW));
        }

        List<DataAnnotationObject> restoredObjects = snapshotObjects.stream()
                .map(object -> copyObject(
                        object,
                        DataAnnotationObjectSourceTypeEnum.DATA_FLOW,
                        WITHOUT_TASK_SOURCE_ID,
                        userId))
                .collect(Collectors.toList());
        if (!restoredObjects.isEmpty()) {
            annotationObjectDAO.saveBatch(restoredObjects);
        }
        return LabelSnapshotRestoreBO.builder()
                .newSnapshotId(newSnapshotId)
                .writtenObjectCount(restoredObjects.size())
                .build();
    }

    @Transactional(rollbackFor = Exception.class)
    public void delete(Long datasetId, Long snapshotId) {
        getSnapshot(datasetId, snapshotId);
        annotationObjectDAO.remove(
                Wrappers.lambdaQuery(DataAnnotationObject.class)
                        .eq(DataAnnotationObject::getDatasetId, datasetId)
                        .eq(DataAnnotationObject::getSourceType,
                                DataAnnotationObjectSourceTypeEnum.SNAPSHOT)
                        .eq(DataAnnotationObject::getSourceId, snapshotId));
        snapshotDAO.removeById(snapshotId);
    }

    private DatasetLabelSnapshot getSnapshot(Long datasetId, Long snapshotId) {
        DatasetLabelSnapshot snapshot = snapshotDAO.getById(snapshotId);
        if (snapshot == null || !datasetId.equals(snapshot.getDatasetId())) {
            throw new UsecaseException(
                    UsecaseCode.PARAM_ERROR,
                    "Label snapshot was not found in dataset: datasetId=" + datasetId
                            + ", snapshotId=" + snapshotId);
        }
        return snapshot;
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

    private DataAnnotationObject copyObject(
            DataAnnotationObject source,
            DataAnnotationObjectSourceTypeEnum sourceType,
            Long sourceId,
            Long userId) {
        JSONObject classAttributes = source.getClassAttributes() == null
                ? null
                : JSONUtil.parseObj(source.getClassAttributes().toString());
        if (classAttributes != null) {
            classAttributes.set("sourceType", sourceType.name());
            classAttributes.set("sourceId", sourceId);
        }
        return DataAnnotationObject.builder()
                .datasetId(source.getDatasetId())
                .dataId(source.getDataId())
                .classId(source.getClassId())
                .classAttributes(classAttributes)
                .sourceId(sourceId)
                .sourceType(sourceType)
                .createdBy(userId)
                .updatedBy(userId)
                .build();
    }
}
