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

    static final double MISSING_ANGLE = Double.NaN;

    private LocationPoseInterpolator() {
    }

    /**
     * @return [x, y, z, yaw, roll, pitch]; roll/pitch are {@link #MISSING_ANGLE} when not explicitly provided
     */
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
            return sampleValues(sample);
        }
        int insertionPoint = -(index + 1);
        if (insertionPoint <= 0) {
            TimestampedPoseSample sample = sorted.get(0);
            return sampleValues(sample);
        }
        if (insertionPoint >= sorted.size()) {
            TimestampedPoseSample sample = sorted.get(sorted.size() - 1);
            return sampleValues(sample);
        }
        TimestampedPoseSample previous = sorted.get(insertionPoint - 1);
        TimestampedPoseSample next = sorted.get(insertionPoint);
        long span = next.timestampNs - previous.timestampNs;
        double fraction = span == 0 ? 0.0 : (double) (timestampNs - previous.timestampNs) / span;
        return new double[]{
                previous.x + (next.x - previous.x) * fraction,
                previous.y + (next.y - previous.y) * fraction,
                previous.z + (next.z - previous.z) * fraction,
                previous.yaw + normalizeAngleDiff(next.yaw - previous.yaw) * fraction,
                interpolateOptionalAngle(previous.roll, next.roll, fraction),
                interpolateOptionalAngle(previous.pitch, next.pitch, fraction)
        };
    }

    static double estimatePitch(long timestampNs, List<TimestampedPoseSample> sorted) {
        if (sorted == null || sorted.size() < 2) {
            return 0;
        }
        int index = Collections.binarySearch(
                sorted,
                new TimestampedPoseSample(timestampNs, 0, 0, 0, 0),
                Comparator.comparingLong(sample -> sample.timestampNs));
        int centerIndex = index >= 0 ? index : Math.max(0, Math.min(sorted.size() - 1, -(index + 1)));
        TimestampedPoseSample center = sorted.get(centerIndex);
        if (center.hasExplicitPitch()) {
            return center.pitch;
        }
        int previousIndex = Math.max(0, centerIndex - 1);
        int nextIndex = Math.min(sorted.size() - 1, centerIndex + 1);
        if (previousIndex == nextIndex) {
            return 0;
        }
        TimestampedPoseSample previous = sorted.get(previousIndex);
        TimestampedPoseSample next = sorted.get(nextIndex);
        if (previous.hasExplicitPitch() && next.hasExplicitPitch()) {
            long span = next.timestampNs - previous.timestampNs;
            double fraction = span == 0 ? 0.0 : (double) (timestampNs - previous.timestampNs) / span;
            return previous.pitch + normalizeAngleDiff(next.pitch - previous.pitch) * fraction;
        }
        double deltaX = next.x - previous.x;
        double deltaY = next.y - previous.y;
        double deltaZ = next.z - previous.z;
        double horizontal = Math.hypot(deltaX, deltaY);
        if (horizontal < 1e-6) {
            return 0;
        }
        return Math.atan2(-deltaZ, horizontal);
    }

    static List<TimestampedPoseSample> toSortedSamples(List<SceneLocationSample> samples) {
        List<TimestampedPoseSample> sorted = new ArrayList<>(samples.size());
        for (SceneLocationSample sample : samples) {
            sorted.add(new TimestampedPoseSample(
                    sample.getTimestampNs(),
                    sample.getPosX(),
                    sample.getPosY(),
                    sample.getPosZ(),
                    sample.getYaw(),
                    sample.getRoll(),
                    sample.getPitch()));
        }
        sorted.sort(Comparator.comparingLong(sample -> sample.timestampNs));
        return sorted;
    }

    private static double[] sampleValues(TimestampedPoseSample sample) {
        return new double[]{
                sample.x,
                sample.y,
                sample.z,
                sample.yaw,
                sample.hasExplicitRoll() ? sample.roll : MISSING_ANGLE,
                sample.hasExplicitPitch() ? sample.pitch : MISSING_ANGLE
        };
    }

    private static double interpolateOptionalAngle(Double previous, Double next, double fraction) {
        if (previous == null || next == null) {
            return MISSING_ANGLE;
        }
        return previous + normalizeAngleDiff(next - previous) * fraction;
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
        private final Double roll;
        private final Double pitch;

        TimestampedPoseSample(long timestampNs, double x, double y, double z, double yaw) {
            this(timestampNs, x, y, z, yaw, null, null);
        }

        TimestampedPoseSample(
                long timestampNs,
                double x,
                double y,
                double z,
                double yaw,
                Double roll,
                Double pitch) {
            this.timestampNs = timestampNs;
            this.x = x;
            this.y = y;
            this.z = z;
            this.yaw = yaw;
            this.roll = roll;
            this.pitch = pitch;
        }

        boolean hasExplicitRoll() {
            return roll != null;
        }

        boolean hasExplicitPitch() {
            return pitch != null;
        }
    }
}
