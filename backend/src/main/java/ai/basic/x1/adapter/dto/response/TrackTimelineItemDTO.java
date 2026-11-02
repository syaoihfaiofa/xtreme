package ai.basic.x1.adapter.dto.response;

import ai.basic.x1.entity.DataAnnotationObjectBO;
import cn.hutool.json.JSONObject;
import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.function.BiFunction;

/**
 * Timeline metadata of one tracked frame. Geometry is intentionally excluded.
 * Null fields are omitted because the timeline distinguishes missing values via undefined.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class TrackTimelineItemDTO {

    private Long dataId;

    private String trackId;

    private String trackName;

    private String motionMode;

    private String syncPoseSegmentId;

    private Integer syncLocationGapMs;

    private Boolean showSyncLocationBoundaries;

    private String manualSyncSegmentId;

    private String manualSyncSegmentBoundaryDataId;

    public static TrackTimelineItemDTO from(DataAnnotationObjectBO object) {
        JSONObject attributes = object.getClassAttributes();
        return TrackTimelineItemDTO.builder()
                .dataId(object.getDataId())
                .trackId(read(attributes, "trackId", JSONObject::getStr))
                .trackName(read(attributes, "trackName", JSONObject::getStr))
                .motionMode(read(attributes, "motionMode", JSONObject::getStr))
                .syncPoseSegmentId(read(attributes, "syncPoseSegmentId", JSONObject::getStr))
                .syncLocationGapMs(read(attributes, "syncLocationGapMs", JSONObject::getInt))
                .showSyncLocationBoundaries(
                        read(attributes, "showSyncLocationBoundaries", JSONObject::getBool))
                .manualSyncSegmentId(read(attributes, "manualSyncSegmentId", JSONObject::getStr))
                .manualSyncSegmentBoundaryDataId(
                        read(attributes, "manualSyncSegmentBoundaryDataId", JSONObject::getStr))
                .build();
    }

    /** Mirrors the frontend merge order: root attributes, then meta, then contour. */
    private static <T> T read(
            JSONObject attributes,
            String key,
            BiFunction<JSONObject, String, T> reader) {
        for (String container : new String[]{"contour", "meta"}) {
            JSONObject nested = attributes.getJSONObject(container);
            if (nested != null && nested.containsKey(key)) {
                return reader.apply(nested, key);
            }
        }
        return reader.apply(attributes, key);
    }
}
