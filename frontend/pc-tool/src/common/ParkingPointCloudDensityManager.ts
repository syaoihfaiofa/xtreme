import * as THREE from 'three';
import { ColorModeEnum, Event } from 'pc-editor';
import * as api from '../api';
import type Editor from './Editor';

type NeighborStyle = 'rgb' | 'gray' | 'same';

interface PointData {
    position?: ArrayLike<number>;
    color?: ArrayLike<number>;
    intensity?: ArrayLike<number>;
}

interface GroundPointData {
    position: Float32Array;
    color: Uint8Array;
    intensity: Float32Array;
}

interface RgbDisplayConfig {
    brightness: number;
    rgbEnhance: boolean;
    rgbEnhanceRadius: number;
    rgbEnhanceContrast: number;
    rgbEnhanceMinBrightness: number;
    rgbLocalContrast: boolean;
    rgbLocalContrastStrength: number;
    rgbHighlightBoost: boolean;
    rgbHighlightThreshold: number;
    rgbHighlightStrength: number;
}

interface CachedGroundFrame {
    data?: GroundPointData;
    promise?: Promise<GroundPointData | null>;
    lastUsed: number;
}

/**
 * A display-only helper for parking-slot annotation.  It never enters DataManager,
 * so overlay points cannot be selected, saved, synced, or included in undo history.
 */
export default class ParkingPointCloudDensityManager {
    private readonly overlay = new THREE.Group();
    private readonly groundOverlay = new THREE.Group();
    private readonly neighbourOverlay = new THREE.Group();
    private generation = 0;
    private controller?: AbortController;
    private lastStatus = '';
    private overlayKey = '';
    private loadingKey = '';
    // A sliding cache stores only ground points, not complete source clouds.  On
    // a one-frame move nearly the whole ±N window can therefore be reused.
    private readonly groundFrameCache = new Map<string, CachedGroundFrame>();
    private readonly poseCache = new Map<string, api.IScenePose>();
    private readonly cacheControllers = new Map<string, AbortController>();
    private readonly pointUrlCache = new Map<string, string | null>();
    private static readonly MAX_CACHED_GROUND_FRAMES = 12;

    constructor(private readonly editor: Editor) {
        this.overlay.name = 'parking-rgb-neighbour-points';
        this.groundOverlay.name = 'parking-rgb-ground-density';
        this.neighbourOverlay.name = 'parking-rgb-neighbour-density';
        this.overlay.add(this.groundOverlay, this.neighbourOverlay);
        this.editor.pc.scene.add(this.overlay);
        this.editor.addEventListener(Event.FRAME_CHANGE, () => this.refresh());
        this.editor.addEventListener(Event.RESOURCE_LOAD_COMPLETE, () => this.refresh());
        this.editor.addEventListener(Event.ANNOTATE_SELECT, () => this.refresh());
    }

    destroy(): void {
        this.generation++;
        this.controller?.abort();
        this.controller = undefined;
        this.clearGroup(this.groundOverlay);
        this.clearGroup(this.neighbourOverlay);
        this.clearFrameCache();
        this.editor.pc.scene.remove(this.overlay);
    }

    isParkingRgbContext(): boolean {
        // Density is a RGB display aid.  It is useful before a parking slot is
        // created too, when the annotator is first locating its boundary.
        return this.editor.state.config.pointColorMode === ColorModeEnum.RGB;
    }

    refresh(): void {
        const config = this.editor.state.config as any;
        const active = this.isParkingRgbContext();
        config.parkingDensityAvailable = active;
        this.applyGroundDensify(active && config.parkingDensityGround === true);

        if (!active || config.parkingDensityMotion !== true) {
            this.cancelNeighbours();
            this.clearFrameCache();
            return;
        }
        const key = this.getOverlayKey();
        if (this.overlayKey === key || this.loadingKey === key) return;
        void this.loadNeighbours(key);
    }

    private cancelNeighbours(): void {
        this.generation++;
        this.controller?.abort();
        this.controller = undefined;
        this.overlayKey = '';
        this.loadingKey = '';
        this.clearGroup(this.neighbourOverlay);
        this.editor.pc.render();
    }

