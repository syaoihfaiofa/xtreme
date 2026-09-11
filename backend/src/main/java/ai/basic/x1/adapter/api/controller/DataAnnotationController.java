package ai.basic.x1.adapter.api.controller;

import ai.basic.x1.adapter.dto.DataAnnotationClassificationDTO;
import ai.basic.x1.adapter.dto.DataAnnotationObjectDTO;
import ai.basic.x1.adapter.dto.request.ObjectResultDTO;
import ai.basic.x1.adapter.dto.response.DataAnnotationObjectResponseDTO;
import ai.basic.x1.adapter.dto.response.DataAnnotationResultDTO;
import ai.basic.x1.entity.DataAnnotationClassificationBO;
import ai.basic.x1.entity.DataAnnotationObjectBO;
import ai.basic.x1.usecase.DataAnnotationUseCase;
import ai.basic.x1.usecase.DataAnnotationObjectUseCase;
import ai.basic.x1.usecase.TrackSyncUseCase;
import ai.basic.x1.util.DefaultConverter;
import cn.hutool.core.collection.CollUtil;
import cn.hutool.core.util.ObjectUtil;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import javax.validation.groups.Default;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * @author chenchao
 * @date 2022/8/26
 */
@RestController
@RequestMapping("/annotate/data/")
public class DataAnnotationController {

    @Autowired
    DataAnnotationUseCase dataAnnotationUseCase;

    @Autowired
    DataAnnotationObjectUseCase dataAnnotationObjectUseCase;

    @Autowired
    private TrackSyncUseCase trackSyncUseCase;

    @PostMapping("save")
    public List<DataAnnotationObjectResponseDTO> save(@Validated @RequestBody ObjectResultDTO objectResultDTO) {
        List<DataAnnotationClassificationDTO> dataAnnotationClassificationDTOS = convertToDataAnnotation(objectResultDTO);
        List<DataAnnotationObjectDTO> dataAnnotationObjectDTOs = convertToDataAnnotationObject(objectResultDTO);
        var deleteDataIds = objectResultDTO.getDataInfos()
                .stream()
                .filter(dataInfo -> CollUtil.isEmpty(dataInfo.getObjects()))
                .map(ObjectResultDTO.DataInfo::getDataId).collect(Collectors.toSet());
        List<DataAnnotationClassificationBO> dataAnnotationClassificationBOs = DefaultConverter.convert(dataAnnotationClassificationDTOS, DataAnnotationClassificationBO.class);
        List<DataAnnotationObjectBO> dataAnnotationObjectBOs = DefaultConverter.convert(dataAnnotationObjectDTOs, DataAnnotationObjectBO.class);
        List<DataAnnotationObjectBO> result = dataAnnotationUseCase.saveDataAnnotation(dataAnnotationClassificationBOs, dataAnnotationObjectBOs, deleteDataIds);
        return DefaultConverter.convert(result, DataAnnotationObjectResponseDTO.class);
    }

    /** Object-level persistence for track sync; unlike /save it never deletes omitted labels. */
    @PostMapping("sync/save")
    public List<DataAnnotationObjectResponseDTO> saveSyncObjects(
            @Validated @RequestBody ObjectResultDTO objectResultDTO) {
        List<DataAnnotationObjectDTO> objectDTOs = convertToDataAnnotationObject(objectResultDTO);
        List<DataAnnotationObjectBO> result = dataAnnotationUseCase.savePartialDataAnnotation(
                DefaultConverter.convert(objectDTOs, DataAnnotationObjectBO.class));
        return DefaultConverter.convert(result, DataAnnotationObjectResponseDTO.class);
    }

    @PostMapping("save/delta")
    public List<DataAnnotationObjectResponseDTO> saveDelta(
            @Validated @RequestBody ObjectResultDTO objectResultDTO) {
        List<DataAnnotationClassificationDTO> classificationDTOs =
                convertToDataAnnotation(objectResultDTO);
        List<DataAnnotationObjectDTO> objectDTOs =
                convertToDataAnnotationObject(objectResultDTO);
        Map<Long, Set<Long>> deletedObjectIdsByDataId = new HashMap<>();
        objectResultDTO.getDataInfos().forEach(dataInfo -> {
            if (CollUtil.isNotEmpty(dataInfo.getDeletedObjectIds())) {
                deletedObjectIdsByDataId.put(
                        dataInfo.getDataId(),
                        new HashSet<>(dataInfo.getDeletedObjectIds()));
            }
        });
        List<DataAnnotationObjectBO> result = dataAnnotationUseCase.saveDeltaDataAnnotation(
                objectResultDTO.getDatasetId(),
                DefaultConverter.convert(
                        classificationDTOs,
                        DataAnnotationClassificationBO.class),
                DefaultConverter.convert(objectDTOs, DataAnnotationObjectBO.class),
                deletedObjectIdsByDataId);
        return DefaultConverter.convert(result, DataAnnotationObjectResponseDTO.class);
    }

