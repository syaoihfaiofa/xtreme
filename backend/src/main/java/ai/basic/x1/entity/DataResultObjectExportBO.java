package ai.basic.x1.entity;

import cn.hutool.json.JSONArray;
import cn.hutool.json.JSONObject;
import lombok.Data;

import java.math.BigDecimal;
import java.util.List;

@Data
public class DataResultObjectExportBO {

    /**
     * Object id
     */
    private String id;

    /**
     * Type
     */
    private String type;

    /**
     * Class id
     */
    private Long classId;

    /**
     * Class name
     */
    private String className;

    /**
     * Track id
     */
    private String trackId;

    /**
     * Track name
     */
    private String trackName;

    /**
     * Class values
     */
    private JSONArray classValues;

    /**
     * Profile information
     */
    private JSONObject contour;

    /**
     * Confidence of model recognition, only available for model recognition
     */
    private BigDecimal modelConfidence;

    /**
     * The category identified by the model is only available when the model is identified
     */
    private String modelClass;

    /**
     * Original image-view indexes returned with an image-keypoint-lifted model result.
     * These are retained for the source frame so its image overlay is not regenerated
     * from the lifted 3D contour.
     */
    private List<Integer> sourceViewIndexes;

    /** Original two-dimensional keypoints paired with {@link #sourceViewIndexes}. */
    private List<List<BigDecimal>> sourceKeypoints;

    /** Frame whose raw 2D/3D model pair was selected as this track's representative. */
    private Long sourceDataId;

}