    private applyGroundDensify(enabled: boolean): void {
        this.clearGroup(this.groundOverlay);
        if (enabled) {
            const config = this.editor.state.config as any;
            const visualConfig = {
                ...config,
                parkingDensityStyle: 'same',
                // One shared size rule for the main view and every side view:
                // changing either control updates all of them.
                pointSize: (Number(config.pointSize) || 0.1) *
                    (Number(config.parkingDensityGroundScale) || 1),
            };
            this.editor.pc.groupPoints.children.forEach((child) => {
                const geometry = (child as THREE.Points).geometry as THREE.BufferGeometry;
                const position = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
                if (!position?.count) return;
                const points = createGroundOverlay({
                    position: position.array,
                    color: (geometry.getAttribute('color') as THREE.BufferAttribute | undefined)?.array,
                    intensity: (geometry.getAttribute('intensity') as THREE.BufferAttribute | undefined)?.array,
                }, new THREE.Matrix4(), visualConfig);
                if (points) this.groundOverlay.add(points);
            });
        }
        this.editor.pc.render();
    }

    private getOverlayKey(): string {
        const config = this.editor.state.config as any;
        return [
            this.editor.getCurrentFrame()?.id,
            config.parkingDensityFrameCount,
            config.parkingDensityStyle,
            config.parkingDensityOpacity,
            config.pointSize,
            config.brightness,
            config.rgbEnhance,
            config.rgbEnhanceRadius,
            config.rgbEnhanceContrast,
        ].join('|');
    }

    private async loadNeighbours(key: string): Promise<void> {
        const generation = ++this.generation;
        this.controller?.abort();
        const controller = new AbortController();
        this.controller = controller;
        this.loadingKey = key;
        this.clearGroup(this.neighbourOverlay);

        const frames = this.editor.state.frames;
        const currentIndex = this.editor.state.frameIndex;
        const count = Math.max(0, Math.min(5, Number((this.editor.state.config as any).parkingDensityFrameCount) || 0));
        const neighbourFrames = frames.filter((_, index) => index !== currentIndex && Math.abs(index - currentIndex) <= count);
        if (!neighbourFrames.length) {
            this.overlayKey = key;
            this.loadingKey = '';
            return;
        }
        const current = frames[currentIndex];
        try {
            const poses = await this.getCachedPoses([current.id, ...neighbourFrames.map((frame) => frame.id)]);
            if (generation !== this.generation || controller.signal.aborted) return;
            const currentPose = poses[String(current.id)];
            if (!currentPose) {
                this.showStatus('当前帧没有 location 位姿，无法进行运动补偿');
                return;
            }
            const currentInverse = poseMatrix(currentPose).invert();
            const loaded = await Promise.all(neighbourFrames.map(async (frame) => {
                const pose = poses[String(frame.id)];
                if (!pose) return null;
                try {
                    const data = await this.getCachedGroundFrame(String(frame.id));
                    if (!data || controller.signal.aborted) return null;
                    return { data, matrix: currentInverse.clone().multiply(poseMatrix(pose)) };
                } catch (error) {
                    // One unavailable neighbour must not discard already cached
                    // neighbours or delay the current-frame point cloud.
                    console.warn(`parking density frame ${frame.id} unavailable`, error);
                    return null;
                }
            }));
            if (generation !== this.generation || controller.signal.aborted) return;
            let added = 0;
            loaded.forEach((entry) => {
                if (!entry) return;
                const points = createGroundOverlayFromGround(
                    entry.data,
                    entry.matrix,
                    this.editor.state.config as any,
                );
                if (!points) return;
                this.neighbourOverlay.add(points);
                added++;
            });
            this.overlayKey = key;
            this.loadingKey = '';
            this.editor.pc.render();
            this.showStatus(added ? `停车位密集：已补偿 ${added} 帧地面点` : '附近帧没有可用的地面点或位姿');
        } catch (error) {
            if (!controller.signal.aborted) {
                console.warn('load parking density neighbours failed', error);
                this.showStatus('邻帧点云加载失败，已保留当前帧显示');
            }
        } finally {
            if (this.loadingKey === key) this.loadingKey = '';
        }
    }

