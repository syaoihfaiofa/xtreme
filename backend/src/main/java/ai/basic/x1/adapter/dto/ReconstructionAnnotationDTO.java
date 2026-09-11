package ai.basic.x1.adapter.dto;

import cn.hutool.json.JSONObject;
import lombok.Data;

import javax.validation.constraints.NotNull;

@Data
public class ReconstructionAnnotationDTO {
    private Long id;
    @NotNull(message = "classId cannot be null")
    private Long classId;
    @NotNull(message = "geometry cannot be null")
    private JSONObject geometry;
    private JSONObject classAttributes;
}
