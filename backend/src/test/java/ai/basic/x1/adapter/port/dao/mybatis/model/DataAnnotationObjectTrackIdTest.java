package ai.basic.x1.adapter.port.dao.mybatis.model;

import cn.hutool.json.JSONObject;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DataAnnotationObjectTrackIdTest {

    @Test
    void fromClassAttributes_returnsTrackIdWhenPresent() {
        JSONObject attributes = new JSONObject().set("trackId", "track-123");

        assertEquals("track-123", DataAnnotationObjectTrackId.fromClassAttributes(attributes));
    }

    @Test
    void fromClassAttributes_returnsNullForBlankOrMissingTrackId() {
        assertNull(DataAnnotationObjectTrackId.fromClassAttributes(null));
        assertNull(DataAnnotationObjectTrackId.fromClassAttributes(new JSONObject()));
        assertNull(DataAnnotationObjectTrackId.fromClassAttributes(
                new JSONObject().set("trackId", "  ")));
    }

    @Test
    void dataAnnotationObject_mirrorsTrackIdWhenAttributesChange() {
        DataAnnotationObject object = new DataAnnotationObject();

        object.setClassAttributes(new JSONObject().set("trackId", "track-123"));
        assertEquals("track-123", object.getTrackId());

        object.setClassAttributes(new JSONObject());
        assertNull(object.getTrackId());
    }

    @Test
    void dataAnnotationObject_builderMirrorsTrackIdFromAttributes() {
        DataAnnotationObject object = DataAnnotationObject.builder()
                .classAttributes(new JSONObject().set("trackId", "track-123"))
                .build();

        assertEquals("track-123", object.getTrackId());
    }

    @Test
    void dataAnnotationObject_snapshotDetectsChangedPersistedAttributes() {
        DataAnnotationObject object = new DataAnnotationObject();
        object.setClassId(1L);
        object.setClassAttributes(new JSONObject().set("trackId", "track-123").set("motionMode", "STATIC"));
        object.capturePersistedSyncState();

        assertTrue(object.matchesPersistedSyncState());

        object.setClassAttributes(new JSONObject().set("trackId", "track-123").set("motionMode", "SEMI_STATIC"));
        assertFalse(object.matchesPersistedSyncState());
    }
}
