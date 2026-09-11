import Editor from '../Editor';
import * as utils from '../utils';
import * as THREE from 'three';
import { IFrame, IObject, IUserData, Const } from '../type';
import { ResourceLoader } from './DataResource';
import { AnnotateObject } from 'pc-render';
import Event from '../config/event';

export default class LoadManager {
    editor: Editor;
    private loadVersion = 0;

    constructor(editor: Editor) {
        this.editor = editor;
    }

    async loadFrame(index: number, showLoading: boolean = true, force: boolean = false) {
        const { isSeriesFrame, frameIndex, frames } = this.editor.state;
        if (index === frameIndex && !force) return;
        if (index > frames.length - 1 || index < 0) return;
        if (!isSeriesFrame) this.editor.cmdManager.reset();
        const currentTrack = this.editor.currentTrack;
        const currentTrackName = this.editor.currentTrackName;
        const frame = frames[index];
        const loadVersion = ++this.loadVersion;
        this.editor.performanceMonitor.start('frame-interactive', frame.id);
        const isCurrentLoad = () => loadVersion === this.loadVersion;

        this.editor.navigatingFrame = true;
        try {
            // The current selection belongs to the outgoing frame. Clear it before
            // mounting the next frame's annotations so render views never fit a detached object.
            this.editor.pc.selectObject();
            this.editor.state.frameIndex = index;
            this.editor.dataResource.activateFrame(frame);

            this.editor.actionManager.stopCurrentAction();

            if (showLoading) this.editor.showLoading(true);
            try {
                await Promise.all([
                    this.editor.getResultSources(frame, isCurrentLoad),
                    this.loadObjectAndClassification(frame, isCurrentLoad),
                    this.loadResource(frame, isCurrentLoad),
                ]);
                if (!isCurrentLoad()) return;
                this.editor.dataResource.load(index);
                this.editor.performanceMonitor.end('frame-interactive', frame.id, {
                    cached: frame.loadState === 'complete',
                });
            } catch (error: any) {
                if (isCurrentLoad()) this.editor.handleErr(error);
            }

            if (!isCurrentLoad()) return;

            if (currentTrack) this.editor.selectByTrackId(currentTrack);
            else this.editor.pc.selectObject();

            if (showLoading && isCurrentLoad()) this.editor.showLoading(false);
            this.editor.setCurrentTrack(currentTrack, currentTrackName);
        } finally {
            if (isCurrentLoad()) this.editor.navigatingFrame = false;
        }
        if (isCurrentLoad()) {
            this.editor.dispatchEvent({ type: Event.FRAME_CHANGE, data: index });
        }
    }

    async loadClassification() {
        let { frameIndex, frames, classifications } = this.editor.state;
        let frame = frames[frameIndex];

        // console.log('loadClassification', this.playManger.playing);

        if (
            classifications.length > 0 &&
            (!frame.classifications || frame.classifications.length === 0)
        ) {
            try {
                // let valueMap = await api.getDataClassification(frame.id);
                let valueMap = await this.editor.businessManager.getFrameClassification(frame);
                let copClassifications = utils.copyClassification(
                    classifications,
                    valueMap[frame.id] || {},
                );

                frame.classifications = copClassifications;
            } catch (error: any) {
                this.editor.handleErr(error, this.editor.lang('load-classification-error'));
            }
        }
    }

