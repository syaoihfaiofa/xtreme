package ai.basic.x1.adapter.port.dao.mybatis.model;

import cn.hutool.core.util.StrUtil;
import cn.hutool.json.JSONObject;

public final class DataAnnotationObjectTrackId {

    private DataAnnotationObjectTrackId() {
    }

    public static String fromClassAttributes(JSONObject classAttributes) {
        if (classAttributes == null) {
            return null;
        }
        String trackId = classAttributes.getStr("trackId");
        return StrUtil.isBlank(trackId) ? null : trackId;
    }
}
