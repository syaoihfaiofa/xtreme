import { IDataResource, IFrame, IFileConfig, PointAttr } from '../type';
import { PCDLoader } from 'pc-render';
import Editor from '../Editor';
// import * as api from '../api';
import * as utils from '../utils';
import Event from '../config/event';
import { IImgViewConfig } from 'pc-editor';
import { orderEvictionCandidates, orderPrefetchIndices } from './CachePolicy';
import { shouldScheduleFullLoad } from './FullLoadPolicy';

export type LoadMode = 'near_2' | 'all';
type PointCloudChunk = { id: string; path: string; url?: string; bounds: number[]; pointCount: number; byteSize: number };
type PointCloudManifest = { version: number; pointCount: number; fields: string[]; chunks: PointCloudChunk[] };
export class ResourceLoader {
    manual: boolean = false;
    data: IFrame;
    dataResource: DataResource;
    generation: number;
    promise: Promise<IDataResource> = {} as Promise<IDataResource>;
    controller = new AbortController();
    constructor(dataResource: DataResource, data: IFrame) {
        this.data = data;
        this.dataResource = dataResource;
        this.generation = dataResource.generation;
        this.handleProgress = this.handleProgress.bind(this);
    }
    remove(scheduleNextLoad: boolean = true) {
        this.dataResource.loaders = this.dataResource.loaders.filter(
            (e) => e.data.id !== this.data.id,
        );

        if (scheduleNextLoad && this.dataResource.isGenerationCurrent(this.generation)) {
            setTimeout(() => {
                if (this.dataResource.isGenerationCurrent(this.generation)) {
                    this.dataResource.load();
                }
            });
        }
    }
    get() {
        return this.promise;
    }
    cancel() {
        // Prefetch loaders do not have a caller awaiting get().  Consume their expected
        // abort rejection before cancelling so rapid navigation does not surface an
        // unhandled AbortError in the browser console.
        this.promise.catch(() => undefined);
        this.controller.abort();
        this.data.loadState = '';
        // A cancelled prefetch must immediately free its concurrency slot.  Do
        // not schedule another background load here: activateFrame() has already
        // selected a newer frame as the only resource that needs priority.
        this.remove(false);
    }
    load() {
        let promise: Promise<IDataResource> = new Promise(async (resolve, reject) => {
            try {
                let config = this.dataResource.dataMap[this.data.id];
                this.data.loadState = 'loading';
                this.dataResource.editor.performanceMonitor.start('resource-total', this.data.id);

                this.dataResource.editor.dispatchEvent({
                    type: Event.RESOURCE_LOAD_LOADING,
                    data: this.data,
                });

                if (!config) {
                    config = await this.dataResource.loadDataConfig(this.data);
                }

                // test resource
                // if (import.meta.env.DEV) {
                //     config.pointsUrl = '/case-padaset/00.pcd';
                // }

                // Camera images are useful but must not delay point-cloud interaction.
                this.dataResource.loadImage(config.viewConfig).then(() => {
                    config.byteSize = this.dataResource.getResourceByteSize(config);
                    this.dataResource.trimCache();
                    if (this.dataResource.isGenerationCurrent(this.generation) && config.pointsData?.position?.length) {
                        this.dataResource.applyResourceIfCurrent(this.data, config);
                    }
                }).catch(() => undefined);

                const initialUrl = config.previewPointsUrl || config.pointsUrl;
                let loadedPreview = Boolean(config.previewPointsUrl && config.previewPointsUrl !== config.pointsUrl);
                let pointsData: any;
                try {
                    pointsData = await this.dataResource.loadPointsWithRetry(
                        initialUrl,
                        this.handleProgress,
                        this.controller.signal,
                        this.data.id,
                        loadedPreview ? 'preview' : 'full',
                    );
                } catch (error) {
                    if (!loadedPreview || this.controller.signal.aborted) throw error;
                    this.dataResource.editor.performanceMonitor.record('preview-load-fallback', this.data.id);
                    loadedPreview = false;
                    pointsData = await this.dataResource.loadPointsWithRetry(
                        config.pointsUrl,
                        this.handleProgress,
                        this.controller.signal,
                        this.data.id,
                        'full',
                    );
                }

                let pointsInfo = this.dataResource.calculatePointInfo(pointsData);

                config.time = Date.now();
                config.pointsData = pointsData;
                config.ground = pointsInfo.ground;
                config.intensityRange = pointsInfo.intensityRange;
                config.resourceState = loadedPreview ? 'preview-ready' : 'full-ready';
                config.byteSize = this.dataResource.getResourceByteSize(config);
                this.dataResource.editor.performanceMonitor.end('resource-total', this.data.id, {
                    pointBytes: config.byteSize,
                    preview: loadedPreview,
                });

                if (!this.dataResource.isGenerationCurrent(this.generation)) {
                    this.dataResource.releaseResource(config);
                    resolve(config);
                    return;
                }
                this.dataResource.setResource(this.data, config);

                console.log(`load resource: ${this.data.id} completed`);
                this.data.loadState = 'complete';
                this.remove();

                this.dataResource.editor.dispatchEvent({
                    type: Event.RESOURCE_LOAD_COMPLETE,
                    data: this.data,
                });
                this.dataResource.editor.performanceMonitor.snapshotMemory(this.data.id, {
                    resourceBytes: config.byteSize,
                    cacheBytes: this.dataResource.getCacheByteSize(),
                });
                if (loadedPreview) {
                    this.dataResource.scheduleFullUpgrade(this.data, config, this.generation);
                }
                resolve(config);
            } catch (e) {
                if (this.controller.signal.aborted) {
                    this.data.loadState = '';
                    return reject(e);
                }
                if (!this.dataResource.isGenerationCurrent(this.generation)) {
                    reject(e);
                    return;
                }
                console.log(`load resource: ${this.data.id} err`);
                this.data.loadState = 'error';
                this.remove();
                this.dataResource.editor.dispatchEvent({
                    type: Event.RESOURCE_LOAD_ERROR,
                    data: this.data,
                });
                reject(e);
            }
        });

        this.promise = promise;
    }
    handleProgress(percent: number) {
        this.onProgress(percent);
    }
    onProgress(percent: number) {
        // console.log(percent);
    }
}