    async loadObjectAndClassification(frame: IFrame, isCurrentLoad: () => boolean) {
        let { classifications } = this.editor.state;
        if (!frame?.id) {
            this.editor.handleErr(
                new Error(`Frame id is missing: ${frame?.id}`),
                this.editor.lang('load-object-error'),
            );
            return;
        }

        let cachedObjects = this.editor.dataManager.getFrameObject(frame.id);
        // LiDAR Fusion sync updates every cached affected frame from the sync response. A frame
        // not in this in-memory cache is fetched normally on first entry, so a cache hit does not
        // need another annotation request merely because sync mode is enabled.
        const bsState = (this.editor as any).bsState;
        const shouldLoad =
            cachedObjects === undefined ||
            !this.editor.dataManager.hasCompleteFrameObjects(frame.id) ||
            (!!bsState?.inferenceMode && !frame.needSave);
        if (shouldLoad) {
            try {
                if (cachedObjects && cachedObjects.length > 0 && this.editor.state.isSeriesFrame) {
                    this.editor.trackManager.removeTrackCount(cachedObjects, frame);
                }
                let data = await this.editor.businessManager.getFrameObject(frame);
                frame.queryTime = data.queryTime;
                // this.setTrackData(data.objectsMap);

                frame.classifications = utils.copyClassification(
                    classifications,
                    utils.lookupByFrameId(data.classificationMap, frame.id) || {},
                );

                let objects = utils.objectsMapForFrame(data.objectsMap, frame.id);
                let annotates = utils.convertObject2Annotate(objects, this.editor);
                this.editor.dataManager.setFrameObject(frame.id, annotates);
                this.editor.dataManager.markFrameObjectsComplete(frame.id);
                this.editor.dataManager.updateFrameId(frame.id);
                if (this.editor.state.isSeriesFrame) {
                    this.editor.trackManager.addTrackCount(annotates, frame);
                }
                if (bsState?.inferenceMode) this.updateTrackMap();
            } catch (error: any) {
                if (isCurrentLoad()) {
                    this.editor.handleErr(error, this.editor.lang('load-object-error'));
                }
            }
        }
        // console.log(annotates);

        // this.editor.reset();
        if (isCurrentLoad()) this.editor.state.filterActive = [];
        // this.editor.dataManager.setFilterFromData();
        if (isCurrentLoad()) {
            this.editor.dataManager.loadDataFromManager();
            this.editor.updateIDCounter();
        }
        // this.editor.pc.addObject(annotates);
    }
    updateTrackMap(frames?: IFrame[]) {
        const { state } = this.editor;
        frames = frames || state.frames;
        const objectMap: Record<string, IObject[]> = {};
        this.editor.trackManager.trackInfo.clear();
        frames.forEach((frame) => {
            const objects = this.editor.dataManager.getFrameObject(frame.id) || [];
            this.editor.trackManager.addTrackCount(objects, frame);
            objectMap[frame.id] = objects.map((e) => e.userData as IObject);
        });
        this.setTrackData(objectMap);
    }
    setTrackData(objectsMap: Record<string, IObject[]>) {
        // update trackId
        Object.keys(objectsMap).forEach((frameId) => {
            const objects = objectsMap[frameId] || [];
            objects.forEach((obj) => {
                if (!obj.trackId) obj.trackId = this.editor.createTrackId();
            });
        });

        const trackInfo = utils.getTrackFromObject(objectsMap);
        const objects = Object.keys(trackInfo.globalTrack).map((id) => trackInfo.globalTrack[id]);
        // update editor Id
        const maxId = getMaxId(objects);
        let startId = maxId + 1;
        objects.forEach((e) => {
            if (!e.trackName) e.trackName = startId++ + '';
        });
        this.editor.idCount = startId;
        this.editor.trackManager.trackMap.clear();
        Object.keys(trackInfo.globalTrack).forEach((trackId) => {
            this.editor.trackManager.addTrackObject(trackId, trackInfo.globalTrack[trackId]);
        });

        function getMaxId(objects: Partial<IObject>[]) {
            let maxId = 0;
            objects.forEach((e) => {
                if (!e.trackName) return;
                const id = parseInt(e.trackName);
                if (id > maxId) maxId = id;
            });
            return maxId;
        }
    }

    /**
     * Add metadata for newly fetched frames without discarding tracks that were already loaded
     * elsewhere in the Scene. This is used by Track's target-frame preload.
     */
    mergeTrackData(objectsMap: Record<string, IObject[]>) {
        Object.values(objectsMap).forEach((objects) => {
            objects.forEach((object) => {
                if (!object.trackId) object.trackId = this.editor.createTrackId();
            });
        });

        const trackInfo = utils.getTrackFromObject(objectsMap);
        const newTracks = Object.values(trackInfo.globalTrack);
        let maxId = 0;
        this.editor.trackManager.trackMap.forEach((track) => {
            const id = parseInt(track.trackName || '', 10);
            if (Number.isFinite(id)) maxId = Math.max(maxId, id);
        });
        newTracks.forEach((track) => {
            const id = parseInt(track.trackName || '', 10);
            if (Number.isFinite(id)) maxId = Math.max(maxId, id);
        });

        let nextId = maxId + 1;
        Object.entries(trackInfo.globalTrack).forEach(([trackId, track]) => {
            if (!track.trackName) track.trackName = `${nextId++}`;
            this.editor.trackManager.addTrackObject(trackId, track);
        });
        this.editor.idCount = Math.max(this.editor.idCount, nextId);
    }
    async loadAllClassification() {
        let { frames, classifications } = this.editor.state;

        if (frames.length === 0) return;

        try {
            // let valueMap = await api.getDataClassification(ids);
            let valueMap = await this.editor.businessManager.getFrameClassification(frames);

            frames.forEach((frame) => {
                let newClassifications = utils.copyClassification(
                    classifications,
                    valueMap[frame.id] || {},
                );

                frame.classifications = newClassifications;
            });
        } catch (error: any) {
            this.editor.handleErr(error, this.editor.lang('load-classification-error'));
        }
    }

