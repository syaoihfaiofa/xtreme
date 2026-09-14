package ai.basic.x1.usecase;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class SceneLocationImportServiceTest {

    @Test
    void parse_acceptsLegacyYawOnlyFormat() {
        List<String> lines = List.of("frame_1_2: 1.0 2.0 3.0 0.5");

        SceneLocationImportService.ParseResult result = SceneLocationImportService.parseLocationLines(lines);

        assertEquals(1, result.samples().size());
        assertEquals(1.0, result.samples().get(0).x());
        assertEquals(2.0, result.samples().get(0).y());
        assertEquals(3.0, result.samples().get(0).z());
        assertEquals(0.5, result.samples().get(0).yaw());
        assertNull(result.samples().get(0).roll());
        assertNull(result.samples().get(0).pitch());
    }

    @Test
    void parse_acceptsYawRollPitchFormat() {
        List<String> lines = List.of("frame_1_2: 1.0 2.0 3.0 0.5 0.1 0.2");

        SceneLocationImportService.ParseResult result = SceneLocationImportService.parseLocationLines(lines);

        assertEquals(1, result.samples().size());
        assertEquals(0.1, result.samples().get(0).roll());
        assertEquals(0.2, result.samples().get(0).pitch());
    }

    @Test
    void parseTimestamp_acceptsPointCloudExtensionAndSensorSuffix() {
        assertEquals(1_000_000_002L,
                SceneLocationImportService.parseTimestampNs("frame_1_2.pcd"));
        assertEquals(1_000_000_002L,
                SceneLocationImportService.parseTimestampNs("frame_1_2_lidar"));
    }

    @Test
    void parseTimestamp_usesFinalSecondsNanosecondsPairAfterDatePrefix() {
        assertEquals(7_916_909_321_440L,
                SceneLocationImportService.parseTimestampNs("20260814_153659_7916_909321440"));
    }

    @Test
    void interpolatePose_usesExplicitRollAndPitchWhenPresent() {
        List<LocationPoseInterpolator.TimestampedPoseSample> samples = List.of(
                new LocationPoseInterpolator.TimestampedPoseSample(0L, 0, 0, 0, 0, 0.1, 0.2),
                new LocationPoseInterpolator.TimestampedPoseSample(10L, 10, 0, -1, 0, 0.3, 0.4));

        double[] pose = LocationPoseInterpolator.interpolatePose(5L, samples);

        assertEquals(5.0, pose[0], 0.000000001);
        assertEquals(0.2, pose[4], 0.000000001);
        assertEquals(0.3, pose[5], 0.000000001);
    }

    @Test
    void interpolatePose_marksMissingOrientationForLegacySamples() {
        List<LocationPoseInterpolator.TimestampedPoseSample> samples = List.of(
                new LocationPoseInterpolator.TimestampedPoseSample(0L, 0, 0, 0, 0),
                new LocationPoseInterpolator.TimestampedPoseSample(10L, 10, 0, -1, 0));

        double[] pose = LocationPoseInterpolator.interpolatePose(5L, samples);

        assertEquals(Double.NaN, pose[4]);
        assertEquals(Double.NaN, pose[5]);
    }
}
