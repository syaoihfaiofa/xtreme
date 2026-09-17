package ai.basic.x1.adapter.dto.response;

import ai.basic.x1.entity.enums.ModelCodeEnum;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.OffsetDateTime;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CompletedSceneModelRunDTO {

    private Long recordId;

    private Long modelId;

    private String modelName;

    private ModelCodeEnum modelCode;

    private OffsetDateTime createdAt;

    private long frameCount;

    private long objectCount;
}
