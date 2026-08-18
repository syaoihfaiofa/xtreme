import { IDataResource, IFrame, IFileConfig, PointAttr } from '../type';
import { PCDLoader } from 'pc-render';
import Editor from '../Editor';
// import * as api from '../api';
import * as utils from '../utils';
import Event from '../config/event';
import { IImgViewConfig } from 'pc-editor';

export type LoadMode = 'near_2' | 'all';
export class ResourceLoader {
    manual: boolean = false;
    data: IFrame;
    dataResource: DataResource;
    generation: number;
    promise: Promise<IDataResource> = {} as Promise<IDataResource>;
    constructor(dataResource: DataResource, data: IFrame) {
        this.data = data;
        this.dataResource = dataResource;
        this.generation = dataResource.generation;
        this.handleProgress = this.handleProgress.bind(this);
    }
    remove() {
        this.dataResource.loaders = this.dataResource.loaders.filter(
            (e) => e.data.id !== this.data.id,
        );

        if (this.dataResource.isGenerationCurrent(this.generation)) {
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
    load() {
        let promise: Promise<IDataResource> = new Promise(async (resolve, reject) => {
            try {
                let config = this.dataResource.dataMap[this.data.id];
                this.data.loadState = 'loading';

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

                if (config.viewConfig.length > 0) {
                    // if (!import.meta.env.DEV) {
                    await this.dataResource.loadImage(config.viewConfig);
                    // }
                }

                let pointsData = await this.dataResource.loadPoints(
                    config.pointsUrl,
                    this.handleProgress,
                );

                let pointsInfo = this.dataResource.calculatePointInfo(pointsData);

                config.time = Date.now();
                config.pointsData = pointsData;
                config.ground = pointsInfo.ground;
                config.intensityRange = pointsInfo.intensityRange;

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
                resolve(config);
            } catch (e) {
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
    loadMode: LoadMode = 'near_2';
    editor: Editor;
    dataMap: Record<string, IDataResource> = {};
    loaders: ResourceLoader[] = [];
    pointsLoader: PCDLoader = new PCDLoader();
    generation: number = 0;
    constructor(editor: Editor) {
        this.editor = editor;
    }

    clear() {
        this.generation += 1;
        Object.values(this.dataMap).forEach((resource) => this.releaseResource(resource));
        this.dataMap = {};
        this.loaders = [];
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

    async loadPoints(pointsUrl: string, onProgress?: (percent: number) => void): Promise<any> {
        return new Promise((resolve, reject) => {
            this.pointsLoader.load(
                pointsUrl,
                (data: any) => {
                    resolve(data);
                },
                (e) => {
                    if (onProgress) onProgress(e.loaded / e.total);
                },
                () => {
                    reject();
                },
            );
        });
    }

    setLoadMode(mode: LoadMode) {
        this.loadMode = mode;
        this.editor.state.config.autoLoad = mode === 'all';
        this.trimCache();
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
        const indices = this.getEligibleIndices(fromIndex, applyTrackFilter).sort((a, b) => {
            const distance = Math.abs(a - fromIndex) - Math.abs(b - fromIndex);
            return distance || a - b;
        });
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
        this.releaseResource(resource);
        delete this.dataMap[frame.id];
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

        loadedIndices
            .filter((index) => !targetIndices.has(index))
            .sort((a, b) => {
                const distance = Math.abs(b - fromIndex) - Math.abs(a - fromIndex);
                if (distance) return distance;
                const aTime = this.dataMap[this.editor.state.frames[a].id]?.time || 0;
                const bTime = this.dataMap[this.editor.state.frames[b].id]?.time || 0;
                return aTime - bTime;
            })
            .forEach((index) => this.unloadFrame(index));
    }

    load(fromIndex?: number) {
        let { frameIndex } = this.editor.state;
        if (this.loaders.length > 0) return;

        fromIndex = fromIndex ?? frameIndex;
        fromIndex = fromIndex < 0 ? 0 : fromIndex;
        this.trimCache(fromIndex);

        let data = this.getNext(fromIndex);

        if (!data) {
            console.log('load complete');
            return;
        }

        this.loadNext(data);
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
            return resource;
        }
        return this.loadNext(data, true);
    }

    setResource(data: IFrame, resource: IDataResource) {
        this.dataMap[data.id] = resource;
    }

    loadNext(data: IFrame, manual: boolean = false) {
        let oldLoader = this.loaders.find((e) => e.data.id === data.id);
        if (this.loaders.length > 0 && oldLoader) return oldLoader;

        let loader = new ResourceLoader(this, data);
        loader.manual = manual;
        this.loaders.push(loader);
        loader.load();

        return loader;
    }
}
