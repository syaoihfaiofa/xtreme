package ai.basic.x1.usecase;

import ai.basic.x1.adapter.dto.response.TrackTimelineItemDTO;
import ai.basic.x1.adapter.port.dao.DataAnnotationObjectDAO;
import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.mybatis.mapper.DataAnnotationObjectMapper;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataAnnotationObject;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.entity.DataAnnotationObjectBO;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import cn.hutool.json.JSONUtil;
import cn.hutool.json.JSONObject;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class DataAnnotationObjectUseCaseTest {

    @BeforeAll
    static void initializeMybatisMetadata() {
        MybatisConfiguration configuration = new MybatisConfiguration();
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(configuration, "DataAnnotationObjectMapper"),
                DataAnnotationObject.class);
    }

    @Mock
    private DataAnnotationObjectDAO dataAnnotationObjectDAO;

    @Mock
    private DataAnnotationObjectMapper dataAnnotationObjectMapper;

    @Mock
    private DataInfoDAO dataInfoDAO;

    @InjectMocks
    private DataAnnotationObjectUseCase useCase;

    @Test
    void test_find_track_data_ids_filters_by_persisted_track_id() {
        when(dataAnnotationObjectDAO.list(any())).thenReturn(List.of(
                DataAnnotationObject.builder()
                        .dataId(10L)
                        .trackId("track-1")
                        .classAttributes(JSONUtil.parseObj("{\"trackId\":\"track-1\"}"))
                        .build()));

        assertEquals(List.of(10L), useCase.findTrackDataIds(List.of(10L, 11L), "track-1"));

        ArgumentCaptor<LambdaQueryWrapper<DataAnnotationObject>> captor =
                ArgumentCaptor.forClass(LambdaQueryWrapper.class);
        verify(dataAnnotationObjectDAO).list(captor.capture());
        assertTrue(captor.getValue().getSqlSegment().contains("track_id"));
    }

    @Test
    void test_find_scene_track_timeline_objects_keeps_first_syncable_object_per_frame() {
        when(dataInfoDAO.getById(10L)).thenReturn(DataInfo.builder().id(10L).parentId(1L).build());
        when(dataAnnotationObjectDAO.getBaseMapper()).thenReturn(dataAnnotationObjectMapper);
        String box = "{\"trackId\":\"track-1\",\"type\":\"3D_BOX\","
                + "\"contour\":{\"center3D\":{},\"size3D\":{}}}";
        when(dataAnnotationObjectMapper.findTrackTimelineObjects(eq(1L), eq("track-1"), any())).thenReturn(List.of(
                trackObject(1L, 10L, box, DataAnnotationObjectSourceTypeEnum.SNAPSHOT),
                trackObject(2L, 10L, box, DataAnnotationObjectSourceTypeEnum.DATA_FLOW),
                trackObject(3L, 10L, box, DataAnnotationObjectSourceTypeEnum.DATA_FLOW),
                trackObject(4L, 11L, "{\"trackId\":\"track-1\",\"type\":\"RECT\"}",
                        DataAnnotationObjectSourceTypeEnum.DATA_FLOW),
                trackObject(5L, 12L, "{\"trackId\":\"track-1\",\"type\":\"GROUND_POLYGON\","
                        + "\"contour\":{\"points\":[]}}", null)));

        List<DataAnnotationObjectBO> result = useCase.findSceneTrackTimelineObjects(10L, "track-1");

        assertEquals(List.of(2L, 5L),
                result.stream().map(DataAnnotationObjectBO::getId).collect(Collectors.toList()));
    }

    @Test
    void test_track_timeline_item_reads_frontend_merge_order_and_omits_missing_fields() throws Exception {
        DataAnnotationObjectBO object = DataAnnotationObjectBO.builder()
                .dataId(10L)
                .classAttributes(JSONUtil.parseObj("{\"trackId\":\"track-1\",\"trackName\":\"root\","
                        + "\"motionMode\":\"STATIC\",\"meta\":{\"trackName\":\"meta\","
                        + "\"syncPoseSegmentId\":3},\"contour\":{\"syncLocationGapMs\":500,"
                        + "\"points\":[{\"x\":1}]}}"))
                .build();

        TrackTimelineItemDTO item = TrackTimelineItemDTO.from(object);
        String json = new ObjectMapper().writeValueAsString(item);

        assertEquals("meta", item.getTrackName());
        assertEquals("3", item.getSyncPoseSegmentId());
        assertEquals(500, item.getSyncLocationGapMs());
        assertFalse(json.contains("manualSyncSegmentId"));
        assertFalse(json.contains("points"));
    }

    @Test
    void normalizeMissingBoxType_setsThreeDBoxForBoxGeometry() {
        JSONObject attributes = new JSONObject().set("contour", new JSONObject()
                .set("center3D", new JSONObject())
                .set("size3D", new JSONObject()));

        DataAnnotationObjectUseCase.normalizeMissingBoxType(attributes);

        assertEquals("3D_BOX", attributes.getStr("type"));
    }

    private static DataAnnotationObject trackObject(
            Long id,
            Long dataId,
            String classAttributes,
            DataAnnotationObjectSourceTypeEnum sourceType) {
        return DataAnnotationObject.builder()
                .id(id)
                .dataId(dataId)
                .trackId("track-1")
                .sourceType(sourceType)
                .classAttributes(JSONUtil.parseObj(classAttributes))
                .build();
    }
}