    // SeriesFrame load
    async loadAllObjects(framesToLoad?: IFrame[]) {
        let { frames, isSeriesFrame, classifications } = this.editor.state;

        // Tracking can write its propagated object into a target frame before that frame has
        // ever been opened.  Callers may therefore preload only the target frames, so their
        // existing server annotations are merged with the propagated box instead of being
        // mistaken for an already-complete local cache.
        const candidateFrames = framesToLoad || frames;
        let filterFrames = candidateFrames.filter(
            (frame) =>
                !this.editor.dataManager.getFrameObject(frame.id) ||
                !this.editor.dataManager.hasCompleteFrameObjects(frame.id),
        );

        if (filterFrames.length === 0) return;

        try {
            let data = await this.editor.businessManager.getFrameObject(filterFrames);
            if (isSeriesFrame) {
                if (framesToLoad) this.mergeTrackData(data.objectsMap);
                else this.setTrackData(data.objectsMap);
            }

            filterFrames.forEach((frame) => {
                let objects = utils.objectsMapForFrame(data.objectsMap, frame.id);
                frame.queryTime = data.queryTime;

                frame.classifications = utils.copyClassification(
                    classifications,
                    utils.lookupByFrameId(data.classificationMap, frame.id) || {},
                );

                let annotates = utils.convertObject2Annotate(objects, this.editor);
                annotates.forEach((obj) => {
                    let userData = obj.userData as IUserData;
                    if (!userData.id) userData.id = THREE.MathUtils.generateUUID();
                });
                this.editor.dataManager.setFrameObject(frame.id, annotates);
                this.editor.dataManager.markFrameObjectsComplete(frame.id);
            });
            if (isSeriesFrame) this.editor.trackManager.rebuildTrackCountCaches();
        } catch (error: any) {
            this.editor.handleErr(error, this.editor.lang('load-object-error'));
        }
    }

    // setTrackData(objectsMap: Record<string, IObject[]>) {
    //     // update trackId
    //     Object.keys(objectsMap).forEach((frameId) => {
    //         let objects = objectsMap[frameId] || [];
    //         objects.forEach((obj) => {
    //             if (!obj.trackId) obj.trackId = this.editor.createTrackId();
    //         });
    //     });

    //     let trackInfo = utils.getTrackFromObject(objectsMap);
    //     let objects = Object.keys(trackInfo.globalTrack).map((id) => trackInfo.globalTrack[id]);
    //     // update editor Id
    //     let maxId = getMaxId(objects);
    //     let startId = maxId + 1;
    //     objects.forEach((e) => {
    //         if (!e.trackName) e.trackName = startId++ + '';
    //     });
    //     this.editor.idCount = startId;

    //     Object.keys(trackInfo.globalTrack).forEach((trackId) => {
    //         this.editor.trackManager.addTrackObject(trackId, trackInfo.globalTrack[trackId]);
    //     });

    //     function getMaxId(objects: Partial<IObject>[]) {
    //         let maxId = 0;
    //         objects.forEach((e) => {
    //             if (!e.trackName) return;
    //             let id = parseInt(e.trackName);
    //             if (id > maxId) maxId = id;
    //         });
    //         return maxId;
    //     }
    // }

    async loadResource(frame: IFrame, isCurrentLoad: () => boolean) {

        let resource = this.editor.dataResource.getResource(frame);
        if (resource instanceof ResourceLoader) {
            console.log('load Resource');
            resource.onProgress = (ratio: number) => {
                if (!isCurrentLoad()) return;
                let percent = (ratio * 100).toFixed(2);
                this.editor.showLoading({
                    type: 'loading',
                    content: `${this.editor.lang('load-point')}${percent}%`,
                });
            };
            return resource
                .get()
                .then((data) => {
                    if (isCurrentLoad()) this.setResource(data);
                })
                .catch((e) => {
                    if (isCurrentLoad()) {
                        this.editor.handleErr(e, this.editor.lang('load-resource-error'));
                    }
                });
        } else {
            if (isCurrentLoad()) this.setResource(resource);
        }
    }

    setResource(data: IDataResource) {
        this.editor.viewManager.setImgViews(data.viewConfig);
        // if (!this.playManger.playing) this.editor.setImgViews(data.viewConfig);
        // this.editor.setPointCloudData(data.pointsData, 0);
        this.editor.setPointCloudData(data.pointsData, data.ground || 0, data.intensityRange);
    }
}
