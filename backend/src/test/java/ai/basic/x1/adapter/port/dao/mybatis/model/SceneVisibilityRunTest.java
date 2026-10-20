package ai.basic.x1.adapter.port.dao.mybatis.model;

import ai.basic.x1.entity.enums.SceneVisibilityRunStatusEnum;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class SceneVisibilityRunTest {

    @Test
    void storesAnIndependentVisibilityResultReference() {
        SceneVisibilityRun run = SceneVisibilityRun.builder()
                .datasetId(1L)
                .sceneId(2L)
                .sourceHash("source-hash")
                .algorithmVersion("xtreme-occ-v1")
                .status(SceneVisibilityRunStatusEnum.QUEUED)
                .resultFileId(3L)
                .build();

        assertEquals(1L, run.getDatasetId());
        assertEquals(2L, run.getSceneId());
        assertEquals("source-hash", run.getSourceHash());
        assertEquals("xtreme-occ-v1", run.getAlgorithmVersion());
        assertEquals(SceneVisibilityRunStatusEnum.QUEUED, run.getStatus());
        assertEquals(3L, run.getResultFileId());
    }
}
