package ai.basic.x1.entity;

import cn.hutool.json.JSONObject;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class GroundLabeledPcdExportFrame {

    private String zipEntry;

    private String pointCloudUrl;

    private JSONObject groundCorrectionMask;

    private List<JSONObject> groundCorrectionProtections;
}
