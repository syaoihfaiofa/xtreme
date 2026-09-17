package ai.basic.x1.adapter.api.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertNotNull;

class CommonConfigLabelMergeTest {

    private final CommonConfig config = new CommonConfig();

    @Test
    void registersLabelMergeUseCasesOutsideAdapterScanPackage() {
        assertNotNull(config.datasetLabelSnapshotUseCase());
        assertNotNull(config.datasetLabelSourceUseCase());
        assertNotNull(config.modelRunGroundTruthMergeUseCase());
    }
}
