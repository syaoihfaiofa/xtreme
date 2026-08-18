package ai.basic.x1.usecase;

import cn.hutool.json.JSONUtil;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashMap;
import java.util.Map;

final class SyncPoseDebugLog {

    private static final Path LOG_PATH = resolveLogPath();

    private SyncPoseDebugLog() {
    }

    private static Path resolveLogPath() {
        String fromEnv = System.getenv("DEBUG_LOG_PATH");
        if (fromEnv != null && !fromEnv.isBlank()) {
            return Path.of(fromEnv);
        }
        Path mounted = Path.of("/debug-logs/debug-d15de3.log");
        if (Files.isDirectory(mounted.getParent())) {
            return mounted;
        }
        return Path.of("/home/lxzhu2/project/test_xtreme/.cursor/debug-d15de3.log");
    }

    static void log(String hypothesisId, String message, Map<String, Object> data) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("sessionId", "d15de3");
        payload.put("hypothesisId", hypothesisId);
        payload.put("location", "TrackSyncUseCase.buildPoseByDataId");
        payload.put("message", message);
        payload.put("data", data);
        payload.put("timestamp", System.currentTimeMillis());
        try {
            Files.writeString(
                    LOG_PATH,
                    JSONUtil.toJsonStr(payload) + System.lineSeparator(),
                    StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE,
                    StandardOpenOption.APPEND);
        } catch (Exception ignored) {
            // debug-only
        }
    }
}
