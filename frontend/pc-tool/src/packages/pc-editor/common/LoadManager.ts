import Editor from '../Editor';
import * as utils from '../utils';
import * as THREE from 'three';
import { IFrame, IObject, IDataResource, IUserData, Const } from '../type';
import { ResourceLoader } from './DataResource';
import { AnnotateObject } from 'pc-render';
import Event from '../config/event';

export default class LoadManager {
    editor: Editor;

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

        // The current selection belongs to the outgoing frame. Clear it before
        // mounting the next frame's annotations so render views never fit a detached object.
        this.editor.pc.selectObject();
        this.editor.state.frameIndex = index;

        this.editor.actionManager.stopCurrentAction();

        showLoading && this.editor.showLoading(true);
        try {
            await this.editor.getResultSources();
            await Promise.all([this.loadObjectAndClassification(), this.loadResource()]);
            this.editor.dataResource.load(index);
        } catch (error: any) {
            this.editor.handleErr(error);
        }

        if (currentTrack) this.editor.selectByTrackId(currentTrack);
        else this.editor.pc.selectObject();

        showLoading && this.editor.showLoading(false);
        this.editor.setCurrentTrack(currentTrack, currentTrackName);
        this.editor.dispatchEvent({ type: Event.FRAME_CHANGE, data: this.editor.state.frameIndex });
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

    async loadObjectAndClassification() {
        let { frameIndex, frames, classifications } = this.editor.state;
        let frame = frames[frameIndex];
        if (!frame?.id) {
            this.editor.handleErr(
                new Error(`Frame id is missing at index ${frameIndex}`),
                this.editor.lang('load-object-error'),
            );
            return;
        }

        let cachedObjects = this.editor.dataManager.getFrameObject(frame.id);
        // LiDAR Fusion "Sync Mode": a tracked object edited in *any* frame of the Scene can
        // change what this frame's data should look like at any time (see TrackSyncUseCase on
        // the backend). The client only proactively pushes the propagated result into frames
        // that happen to already be cached in this session (see Editor.refreshTrackFromServer) -
        // if this frame was never touched during that push (e.g. the session was reloaded, or it
        // simply hadn't been visited yet when the sync ran), its cached copy - if any - can be
        // stale. So for sync-mode datasets, always re-fetch from the server on navigation rather
        // than trusting whatever is already cached, unless this frame has unsaved local edits
        // (in which case re-fetching would blow those away).
        const bsState = (this.editor as any).bsState;
        let forceRefetch =
            (!!bsState?.syncMode || !!bsState?.inferenceMode) && !frame.needSave;
        const shouldLoad = cachedObjects === undefined || forceRefetch;
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
                this.editor.dataManager.updateFrameId(frame.id);
                if (this.editor.state.isSeriesFrame) {
                    this.editor.trackManager.addTrackCount(annotates, frame);
                }
                if (bsState?.inferenceMode) this.updateTrackMap();
            } catch (error: any) {
                this.editor.handleErr(error, this.editor.lang('load-object-error'));
            }
        }
        // console.log(annotates);

        // this.editor.reset();
        this.editor.state.filterActive = [];
        // this.editor.dataManager.setFilterFromData();
        this.editor.dataManager.loadDataFromManager();
        this.editor.updateIDCounter();
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
    async loadAllObjects() {
        let { frames, isSeriesFrame, classifications } = this.editor.state;

        let filterFrames = frames.filter((e) => !this.editor.dataManager.getFrameObject(e.id));

        if (filterFrames.length === 0) return;

        try {
            let data = await this.editor.businessManager.getFrameObject(filterFrames);
            if (isSeriesFrame) this.setTrackData(data.objectsMap);

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

    async loadResource() {
        let { frames, frameIndex } = this.editor.state;
        let frame = frames[frameIndex];

        let resource = this.editor.dataResource.getResource(frame);
        if (resource instanceof ResourceLoader) {
            console.log('load Resource');
            resource.onProgress = (ratio: number) => {
                let percent = (ratio * 100).toFixed(2);
                this.editor.showLoading({
                    type: 'loading',
                    content: `${this.editor.lang('load-point')}${percent}%`,
                });
            };
            return resource
                .get()
                .then((data) => {
                    this.setResource(data);
                })
                .catch((e) => {
                    this.editor.handleErr(e, this.editor.lang('load-resource-error'));
                });
        } else {
            this.setResource(resource);
        }
    }

    setResource(data: IDataResource) {
        this.editor.viewManager.setImgViews(data.viewConfig);
        // if (!this.playManger.playing) this.editor.setImgViews(data.viewConfig);
        // this.editor.setPointCloudData(data.pointsData, 0);
        this.editor.setPointCloudData(data.pointsData, data.ground || 0, data.intensityRange);
    }
}
