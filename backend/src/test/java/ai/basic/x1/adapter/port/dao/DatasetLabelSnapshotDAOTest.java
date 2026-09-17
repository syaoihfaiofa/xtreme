package ai.basic.x1.adapter.port.dao;

import ai.basic.x1.adapter.port.dao.mybatis.model.DatasetLabelSnapshot;
import ai.basic.x1.entity.enums.DataAnnotationObjectSourceTypeEnum;
import com.baomidou.mybatisplus.annotation.TableName;
import org.junit.jupiter.api.Test;

import java.time.OffsetDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

class DatasetLabelSnapshotDAOTest {

    @Test
    void snapshotModel_mapsSceneScopedLabelSource() {
        OffsetDateTime createdAt = OffsetDateTime.parse("2026-09-16T09:30:00Z");
        DatasetLabelSnapshot snapshot = DatasetLabelSnapshot.builder()
                .id(5L)
                .datasetId(1L)
                .sceneId(10L)
                .name("replace-2026-09-16-17:30")
                .createdAt(createdAt)
                .createdBy(7L)
                .build();

        TableName tableName = DatasetLabelSnapshot.class.getAnnotation(TableName.class);
        assertNotNull(tableName);
        assertEquals("dataset_label_snapshot", tableName.value());
        assertEquals(1L, snapshot.getDatasetId());
        assertEquals(10L, snapshot.getSceneId());
        assertEquals(createdAt, snapshot.getCreatedAt());
        assertEquals(
                DataAnnotationObjectSourceTypeEnum.SNAPSHOT,
                DataAnnotationObjectSourceTypeEnum.valueOf("SNAPSHOT"));
    }
}
