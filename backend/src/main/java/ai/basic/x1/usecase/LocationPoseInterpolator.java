package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocationSample;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Interpolates ego pose at a frame timestamp from ordered location samples.
 */
final class LocationPoseInterpolator {

    private LocationPoseInterpolator() {
    }

    static double[] interpolatePose(long timestampNs, List<TimestampedPoseSample> sorted) {
        if (sorted == null || sorted.isEmpty()) {
            return null;
        }
        int index = Collections.binarySearch(
                sorted,
                new TimestampedPoseSample(timestampNs, 0, 0, 0, 0),
                Comparator.comparingLong(sample -> sample.timestampNs));
        if (index >= 0) {
            TimestampedPoseSample sample = sorted.get(index);
            return new double[]{sample.x, sample.y, sample.z, sample.yaw};
        }
        int insertionPoint = -(index + 1);
        if (insertionPoint <= 0) {
            TimestampedPoseSample sample = sorted.get(0);
            return new double[]{sample.x, sample.y, sample.z, sample.yaw};
        }
        if (insertionPoint >= sorted.size()) {
            TimestampedPoseSample sample = sorted.get(sorted.size() - 1);
            return new double[]{sample.x, sample.y, sample.z, sample.yaw};
        }
        TimestampedPoseSample previous = sorted.get(insertionPoint - 1);
        TimestampedPoseSample next = sorted.get(insertionPoint);
        long span = next.timestampNs - previous.timestampNs;
        double fraction = span == 0 ? 0.0 : (double) (timestampNs - previous.timestampNs) / span;
        return new double[]{
                previous.x + (next.x - previous.x) * fraction,
                previous.y + (next.y - previous.y) * fraction,
                previous.z + (next.z - previous.z) * fraction,
                previous.yaw + normalizeAngleDiff(next.yaw - previous.yaw) * fraction
        };
    }

    static List<TimestampedPoseSample> toSortedSamples(List<SceneLocationSample> samples) {
        List<TimestampedPoseSample> sorted = new ArrayList<>(samples.size());
        for (SceneLocationSample sample : samples) {
            sorted.add(new TimestampedPoseSample(
                    sample.getTimestampNs(),
                    sample.getPosX(),
                    sample.getPosY(),
                    sample.getPosZ(),
                    sample.getYaw()));
        }
        sorted.sort(Comparator.comparingLong(sample -> sample.timestampNs));
        return sorted;
    }

    private static double normalizeAngleDiff(double difference) {
        double result = difference % (2 * Math.PI);
        if (result <= -Math.PI) {
            result += 2 * Math.PI;
        } else if (result > Math.PI) {
            result -= 2 * Math.PI;
        }
        return result;
    }

    static final class TimestampedPoseSample {
        private final long timestampNs;
        private final double x;
        private final double y;
        private final double z;
        private final double yaw;

        TimestampedPoseSample(long timestampNs, double x, double y, double z, double yaw) {
            this.timestampNs = timestampNs;
            this.x = x;
            this.y = y;
            this.z = z;
            this.yaw = yaw;
        }
    }
}
