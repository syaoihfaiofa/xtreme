package ai.basic.x1.adapter.port.rpc;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SceneVisibilityWorkerHttpCallerTest {

    @Test
    void requireSharedSecret_rejectsMissingOrBlankValues() {
        for (String secret : new String[]{null, "", "   "}) {
            assertThrows(IllegalArgumentException.class,
                    () -> SceneVisibilityWorkerHttpCaller.requireSharedSecret(secret));
        }
    }

    @Test
    void requireSharedSecret_acceptsNonBlankValue() {
        assertEquals("worker-secret",
                SceneVisibilityWorkerHttpCaller.requireSharedSecret("worker-secret"));
    }
}
