package ai.basic.x1.usecase;

import ai.basic.x1.adapter.port.dao.DataInfoDAO;
import ai.basic.x1.adapter.port.dao.SceneLocationDAO;
import ai.basic.x1.adapter.port.dao.SceneLocationSampleDAO;
import ai.basic.x1.adapter.port.dao.mybatis.model.DataInfo;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocation;
import ai.basic.x1.adapter.port.dao.mybatis.model.SceneLocationSample;
import ai.basic.x1.entity.SceneLocationUploadResultBO;
import cn.hutool.core.util.StrUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

public class SceneLocationImportService {

    private static final Pattern TIMESTAMP_PATTERN = Pattern.compile("_(\\d+)_(\\d+)$");

    @Autowired
    private DataInfoDAO dataInfoDAO;

    @Autowired
    private SceneLocationDAO sceneLocationDAO;

    @Autowired
    private SceneLocationSampleDAO sceneLocationSampleDAO;

    @Transactional(rollbackFor = Exception.class)
    public SceneLocationUploadResultBO replaceSceneLocation(Long sceneId, Collection<String> lines) {
        List<DataInfo> frames = dataInfoDAO.list(Wrappers.lambdaQuery(DataInfo.class)
                .eq(DataInfo::getParentId, sceneId)
                .eq(DataInfo::getIsDeleted, false));
        ParseResult parseResult = parse(lines);
        List<LocationSample> samples = parseResult.samples;

        List<SceneLocation> locations = new ArrayList<>();
        for (DataInfo frame : frames) {
            Long frameTimestampNs = parseTimestampNs(frame.getName());
            if (frameTimestampNs == null || samples.isEmpty()) {
                continue;
            }
            double[] pose = interpolatePose(frameTimestampNs, samples);
            locations.add(SceneLocation.builder()
                    .dataId(frame.getId())
                    .posX(pose[0])
                    .posY(pose[1])
                    .posZ(pose[2])
                    .yaw(pose[3])
                    .build());
        }

        List<Long> frameIds = frames.stream().map(DataInfo::getId).collect(Collectors.toList());
        if (!frameIds.isEmpty()) {
            sceneLocationDAO.remove(Wrappers.lambdaQuery(SceneLocation.class)
                    .in(SceneLocation::getDataId, frameIds));
        }
        if (!locations.isEmpty()) {
            sceneLocationDAO.saveBatch(locations);
        }

        sceneLocationSampleDAO.remove(Wrappers.lambdaQuery(SceneLocationSample.class)
                .eq(SceneLocationSample::getSceneId, sceneId));
        if (!samples.isEmpty()) {
            List<SceneLocationSample> storedSamples = samples.stream()
                    .map(sample -> SceneLocationSample.builder()
                            .sceneId(sceneId)
                            .timestampNs(sample.timestampNs)
                            .posX(sample.x)
                            .posY(sample.y)
                            .posZ(sample.z)
                            .yaw(sample.yaw)
                            .build())
                    .collect(Collectors.toList());
            sceneLocationSampleDAO.saveBatch(storedSamples);
        }

        return SceneLocationUploadResultBO.builder()
                .totalLines(parseResult.totalLines)
                .matchedCount(locations.size())
                .unmatchedCount(frames.size() - locations.size())
                .invalidCount(parseResult.invalidCount)
                .build();
    }

    static Long parseTimestampNs(String name) {
        if (StrUtil.isBlank(name)) {
            return null;
        }
        Matcher matcher = TIMESTAMP_PATTERN.matcher(name.trim());
        if (!matcher.find()) {
            return null;
        }
        try {
            long high = Long.parseLong(matcher.group(1));
            long low = Long.parseLong(matcher.group(2));
            return high * 1_000_000_000L + low;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static ParseResult parse(Collection<String> lines) {
        int totalLines = 0;
        int invalidCount = 0;
        Map<Long, LocationSample> samplesByTimestamp = new LinkedHashMap<>();
        for (String rawLine : lines) {
            String line = rawLine.trim();
            if (StrUtil.isBlank(line)) {
                continue;
            }
            totalLines++;
            int colonIndex = line.indexOf(':');
            if (colonIndex < 0) {
                invalidCount++;
                continue;
            }
            String[] parts = line.substring(colonIndex + 1).trim().split("\\s+");
            Long timestampNs = parseTimestampNs(line.substring(0, colonIndex).trim());
            if (parts.length < 4 || timestampNs == null) {
                invalidCount++;
                continue;
            }
            try {
                samplesByTimestamp.put(timestampNs, new LocationSample(
                        timestampNs,
                        Double.parseDouble(parts[0]),
                        Double.parseDouble(parts[1]),
                        Double.parseDouble(parts[2]),
                        Double.parseDouble(parts[3])));
            } catch (NumberFormatException e) {
                invalidCount++;
            }
        }
        List<LocationSample> samples = new ArrayList<>(samplesByTimestamp.values());
        samples.sort(Comparator.comparingLong(sample -> sample.timestampNs));
        return new ParseResult(totalLines, invalidCount, samples);
    }

    private static double[] interpolatePose(long timestampNs, List<LocationSample> sorted) {
        int index = Collections.binarySearch(
                sorted,
                new LocationSample(timestampNs, 0, 0, 0, 0),
                Comparator.comparingLong(sample -> sample.timestampNs));
        if (index >= 0) {
            LocationSample sample = sorted.get(index);
            return new double[]{sample.x, sample.y, sample.z, sample.yaw};
        }
        int insertionPoint = -(index + 1);
        if (insertionPoint <= 0) {
            LocationSample sample = sorted.get(0);
            return new double[]{sample.x, sample.y, sample.z, sample.yaw};
        }
        if (insertionPoint >= sorted.size()) {
            LocationSample sample = sorted.get(sorted.size() - 1);
            return new double[]{sample.x, sample.y, sample.z, sample.yaw};
        }
        LocationSample previous = sorted.get(insertionPoint - 1);
        LocationSample next = sorted.get(insertionPoint);
        long span = next.timestampNs - previous.timestampNs;
        double fraction = span == 0 ? 0.0 : (double) (timestampNs - previous.timestampNs) / span;
        return new double[]{
                previous.x + (next.x - previous.x) * fraction,
                previous.y + (next.y - previous.y) * fraction,
                previous.z + (next.z - previous.z) * fraction,
                previous.yaw + normalizeAngleDiff(next.yaw - previous.yaw) * fraction
        };
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

    private static final class ParseResult {
        private final int totalLines;
        private final int invalidCount;
        private final List<LocationSample> samples;

        private ParseResult(int totalLines, int invalidCount, List<LocationSample> samples) {
            this.totalLines = totalLines;
            this.invalidCount = invalidCount;
            this.samples = samples;
        }
    }

    private static final class LocationSample {
        private final long timestampNs;
        private final double x;
        private final double y;
        private final double z;
        private final double yaw;

        private LocationSample(long timestampNs, double x, double y, double z, double yaw) {
            this.timestampNs = timestampNs;
            this.x = x;
            this.y = y;
            this.z = z;
            this.yaw = yaw;
        }
    }
}
