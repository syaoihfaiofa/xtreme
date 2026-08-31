export type PerformanceMetric = {
    name: string;
    frameId: string;
    duration: number;
    at: number;
    detail?: Record<string, number | string | boolean | undefined>;
};

/** Small in-memory performance sink. Product telemetry can subscribe without coupling the editor
 * to a vendor SDK; keeping the last 500 events also makes field diagnostics reproducible. */
export default class PerformanceMonitor {
    private starts = new Map<string, number>();
    private fps?: { frameId: string; startedAt: number; frames: number; handle: number };
    readonly metrics: PerformanceMetric[] = [];

    start(name: string, frameId: string) {
        this.starts.set(`${name}:${frameId}`, performance.now());
    }

    end(name: string, frameId: string, detail?: PerformanceMetric['detail']) {
        const key = `${name}:${frameId}`;
        const start = this.starts.get(key);
        if (start === undefined) return;
        this.starts.delete(key);
        const metric: PerformanceMetric = { name, frameId, duration: performance.now() - start, at: Date.now(), detail };
        this.metrics.push(metric);
        if (this.metrics.length > 500) this.metrics.shift();
        window.dispatchEvent(new CustomEvent('pc-performance-metric', { detail: metric }));
    }

    record(name: string, frameId: string, detail?: PerformanceMetric['detail']) {
        this.start(name, frameId);
        this.end(name, frameId, detail);
    }

    snapshotMemory(frameId: string, detail?: PerformanceMetric['detail']) {
        const memory = (performance as any).memory;
        this.record('memory-snapshot', frameId, {
            ...detail,
            jsHeapBytes: typeof memory?.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : undefined,
            jsHeapLimitBytes: typeof memory?.jsHeapSizeLimit === 'number' ? memory.jsHeapSizeLimit : undefined,
        });
    }

    startFps(frameId: string) {
        this.stopFps();
        const tick = () => {
            if (!this.fps) return;
            this.fps.frames += 1;
            this.fps.handle = requestAnimationFrame(tick);
        };
        this.fps = { frameId, startedAt: performance.now(), frames: 0, handle: requestAnimationFrame(tick) };
    }

    stopFps(detail?: PerformanceMetric['detail']) {
        if (!this.fps) return;
        const sample = this.fps;
        this.fps = undefined;
        cancelAnimationFrame(sample.handle);
        const elapsed = performance.now() - sample.startedAt;
        if (elapsed > 0) {
            this.record('playback-fps', sample.frameId, {
                ...detail,
                fps: (sample.frames * 1000) / elapsed,
                sampledMs: elapsed,
            });
        }
    }
}
