package ai.basic.x1.usecase;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

final class LocationSegmenter {

    private static final long NANOSECONDS_PER_MILLISECOND = 1_000_000L;

    private LocationSegmenter() {
    }

    static List<Integer> segmentFrames(
            List<Long> orderedFrameTimestampsNs,
            List<Long> orderedSampleTimestampsNs,
            int gapThresholdMs) {
        if (orderedFrameTimestampsNs.isEmpty()) {
            return Collections.emptyList();
        }
        long thresholdNs = gapThresholdMs * NANOSECONDS_PER_MILLISECOND;
        List<Long> boundaries = new ArrayList<>();
        for (int index = 1; index < orderedSampleTimestampsNs.size(); index++) {
            long previousTimestamp = orderedSampleTimestampsNs.get(index - 1);
            long currentTimestamp = orderedSampleTimestampsNs.get(index);
            if (currentTimestamp - previousTimestamp <= thresholdNs) {
                continue;
            }
            addBoundary(boundaries, previousTimestamp);
            if (index + 1 < orderedSampleTimestampsNs.size()) {
                addBoundary(boundaries, orderedSampleTimestampsNs.get(index + 1));
            }
        }
        Collections.sort(boundaries);

        List<Integer> segments = new ArrayList<>(orderedFrameTimestampsNs.size());
        for (Long frameTimestamp : orderedFrameTimestampsNs) {
            int segmentId = 0;
            while (segmentId < boundaries.size() && frameTimestamp > boundaries.get(segmentId)) {
                segmentId++;
            }
            segments.add(segmentId);
        }
        return segments;
    }

    private static void addBoundary(List<Long> boundaries, long boundary) {
        if (!boundaries.contains(boundary)) {
            boundaries.add(boundary);
        }
    }
}
