package ai.basic.x1.usecase;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

class LocationSegmenterTest {

    @Test
    void test_segmentFrames_doesNotSplitAt199Ms() {
        List<Integer> segments = LocationSegmenter.segmentFrames(
                List.of(0L, 100_000_000L, 199_000_000L, 300_000_000L),
                List.of(0L, 199_000_000L),
                200);

        assertEquals(List.of(0, 0, 0, 0), segments);
    }

    @Test
    void test_segmentFrames_splitsAt201Ms() {
        List<Integer> segments = LocationSegmenter.segmentFrames(
                List.of(0L, 1L, 201_000_000L, 202_000_000L),
                List.of(0L, 201_000_000L),
                200);

        assertEquals(List.of(0, 1, 1, 1), segments);
    }

    @Test
    void test_segmentFrames_startsNextSegmentAfterSecondRecoverySample() {
        List<Integer> segments = LocationSegmenter.segmentFrames(
                List.of(0L, 1L, 201_000_000L, 220_000_000L, 220_000_001L),
                List.of(0L, 201_000_000L, 220_000_000L),
                200);

        assertEquals(List.of(0, 1, 1, 1, 2), segments);
    }

    @Test
    void test_segmentFrames_handlesMultipleGaps() {
        List<Integer> segments = LocationSegmenter.segmentFrames(
                List.of(0L, 1L, 220_000_000L, 220_000_001L, 300_000_000L,
                        600_000_000L, 620_000_000L, 620_000_001L),
                List.of(0L, 201_000_000L, 220_000_000L, 300_000_000L,
                        600_000_000L, 620_000_000L),
                200);

        assertEquals(List.of(0, 1, 1, 2, 2, 3, 3, 4), segments);
    }
}