    @GetMapping("listByDataIds")
    public List<DataAnnotationResultDTO> listByDataIds(@RequestParam List<Long> dataIds) {
        return DefaultConverter.convert(dataAnnotationUseCase.findByDataIds(dataIds), DataAnnotationResultDTO.class);
    }

    @GetMapping("trackFrameIds")
    public List<Long> trackFrameIds(@RequestParam List<Long> dataIds, @RequestParam String trackId) {
        return dataAnnotationUseCase.findTrackDataIds(dataIds, trackId);
    }

    @GetMapping("sync/trackObjects")
    public List<DataAnnotationResultDTO> syncTrackObjects(
            @RequestParam List<Long> dataIds,
            @RequestParam String trackId) {
        var objectsByDataId = dataAnnotationObjectUseCase.findSyncableTrackObjects(dataIds, trackId)
                .stream()
                .collect(Collectors.groupingBy(DataAnnotationObjectBO::getDataId));
        return dataIds.stream()
                .map(dataId -> DataAnnotationResultDTO.builder()
                        .dataId(dataId)
                        .classificationValues(List.of())
                        .objects(DefaultConverter.convert(
                                objectsByDataId.getOrDefault(dataId, List.of()),
                                DataAnnotationObjectDTO.class))
                        .build())
                .collect(Collectors.toList());
    }

    @PostMapping("sync")
    public TrackSyncUseCase.SyncResult sync(@RequestParam Long dataId, @RequestParam String trackId,
                                            @RequestParam(required = false) Long classId) {
        return trackSyncUseCase.syncByDataIdAndTrackId(dataId, trackId, classId);
    }

    @PostMapping("track/delete")
    public List<Long> deleteTrack(@RequestParam Long dataId, @RequestParam String trackId) {
        return trackSyncUseCase.deleteByDataIdAndTrackId(dataId, trackId);
    }

    @PostMapping("track/split")
    public TrackSyncUseCase.TrackSplitResult splitTrack(
            @RequestBody TrackSyncUseCase.TrackSplitRequest request) {
        return trackSyncUseCase.splitTrack(request);
    }

    @GetMapping("sync/segments")
    public Map<Long, Integer> syncSegments(@RequestParam Long dataId, @RequestParam String trackId) {
        return trackSyncUseCase.findPoseSegments(dataId, trackId);
    }

    @PostMapping("review")
    public void review(@RequestParam Long dataId, @RequestParam String trackId,
                       @RequestParam boolean reviewedCorrect) {
        trackSyncUseCase.setReviewedCorrectByDataIdAndTrackId(dataId, trackId, reviewedCorrect);
    }

    private List<DataAnnotationClassificationDTO> convertToDataAnnotation(ObjectResultDTO objectResultDTO) {
        List<DataAnnotationClassificationDTO> dataAnnotationClassificationDTOS = new ArrayList<>();
        for (ObjectResultDTO.DataInfo dataInfo : objectResultDTO.getDataInfos()) {
            if (ObjectUtil.isNotEmpty(dataInfo.getDataAnnotations())) {
                dataInfo.getDataAnnotations().forEach(item -> {
                    DataAnnotationClassificationDTO dataAnnotationClassificationDTO = DataAnnotationClassificationDTO.builder()
                            .id(item.getId())
                            .datasetId(objectResultDTO.getDatasetId())
                            .dataId(dataInfo.getDataId())
                            .classificationId(item.getClassificationId())
                            .classificationAttributes(item.getClassificationAttributes())
                            .build();
                    dataAnnotationClassificationDTOS.add(dataAnnotationClassificationDTO);
                });
            }
        }
        return dataAnnotationClassificationDTOS;
    }

    private List<DataAnnotationObjectDTO> convertToDataAnnotationObject(ObjectResultDTO objectResultDTO) {
        List<DataAnnotationObjectDTO> dataAnnotationObjectDTOs = new ArrayList<>();
        for (ObjectResultDTO.DataInfo dataInfo : objectResultDTO.getDataInfos()) {
            if (ObjectUtil.isNotNull(dataInfo.getObjects())) {
                dataInfo.getObjects().forEach(item -> {
                    DataAnnotationObjectDTO dataAnnotationDTO = DefaultConverter.convert(item, DataAnnotationObjectDTO.class);
                    dataAnnotationDTO.setDatasetId(objectResultDTO.getDatasetId());
                    dataAnnotationDTO.setDataId(dataInfo.getDataId());
                    dataAnnotationObjectDTOs.add(dataAnnotationDTO);
                });
            }
        }
        return dataAnnotationObjectDTOs;
    }
}
