package ai.basic.x1.adapter.port.rpc.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParkingSlotDetectionReqDTO {
    private List<FrameDTO> datas;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class FrameDTO {
        private Long id;
        private String stitchedImageUrl;
        private String pointCloudUrl;
    }
}