    private clearGroup(group: THREE.Group): void {
        while (group.children.length) {
            const points = group.children[group.children.length - 1] as THREE.Points;
            group.remove(points);
            (points.geometry as THREE.BufferGeometry).dispose();
            (points.material as THREE.Material).dispose();
        }
    }

    private async getCachedPoses(frameIds: Array<string | number>): Promise<Record<string, api.IScenePose>> {
        const missing = frameIds.filter((id) => !this.poseCache.has(String(id)));
        if (missing.length) {
            const poses = await api.getScenePoses(missing);
            Object.entries(poses).forEach(([id, pose]) => this.poseCache.set(id, pose));
        }
        return frameIds.reduce((result, id) => {
            const pose = this.poseCache.get(String(id));
            if (pose) result[String(id)] = pose;
            return result;
        }, {} as Record<string, api.IScenePose>);
    }

    private getCachedGroundFrame(frameId: string): Promise<GroundPointData | null> {
        const cached = this.groundFrameCache.get(frameId);
        if (cached?.data) {
            cached.lastUsed = Date.now();
            return Promise.resolve(cached.data);
        }
        if (cached?.promise) return cached.promise;

        const controller = new AbortController();
        this.cacheControllers.set(frameId, controller);
        const entry: CachedGroundFrame = { lastUsed: Date.now() };
        entry.promise = this.loadGroundFrame(frameId, controller.signal)
            .then((data) => {
                entry.data = data || undefined;
                entry.lastUsed = Date.now();
                entry.promise = undefined;
                this.cacheControllers.delete(frameId);
                this.trimFrameCache();
                return data;
            })
            .catch((error) => {
                this.cacheControllers.delete(frameId);
                this.groundFrameCache.delete(frameId);
                throw error;
            });
        this.groundFrameCache.set(frameId, entry);
        return entry.promise;
    }

    private async loadGroundFrame(frameId: string, signal: AbortSignal): Promise<GroundPointData | null> {
        let url = this.pointUrlCache.get(frameId);
        if (url === undefined) {
            const { configs } = await api.getDataFile(frameId);
            const pointFile = configs.find((file) => /point(_?)cloud/i.test(file.dirName));
            url = pointFile?.url || null;
            this.pointUrlCache.set(frameId, url);
        }
        if (!url) return null;
        const data = await this.editor.dataResource.loadPoints(url, undefined, signal, frameId, 'full');
        return extractGroundPoints(data);
    }

    private trimFrameCache(): void {
        const completed = [...this.groundFrameCache.entries()]
            .filter(([, entry]) => entry.data && !entry.promise)
            .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
        while (completed.length > ParkingPointCloudDensityManager.MAX_CACHED_GROUND_FRAMES) {
            const [frameId] = completed.shift()!;
            this.groundFrameCache.delete(frameId);
        }
    }

    private clearFrameCache(): void {
        this.cacheControllers.forEach((controller) => controller.abort());
        this.cacheControllers.clear();
        this.groundFrameCache.clear();
        this.pointUrlCache.clear();
        this.poseCache.clear();
    }

    private showStatus(message: string): void {
        if (message === this.lastStatus) return;
        this.lastStatus = message;
        this.editor.showMsg('info' as any, message, 3);
    }
}

function poseMatrix(pose: api.IScenePose): THREE.Matrix4 {
    const rotation = new THREE.Euler(Number(pose.roll) || 0, Number(pose.pitch) || 0, Number(pose.yaw) || 0, 'XYZ');
    return new THREE.Matrix4().makeRotationFromEuler(rotation).setPosition(
        Number(pose.posX) || 0,
        Number(pose.posY) || 0,
        Number(pose.posZ) || 0,
    );
}