export default class DataResource {
    static readonly DEFAULT_CACHE_BUDGET = 512 * 1024 * 1024;
    static readonly LOW_MEMORY_CACHE_BUDGET = 256 * 1024 * 1024;
    static readonly MAX_CONCURRENT_LOADERS = 2;
    static readonly FULL_UPGRADE_IDLE_DELAY = 500;
    loadMode: LoadMode = 'near_2';
    editor: Editor;
    dataMap: Record<string, IDataResource> = {};
    loaders: ResourceLoader[] = [];
    pointsLoader: PCDLoader = new PCDLoader();
    generation: number = 0;
    cacheBudget = DataResource.DEFAULT_CACHE_BUDGET;
    private prefetchDirection: 1 | -1 = 1;
    private worker?: Worker;
    private workerSequence = 0;
    private workerJobs = new Map<number, { resolve: (data: any) => void; reject: (error: any) => void }>();
    private backgroundControllers = new Map<string, AbortController>();
    private fullUpgradeTimer?: ReturnType<typeof setTimeout>;
    private scheduledFullFrameId?: string;
    private chunkControllers = new Map<string, AbortController>();
    private chunkManifest = new Map<string, PointCloudManifest>();
    private loadedChunks = new Map<string, Map<string, { data: any; time: number; byteSize: number }>>();
    private chunkViewTimer?: ReturnType<typeof setTimeout>;
    constructor(editor: Editor) {
        this.editor = editor;
        if (typeof Worker !== 'undefined') {
            this.worker = new Worker(new URL('./PointCloudWorker.ts', import.meta.url), { type: 'module' });
            this.worker.onmessage = ({ data }) => {
                const job = this.workerJobs.get(data.id);
                if (!job) return;
                this.workerJobs.delete(data.id);
                data.error ? job.reject(new Error(data.error)) : job.resolve(data);
            };
            this.worker.onerror = (error) => {
                this.workerJobs.forEach((job) => job.reject(error));
                this.workerJobs.clear();
            };
        }
        // Chrome exposes this signal on supported devices; retain the safer desktop default when
        // it is unavailable.
        if (typeof navigator !== 'undefined' && (navigator as any).deviceMemory <= 4) {
            this.cacheBudget = DataResource.LOW_MEMORY_CACHE_BUDGET;
        }
        this.editor.pc.addEventListener('point-cloud-view-change', () => this.queueVisibleChunkLoad());
    }

