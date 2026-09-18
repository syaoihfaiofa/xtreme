package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.entity.DatasetOverviewDetailBO;
import ai.basic.x1.entity.DatasetStatisticsBO;
import ai.basic.x1.entity.enums.ItemTypeEnum;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import cn.hutool.json.JSONObject;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.util.Assert;

import java.util.List;
import java.util.ArrayList;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * @author zhujh
 */
public class DatasetStatisticsUseCase {

    @Autowired
    private DataInfoUseCase dataInfoUsecase;

    @Autowired
    private DatasetClassUseCase datasetClassUseCase;

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    public DatasetStatisticsBO datasetOverview(Long datasetId) {
        Assert.notNull(datasetId, "datasetId is null");
        var datasetStatisticsMap = dataInfoUsecase.getDatasetStatisticsByDatasetIds(List.of(datasetId));
        return datasetStatisticsMap.getOrDefault(datasetId, DatasetStatisticsBO.createEmpty(datasetId));
    }

    /**
     * Returns scene and range information without assuming every annotation is a 3D box.
     * Only objects with contour.center3D are included in distance buckets.
     */
    public DatasetOverviewDetailBO overviewDetail(Long datasetId) {
        Assert.notNull(datasetId, "datasetId is null");
        var statistics = datasetOverview(datasetId);
        var scenes = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getDatasetId, datasetId)
                .eq(DataInfo::getType, ItemTypeEnum.SCENE)
                .eq(DataInfo::getIsDeleted, false));
        var frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getDatasetId, datasetId)
                .eq(DataInfo::getType, ItemTypeEnum.SINGLE_DATA)
                .eq(DataInfo::getIsDeleted, false));

        Map<Long, Long> framesByScene = frames.stream()
                .filter(frame -> frame.getParentId() != null)
                .collect(Collectors.groupingBy(DataInfo::getParentId, Collectors.counting()));
        var sceneUnits = new ArrayList<DatasetOverviewDetailBO.SceneUnit>();
        for (var scene : scenes) {
            int frameCount = framesByScene.getOrDefault(scene.getId(), 0L).intValue();
            sceneUnits.add(DatasetOverviewDetailBO.SceneUnit.builder()
                    .sceneId(scene.getId()).name(scene.getName()).frameCount(frameCount).build());
        }
        sceneUnits.sort((left, right) -> Integer.compare(right.getFrameCount(), left.getFrameCount()));

        // Detail the near field at 2 m intervals, then use 5 m intervals up to 50 m.
        // Objects beyond 50 m are intentionally omitted from this overview chart.
        int[] distanceEnds = {2, 4, 6, 8, 10, 12, 17, 22, 27, 32, 37, 42, 47, 50};
        int[] distanceCounts = new int[distanceEnds.length];
        int positionedObjectCount = 0;
        var objects = dataAnnotationObjectDAO.list(Wrappers.lambdaQuery(DataAnnotationObject.class)
                .eq(DataAnnotationObject::getDatasetId, datasetId));
        for (var object : objects) {
            Double distance = distanceFromSensor(object.getClassAttributes());
            if (distance == null) continue;
            for (int i = 0; i < distanceEnds.length; i++) {
                if (distance < distanceEnds[i]) {
                    distanceCounts[i]++;
                    positionedObjectCount++;
                    break;
                }
            }
        }
        var distanceUnits = new ArrayList<DatasetOverviewDetailBO.DistanceUnit>();
        int rangeStart = 0;
        for (int i = 0; i < distanceEnds.length; i++) {
            distanceUnits.add(DatasetOverviewDetailBO.DistanceUnit.builder()
                    .range(rangeStart + "–" + distanceEnds[i] + " m")
                    .objectCount(distanceCounts[i]).build());
            rangeStart = distanceEnds[i];
        }
        return DatasetOverviewDetailBO.builder()
                .sceneCount(scenes.size())
                .annotatedFrameCount(statistics.getAnnotatedCount())
                .totalFrameCount(statistics.getItemCount())
                .positionedObjectCount(positionedObjectCount)
                .distanceUnits(distanceUnits)
                .sceneUnits(sceneUnits)
                .build();
    }

    private Double distanceFromSensor(JSONObject attributes) {
        if (attributes == null) return null;
        var contour = attributes.getJSONObject("contour");
        if (contour == null) return null;
        var center = contour.getJSONObject("center3D");
        if (center == null) return null;
        Double x = center.getDouble("x");
        Double y = center.getDouble("y");
        if (x == null || y == null) return null;
        return Math.hypot(x, y);
    }

}