/** Local lowest-surface test, rather than a global Z threshold, so sloped roads remain ground. */
function groundMask(position: ArrayLike<number>, count: number): Float32Array {
    const cellSize = 0.4;
    type GroundCell = { x: number; y: number; z: number };
    const lowest = new Map<string, GroundCell>();
    for (let i = 0; i < count; i++) {
        const base = i * 3;
        const x = Math.floor(Number(position[base]) / cellSize);
        const y = Math.floor(Number(position[base + 1]) / cellSize);
        const key = `${x}:${y}`;
        const z = Number(position[base + 2]);
        const previous = lowest.get(key);
        if (!Number.isFinite(z)) continue;
        if (!previous || z < previous.z) lowest.set(key, { x, y, z });
    }

    // A vehicle's lowest return is still locally lowest in its own XY cells.  Ground is
    // identified as the low surface connected to the LiDAR neighbourhood, permitting
    // gradual ramps while stopping at the vertical step into a vehicle/kerb/wall.
    const cells = [...lowest.values()];
    const nearby = cells.filter((cell) => Math.hypot(cell.x * cellSize, cell.y * cellSize) <= 4);
    const seedPool = (nearby.length ? nearby : cells).sort((a, b) => a.z - b.z);
    const seedLevel = seedPool[Math.max(0, Math.floor(seedPool.length * 0.2))]?.z;
    const connected = new Set<string>();
    const queue: GroundCell[] = [];
    if (seedLevel !== undefined) {
        cells.forEach((cell) => {
            if (Math.hypot(cell.x * cellSize, cell.y * cellSize) <= 4 && Math.abs(cell.z - seedLevel) <= 0.18) {
                const key = `${cell.x}:${cell.y}`;
                connected.add(key);
                queue.push(cell);
            }
        });
    }
    while (queue.length) {
        const current = queue.shift()!;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const key = `${current.x + dx}:${current.y + dy}`;
                const candidate = lowest.get(key);
                if (!candidate || connected.has(key) || Math.abs(candidate.z - current.z) > 0.12) continue;
                connected.add(key);
                queue.push(candidate);
            }
        }
    }

    const result = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const base = i * 3;
        const key = `${Math.floor(Number(position[base]) / cellSize)}:${Math.floor(Number(position[base + 1]) / cellSize)}`;
        const cell = lowest.get(key);
        if (connected.has(key) && cell && Number(position[base + 2]) <= cell.z + 0.15) result[i] = 1;
    }
    return result;
}

function createGroundOverlay(data: PointData, transform: THREE.Matrix4, config: any): THREE.Points | null {
    const ground = extractGroundPoints(data);
    return ground ? createGroundOverlayFromGround(ground, transform, config) : null;
}

/** Build a compact ground-only representation once, then reuse it across frame moves. */
function extractGroundPoints(data: PointData): GroundPointData | null {
    const source = data.position || [];
    const count = Math.floor(source.length / 3);
    if (!count) return null;
    const mask = groundMask(source, count);
    const positions: number[] = [];
    const colors: number[] = [];
    const intensity: number[] = [];
    for (let index = 0; index < count; index++) {
        if (mask[index] < 0.5) continue;
        const offset = index * 3;
        positions.push(Number(source[offset]), Number(source[offset + 1]), Number(source[offset + 2]));
        const r = Number(data.color?.[offset]) || 0;
        const g = Number(data.color?.[offset + 1]) || 0;
        const b = Number(data.color?.[offset + 2]) || 0;
        colors.push(r, g, b);
        intensity.push(Number(data.intensity?.[index]) || 0);
    }
    if (!positions.length) return null;
    return {
        position: new Float32Array(positions),
        color: new Uint8Array(colors),
        intensity: new Float32Array(intensity),
    };
}