    clear() {
        this.generation += 1;
        this.loaders.forEach((loader) => loader.cancel());
        Object.values(this.dataMap).forEach((resource) => this.releaseResource(resource));
        this.dataMap = {};
        this.loaders = [];
        this.workerJobs.forEach((job) => job.reject(new Error('resource generation changed')));
        this.workerJobs.clear();
        this.backgroundControllers.forEach((controller) => controller.abort());
        this.backgroundControllers.clear();
        this.chunkControllers.forEach((controller) => controller.abort());
        this.chunkControllers.clear();
        this.chunkManifest.clear();
        this.loadedChunks.clear();
        if (this.chunkViewTimer) clearTimeout(this.chunkViewTimer);
        this.clearScheduledFullUpgrade();
    }

    destroy() {
        this.clear();
        this.worker?.terminate();
        this.worker = undefined;
    }

    isGenerationCurrent(generation: number): boolean {
        return generation === this.generation;
    }

    async loadDataConfig(data: IFrame) {
        return await this.editor.businessManager.loadFrameConfig(data);
    }

    async loadImage(viewConfigs: IImgViewConfig[]) {
        let requests = [] as Promise<HTMLImageElement | null>[];

        viewConfigs.forEach((config) => {
            if (!config.imgObject) {
                requests.push(createRequest(config));
            }
        });

        if (requests.length) {
            await Promise.all(requests);
        }

        if (viewConfigs.filter((e) => !e.imgObject).length > 0) throw 'load image error';

        function createRequest(config: IImgViewConfig): Promise<HTMLImageElement | null> {
            return new Promise((resolve, reject) => {
                let img = document.createElement('img') as HTMLImageElement;
                img.src = config.imgUrl;
                img.onload = () => {
                    config.imgObject = img;
                    config.imgSize = [img.naturalWidth, img.naturalHeight];
                    resolve(img);
                };
                img.onerror = () => {
                    resolve(null);
                };
                img.onabort = () => {
                    resolve(null);
                };
            });
        }
    }
    setGround(ground: number, frameId: string) {
        const source = this.dataMap[frameId];
        if (source.pointsData) {
            source.ground = ground;
        }
    }
    calculatePointInfo(data: Record<PointAttr, number[]>) {
        const fromWorker = (data as any).pointInfo;
        if (fromWorker) return fromWorker;
        let position = data.position || [];
        let intensity = data.intensity || [];

        let intensityRange = undefined;
        let ground = 0;
        if (position.length > 0) ground = utils.getPositionGround(position);
        if (intensity.length > 0) {
            let min = Infinity;
            let max = -Infinity;
            for (let i = 0; i < intensity.length; i++) {
                min = Math.min(intensity[i], min);
                max = Math.max(intensity[i], max);
                intensityRange = [min, max] as [number, number];
            }
        }
        return { ground, intensityRange };
    }