function createGroundOverlayFromGround(
    data: GroundPointData,
    transform: THREE.Matrix4,
    config: any,
): THREE.Points | null {
    const count = Math.floor(data.position.length / 3);
    if (!count) return null;
    const positions = new Float32Array(data.position.length);
    const colors = new Uint8Array(data.color.length);
    const intensity = new Float32Array(data.intensity);
    const localLuminance = calculateLocalLuminance(data);
    const style = String(config.parkingDensityStyle || 'rgb') as NeighborStyle;
    const point = new THREE.Vector3();
    for (let index = 0; index < count; index++) {
        const offset = index * 3;
        point
            .set(data.position[offset], data.position[offset + 1], data.position[offset + 2])
            .applyMatrix4(transform);
        positions[offset] = point.x;
        positions[offset + 1] = point.y;
        positions[offset + 2] = point.z;
        if (style === 'gray') {
            colors[offset] = 185;
            colors[offset + 1] = 185;
            colors[offset + 2] = 185;
        } else {
            const color = applyRgbDisplay(
                data.color[offset],
                data.color[offset + 1],
                data.color[offset + 2],
                point,
                localLuminance[index],
                config,
            );
            colors[offset] = color[0];
            colors[offset + 1] = color[1];
            colors[offset + 2] = color[2];
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Uint8BufferAttribute(colors, 3, true));
    geometry.setAttribute('intensity', new THREE.Float32BufferAttribute(intensity, 1));
    const opacity = style === 'same' ? 1 : Math.max(0.1, Math.min(1, Number(config.parkingDensityOpacity) || 0.35));
    const material = new THREE.PointsMaterial({
        // This is a world-space density aid. Perspective attenuation makes it
        // visible at the same physical scale as nearby cloud returns; side
        // views convert that physical size to pixels before rendering.
        size: Number(config.pointSize) || 0.1,
        vertexColors: true,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity >= 1,
    });
    return new THREE.Points(geometry, material);
}

function applyRgbDisplay(
    red: number,
    green: number,
    blue: number,
    position: THREE.Vector3,
    localLuminance: number,
    config: RgbDisplayConfig,
): [number, number, number] {
    let color = new THREE.Vector3(red, green, blue).multiplyScalar(1 / 255);
    if (config.rgbLocalContrast) {
        const luminance = color.dot(new THREE.Vector3(0.2126, 0.7152, 0.0722));
        const enhancedLuminance = Math.max(
            0,
            Math.min(1, localLuminance + (luminance - localLuminance) * config.rgbLocalContrastStrength),
        );
        color.multiplyScalar(enhancedLuminance / Math.max(luminance, 0.001));
    }
    if (config.rgbEnhance && Math.hypot(position.x, position.y) <= config.rgbEnhanceRadius) {
        const luminance = color.dot(new THREE.Vector3(0.2126, 0.7152, 0.0722));
        const enhancedLuminance = 1 / (1 + Math.exp(-4 * config.rgbEnhanceContrast * (luminance - 0.5)));
        color.multiplyScalar(enhancedLuminance / Math.max(luminance, 0.001));
        color.lerp(new THREE.Vector3(1, 1, 1), config.rgbEnhanceMinBrightness);
    }
    if (config.rgbHighlightBoost) {
        const luminance = color.dot(new THREE.Vector3(0.2126, 0.7152, 0.0722));
        const factor = smoothstep(config.rgbHighlightThreshold, 1, luminance) * config.rgbHighlightStrength;
        color.multiplyScalar(1 + factor);
    }
    color.multiplyScalar(config.brightness).clampScalar(0, 1);
    return [Math.round(color.x * 255), Math.round(color.y * 255), Math.round(color.z * 255)];
}

function smoothstep(min: number, max: number, value: number): number {
    const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
    return normalized * normalized * (3 - 2 * normalized);
}

function calculateLocalLuminance(data: GroundPointData): Float32Array {
    const cellSize = 0.25;
    const heightSize = 0.25;
    const cells = new Map<string, { sum: number; count: number }>();
    const luminance = new Float32Array(data.position.length / 3);
    for (let index = 0; index < luminance.length; index++) {
        const offset = index * 3;
        const value = (
            data.color[offset] * 0.2126
            + data.color[offset + 1] * 0.7152
            + data.color[offset + 2] * 0.0722
        ) / 255;
        luminance[index] = value;
        const key = getLuminanceCellKey(data.position, offset, cellSize, heightSize);
        const cell = cells.get(key);
        if (cell) {
            cell.sum += value;
            cell.count++;
        } else {
            cells.set(key, { sum: value, count: 1 });
        }
    }
    for (let index = 0; index < luminance.length; index++) {
        const cell = cells.get(getLuminanceCellKey(data.position, index * 3, cellSize, heightSize));
        if (cell) luminance[index] = cell.sum / cell.count;
    }
    return luminance;
}

function getLuminanceCellKey(
    position: Float32Array,
    offset: number,
    cellSize: number,
    heightSize: number,
): string {
    return `${Math.floor(position[offset] / cellSize)}:${Math.floor(position[offset + 1] / cellSize)}:${Math.floor(position[offset + 2] / heightSize)}`;
}