    async loadPoints(
        pointsUrl: string,
        onProgress?: (percent: number) => void,
        signal?: AbortSignal,
        frameId: string = 'unknown',
        layer: 'preview' | 'full' = 'full',
    ): Promise<any> {
        this.editor.performanceMonitor.start(`point-download-${layer}`, frameId);
        const response = await fetch(pointsUrl, { signal });
        if (!response.ok) throw new Error(`point cloud download failed: ${response.status}`);
        const total = Number(response.headers.get('content-length')) || 0;
        let buffer: ArrayBuffer;
        if (response.body) {
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let received = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                    chunks.push(value);
                    received += value.byteLength;
                    if (onProgress && total) onProgress(received / total);
                }
            }
            const joined = new Uint8Array(received);
            let offset = 0;
            chunks.forEach((chunk) => { joined.set(chunk, offset); offset += chunk.byteLength; });
            buffer = joined.buffer;
        } else {
            buffer = await response.arrayBuffer();
        }
        if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
        this.editor.performanceMonitor.end(`point-download-${layer}`, frameId, { bytes: buffer.byteLength });
        this.editor.performanceMonitor.start('worker-decode', frameId);
        const parsed = await this.parsePoints(buffer);
        this.editor.performanceMonitor.end('worker-decode', frameId, { layer });
        return parsed;
    }

    /**
     * A frame switch may briefly contend with neighbour prefetches. Retry once for
     * transient download/worker failures, but do not hide permanent 4xx resource
     * errors or intentionally aborted requests.
     */
    async loadPointsWithRetry(
        pointsUrl: string,
        onProgress?: (percent: number) => void,
        signal?: AbortSignal,
        frameId: string = 'unknown',
        layer: 'preview' | 'full' = 'full',
    ): Promise<any> {
        try {
            return await this.loadPoints(pointsUrl, onProgress, signal, frameId, layer);
        } catch (error) {
            if (signal?.aborted || !this.isTransientPointLoadError(error)) throw error;
            this.editor.performanceMonitor.record('point-download-retry', frameId, { layer });
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
            if (signal?.aborted) throw error;
            return this.loadPoints(pointsUrl, onProgress, signal, frameId, layer);
        }
    }

    private isTransientPointLoadError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        const status = Number(message.match(/point cloud download failed: (\d{3})/)?.[1]);
        // Missing/expired resources require server-side remediation; retrying them
        // only slows frame navigation and masks the actionable status code.
        return !Number.isFinite(status) || status >= 500 || status === 408 || status === 429;
    }

    private parsePoints(buffer: ArrayBuffer): Promise<any> {
        if (!this.worker) return Promise.resolve(this.pointsLoader.parse2(buffer));
        const id = ++this.workerSequence;
        return new Promise((resolve, reject) => {
            this.workerJobs.set(id, { resolve, reject });
            this.worker!.postMessage(
                {
                    id,
                    buffer,
                    // Only prepare the extra per-point data when local contrast is enabled.
                    calculateLocalLuminance: this.editor.state.config.rgbLocalContrast,
                },
                [buffer],
            );
        });
    }

    getResourceByteSize(resource: IDataResource): number {
        const values = Object.values(resource.pointsData || {}) as any[];
        const pointBytes = values.reduce((sum: number, value: any) => sum + (value?.byteLength || value?.length || 0), 0);
        const imageBytes = (resource.viewConfig || []).reduce((sum, view: any) => sum + ((view.imgSize?.[0] || 0) * (view.imgSize?.[1] || 0) * 4), 0);
        return pointBytes + imageBytes;
    }

    getCacheByteSize(): number {
        return Object.values(this.dataMap).reduce(
            (sum, resource) => sum + (resource.byteSize || this.getResourceByteSize(resource)),
            0,
        );
    }

    applyResourceIfCurrent(frame: IFrame, resource: IDataResource) {
        const current = this.editor.state.frames[this.editor.state.frameIndex];
        if (current?.id !== frame.id) return;
        this.editor.loadManager.setResource(resource);
    }

    private clearScheduledFullUpgrade() {
        if (this.fullUpgradeTimer) clearTimeout(this.fullUpgradeTimer);
        this.fullUpgradeTimer = undefined;
        this.scheduledFullFrameId = undefined;
    }

    private isCurrentFrame(frame: IFrame) {
        return this.editor.state.frames[this.editor.state.frameIndex]?.id === frame.id;
    }

    /**
     * Frame navigation promotes only the selected frame.  Neighbour prefetches remain
     * preview-only, so enabling auto-load cannot start a row of full PCD downloads.
     */
    activateFrame(frame: IFrame) {
        this.clearScheduledFullUpgrade();
        // Without this, rapid navigation leaves the previous frame's preview
        // downloads and worker decodes running while a new foreground load starts.
        // The browser can then fail a perfectly valid request even though MinIO
        // returned 200. Keep only the target frame's in-flight resource.
        this.loaders
            .filter((loader) => String(loader.data.id) !== String(frame.id))
            .forEach((loader) => loader.cancel());
        this.cancelBackgroundFullLoads(frame.id);
        const resource = this.dataMap[frame.id];
        if (resource) this.scheduleFullUpgrade(frame, resource, this.generation);
    }

    onPlaybackStarted() {
        this.clearScheduledFullUpgrade();
        this.cancelBackgroundFullLoads();
    }

    onPlaybackStopped() {
        const frame = this.editor.getCurrentFrame();
        if (!frame) return;
        const resource = this.dataMap[frame.id];
        if (resource) this.scheduleFullUpgrade(frame, resource, this.generation);
    }

    private cancelBackgroundFullLoads(keepFrameId?: string) {
        this.backgroundControllers.forEach((controller, frameId) => {
            if (frameId === keepFrameId) return;
            const frame = this.editor.state.frames.find((item) => item.id === frameId);
            // A dirty frame may need the complete cloud for a later save/edit operation.
            if (frame?.needSave) return;
            controller.abort();
            const resource = this.dataMap[frameId];
            if (resource?.resourceState === 'full-loading') resource.resourceState = 'preview-ready';
        });
    }

    scheduleFullUpgrade(frame: IFrame, resource: IDataResource, generation: number = this.generation) {
        const hasPreview = Boolean(resource.previewPointsUrl && resource.previewPointsUrl !== resource.pointsUrl);
        if (!shouldScheduleFullLoad({
            isCurrentFrame: this.isCurrentFrame(frame),
            isPlaying: this.editor.playManager.playing,
            resourceState: resource.resourceState,
            hasPreview,
        })) return;
        if (this.backgroundControllers.has(frame.id)) return;
        if (this.scheduledFullFrameId === frame.id) return;

        this.clearScheduledFullUpgrade();
        this.scheduledFullFrameId = frame.id;
        this.fullUpgradeTimer = setTimeout(() => {
            this.fullUpgradeTimer = undefined;
            this.scheduledFullFrameId = undefined;
            if (!shouldScheduleFullLoad({
                isCurrentFrame: this.isCurrentFrame(frame),
                isPlaying: this.editor.playManager.playing,
                resourceState: resource.resourceState,
                hasPreview,
            })) return;
            this.upgradeToFull(frame, resource, generation, new AbortController());
        }, DataResource.FULL_UPGRADE_IDLE_DELAY);
    }

    async upgradeToFull(frame: IFrame, resource: IDataResource, generation: number, controller: AbortController) {
        const signal = controller.signal;
        this.backgroundControllers.get(frame.id)?.abort();
        this.backgroundControllers.set(frame.id, controller);
        try {
            resource.resourceState = 'full-loading';
            this.editor.performanceMonitor.start('full-point-ready', frame.id);
            if (resource.chunkManifestUrl) {
                await this.loadVisibleChunks(frame, resource, generation, signal);
                if (!this.isGenerationCurrent(generation) || signal.aborted) return;
                resource.resourceState = 'full-ready';
                this.editor.dispatchEvent({ type: Event.RESOURCE_LOAD_COMPLETE, data: frame });
                this.editor.performanceMonitor.end('full-point-ready', frame.id, { chunked: true });
                return;
            }
            const pointsData = await this.loadPoints(resource.pointsUrl, undefined, signal, frame.id, 'full');
            if (!this.isGenerationCurrent(generation) || signal.aborted) return;
            const info = this.calculatePointInfo(pointsData);
            resource.pointsData = pointsData;
            resource.ground = info.ground;
            resource.intensityRange = info.intensityRange;
            resource.resourceState = 'full-ready';
            resource.byteSize = this.getResourceByteSize(resource);
            resource.time = Date.now();
            this.trimCache();
            this.applyResourceIfCurrent(frame, resource);
            this.editor.performanceMonitor.record('gpu-buffer-update', frame.id, { pointBytes: resource.byteSize });
            this.editor.dispatchEvent({ type: Event.RESOURCE_LOAD_COMPLETE, data: frame });
            this.editor.performanceMonitor.end('full-point-ready', frame.id, { pointBytes: resource.byteSize });
        } catch (error) {
            // A preview remains usable when the full resource fails or becomes stale.
            if (!signal.aborted) console.warn('full point cloud load failed; keeping preview', error);
            if (resource.resourceState === 'full-loading') resource.resourceState = 'preview-ready';
        } finally {
            if (this.backgroundControllers.get(frame.id) === controller) {
                this.backgroundControllers.delete(frame.id);
            }
        }
    }

    private queueVisibleChunkLoad() {
        if (this.editor.playManager.playing || this.chunkViewTimer) return;
        this.chunkViewTimer = setTimeout(() => {
            this.chunkViewTimer = undefined;
            const frame = this.editor.getCurrentFrame();
            const resource = frame && this.dataMap[frame.id];
            if (frame && resource?.chunkManifestUrl) {
                const controller = new AbortController();
                this.loadVisibleChunks(frame, resource, this.generation, controller.signal).catch(() => undefined);
            }
        }, 120);
    }

    private async getChunkManifest(frame: IFrame, resource: IDataResource, signal: AbortSignal) {
        let manifest = this.chunkManifest.get(frame.id);
        if (manifest) return manifest;
        this.editor.performanceMonitor.start('chunk-manifest-download', frame.id);
        const response = await fetch(resource.chunkManifestUrl!, { signal });
        if (!response.ok) throw new Error(`chunk manifest download failed: ${response.status}`);
        manifest = await response.json();
        manifest.chunks = (manifest.chunks || []).map((chunk: PointCloudChunk) => ({
            ...chunk,
            // Manifests persist object keys, never a signed upload URL. Current deployments use
            // the same object directory for the manifest and its chunks.
            url: new URL(chunk.path.substring(chunk.path.lastIndexOf('/') + 1), resource.chunkManifestUrl).toString(),
        }));
        this.chunkManifest.set(frame.id, manifest);
        this.editor.performanceMonitor.end('chunk-manifest-download', frame.id, { chunks: manifest.chunks.length });
        return manifest;
    }

    private async loadVisibleChunks(frame: IFrame, resource: IDataResource, generation: number, signal: AbortSignal) {
        const manifest = await this.getChunkManifest(frame, resource, signal);
        if (!this.isGenerationCurrent(generation) || signal.aborted) return;
        const visible = new Set(this.editor.pc.getVisibleChunkIds(manifest.chunks));
        // Keep the full-resolution neighbourhood of the selected annotation available while it
        // is being edited, even if a camera orbit momentarily places it outside the frustum.
        this.editor.pc.selection.forEach((object: any) => {
            const selectedBounds = object.geometry?.boundingBox;
            if (!selectedBounds) return;
            object.updateMatrixWorld?.();
            const worldBounds = selectedBounds.clone().applyMatrix4(object.matrixWorld);
            manifest.chunks.forEach((chunk) => {
                const b = chunk.bounds;
                if (Array.isArray(b) && b.length === 6 && worldBounds.intersectsBox({
                    min: { x: b[0], y: b[1], z: b[2] }, max: { x: b[3], y: b[4], z: b[5] },
                } as any)) visible.add(chunk.id);
            });
        });
        const loaded = this.loadedChunks.get(frame.id) || new Map();
        this.loadedChunks.set(frame.id, loaded);
        const protectedIds = visible;
        for (const [id, cached] of loaded) {
            if (!protectedIds.has(id)) {
                this.editor.pc.removePointCloudChunk(id);
                loaded.delete(id);
                this.editor.performanceMonitor.record('chunk-cache-evict', frame.id, { chunkId: id, bytes: cached.byteSize });
            }
        }
        await Promise.all([...visible].map(async (id) => {
            if (loaded.has(id)) { loaded.get(id)!.time = Date.now(); return; }
            const chunk = manifest.chunks.find((item) => item.id === id);
            if (!chunk?.url) return;
            const key = `${frame.id}:${id}`;
            if (this.chunkControllers.has(key)) return;
            const controller = new AbortController();
            this.chunkControllers.set(key, controller);
            try {
                const data = await this.loadPoints(chunk.url, undefined, controller.signal, frame.id, 'full');
                if (!this.isGenerationCurrent(generation) || controller.signal.aborted) return;
                loaded.set(id, { data, time: Date.now(), byteSize: chunk.byteSize || 0 });
                this.editor.pc.setPointCloudChunk(id, data);
                this.editor.performanceMonitor.record('chunk-gpu-buffer-update', frame.id, { chunkId: id, pointBytes: chunk.byteSize });
            } finally {
                this.chunkControllers.delete(key);
            }
        }));
        this.editor.performanceMonitor.record('visible-chunks-ready', frame.id, { visible: visible.size, loaded: loaded.size });
    }

    setLoadMode(mode: LoadMode) {
        this.loadMode = mode;
        this.editor.state.config.autoLoad = mode === 'all';
        this.trimCache();
    }

    setPrefetchDirection(direction: 1 | -1) {
        this.prefetchDirection = direction;
    }

    getAutoLoadConfig() {
        const { frames, config } = this.editor.state;
        const total = Math.max(1, frames.length);
        const start = Math.max(0, Math.min(total - 1, (config.autoLoadStartFrame || 1) - 1));
        const configuredEnd = config.autoLoadEndFrame || total;
        const end = Math.max(start, Math.min(total - 1, configuredEnd - 1));
        const maxFrames = Math.max(
            1,
            Math.min(end - start + 1, Math.round(config.autoLoadMaxFrames || 80)),
        );
        return { start, end, maxFrames };
    }

    applyAutoLoadConfig() {
        const { config } = this.editor.state;
        const { start, end, maxFrames } = this.getAutoLoadConfig();
        config.autoLoadStartFrame = start + 1;
        config.autoLoadEndFrame = end + 1;
        config.autoLoadMaxFrames = maxFrames;
        this.trimCache();
        this.load();
    }

    getEligibleIndices(fromIndex: number, applyTrackFilter: boolean = true): number[] {
        const { frames } = this.editor.state;
        const { start, end } = this.getAutoLoadConfig();
        let indices: number[] = [];
        for (let index = start; index <= end; index++) indices.push(index);

        if (applyTrackFilter && this.editor.isTrackFrameFilterActive()) {
            const trackIndices = new Set(
                this.editor.trackManager.getTrackFrameIndices(this.editor.currentTrack),
            );
            indices = indices.filter((index) => trackIndices.has(index));
        }

        if (this.loadMode === 'near_2') {
            if (fromIndex < start || fromIndex > end) return [];
            if (applyTrackFilter && this.editor.isTrackFrameFilterActive()) {
                indices.sort((a, b) => Math.abs(a - fromIndex) - Math.abs(b - fromIndex));
                return indices.slice(0, 3);
            }
            return indices.filter((index) => Math.abs(index - fromIndex) <= 1);
        }

        return indices;
    }

    getTargetIndices(fromIndex: number, applyTrackFilter: boolean = true): number[] {
        const indices = orderPrefetchIndices(
            this.getEligibleIndices(fromIndex, applyTrackFilter),
            fromIndex,
            this.prefetchDirection,
        );
        if (this.loadMode === 'all') {
            return indices.slice(0, this.getAutoLoadConfig().maxFrames);
        }
        return indices;
    }

    isFrameProtected(index: number): boolean {
        const frame = this.editor.state.frames[index];
        if (!frame) return true;
        return (
            index === this.editor.state.frameIndex ||
            frame.needSave === true ||
            this.loaders.some((loader) => loader.data.id === frame.id)
        );
    }

    releaseResource(resource: IDataResource) {
        resource.pointsData = {};
        resource.viewConfig.forEach((view) => {
            const image = view.imgObject;
            if (image) {
                image.onload = null;
                image.onerror = null;
                image.onabort = null;
                image.src = '';
            }
            (view as any).imgObject = undefined;
        });
    }

    unloadFrame(index: number): boolean {
        const frame = this.editor.state.frames[index];
        if (!frame || this.isFrameProtected(index)) return false;
        const resource = this.dataMap[frame.id];
        if (!resource) return false;
        this.backgroundControllers.get(frame.id)?.abort();
        this.backgroundControllers.delete(frame.id);
        this.releaseResource(resource);
        delete this.dataMap[frame.id];
        this.editor.performanceMonitor.record('resource-cache-evict', frame.id, { bytes: resource.byteSize });
        if (frame.loadState === 'complete') frame.loadState = '';
        return true;
    }

    trimCache(fromIndex: number = this.editor.state.frameIndex) {
        // Track filtering controls navigation and what to prefetch, but must not
        // evict resources that were already auto-loaded for other frames.
        const targetIndices = new Set(this.getTargetIndices(fromIndex, false));
        const loadedIndices = this.editor.state.frames
            .map((frame, index) => (this.dataMap[frame.id] ? index : -1))
            .filter((index) => index >= 0);

        const overBudget = () => Object.values(this.dataMap).reduce(
            (sum, resource) => sum + (resource.byteSize || this.getResourceByteSize(resource)),
            0,
        ) > this.cacheBudget;

        orderEvictionCandidates(loadedIndices.map((index) => ({
            index,
            distance: Math.abs(index - fromIndex),
            time: this.dataMap[this.editor.state.frames[index].id]?.time || 0,
            protected: this.isFrameProtected(index),
            targeted: targetIndices.has(index),
        }))).forEach(({ index }) => this.unloadFrame(index));

        // The configured auto-load window is an explicit user request.  Do not silently
        // shrink it just because its point clouds exceed the general cache budget: that
        // made a requested 90-frame window retain only roughly 30 frames.  Resources
        // outside the window have already been evicted above.
        if (overBudget()) {
            orderEvictionCandidates(loadedIndices.map((index) => ({
                index,
                distance: Math.abs(index - fromIndex),
                time: this.dataMap[this.editor.state.frames[index].id]?.time || 0,
                protected: this.isFrameProtected(index),
                targeted: targetIndices.has(index),
            }))).some(({ index }) => {
                    this.unloadFrame(index);
                    return !overBudget();
                });
        }
    }

    load(fromIndex?: number) {
        let { frameIndex } = this.editor.state;
        if (this.loaders.length >= DataResource.MAX_CONCURRENT_LOADERS) return;

        fromIndex = fromIndex ?? frameIndex;
        fromIndex = fromIndex < 0 ? 0 : fromIndex;
        this.trimCache(fromIndex);

        let data = this.getNext(fromIndex);

        if (!data) {
            console.log('load complete');
            return;
        }

        this.loadNext(data);
        // Fill the second prefetch slot without serialising neighbor downloads.
        if (this.loaders.length < DataResource.MAX_CONCURRENT_LOADERS) this.load(fromIndex);
    }

    getNext(fromIndex: number) {
        let { frames } = this.editor.state;

        let hasLoader = {} as Record<string, boolean>;
        this.loaders.forEach((e) => {
            hasLoader[e.data.id] = true;
        });

        const nextDataIndex =
            this.getTargetIndices(fromIndex).find((index) => {
                const data = frames[index];
                return data?.loadState === '' && !hasLoader[data.id];
            }) ?? -1;

        console.log('nextDataIndex', nextDataIndex);

        if (nextDataIndex < 0) return null;
        else return frames[nextDataIndex];
    }

    getResource(data: IFrame) {
        let resource = this.dataMap[data.id];
        if (resource) {
            resource.time = Date.now();
            this.editor.performanceMonitor.record('resource-cache-hit', data.id, { bytes: resource.byteSize });
            this.scheduleFullUpgrade(data, resource, this.generation);
            return resource;
        }
        this.editor.performanceMonitor.record('resource-cache-miss', data.id);
        return this.loadNext(data, true);
    }

    setResource(data: IFrame, resource: IDataResource) {
        this.dataMap[data.id] = resource;
    }

    loadNext(data: IFrame, manual: boolean = false) {
        let oldLoader = this.loaders.find((e) => e.data.id === data.id);
        if (this.loaders.length > 0 && oldLoader) {
            if (manual) oldLoader.manual = true;
            return oldLoader;
        }

        let loader = new ResourceLoader(this, data);
        loader.manual = manual;
        this.loaders.push(loader);
        loader.load();

        return loader;
    }
}
