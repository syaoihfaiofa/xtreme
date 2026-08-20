import { IObject, IFrame, IModelResult } from '../type';
import { AnnotateObject, Box, GroundPolygon, GroundPolyline, Rect, Box2D, ITransform, Object2D } from 'pc-render';
import Editor from '../Editor';
import { Event as EditorEvent } from 'pc-editor';
// import * as api from '../api';
import * as utils from '../utils';
import { Const, ICmdName, IFilter, IUserData } from '../type';
import Event from '../config/event';
import * as THREE from 'three';

interface ITransform2DBox {
    positions2?: Record<number, THREE.Vector2>;
    positions1?: Record<number, THREE.Vector2>;
}

interface ITransform2DRect {
    center?: THREE.Vector2;
    size?: THREE.Vector2;
}

export type IAnnotateTransform = ITransform2DBox | ITransform2DRect | ITransform;

export default class DataManager {
    editor: Editor;
    // object
    dataMap: Map<string, AnnotateObject[]> = new Map();
    hasMap: Map<string, Map<string, AnnotateObject>> = new Map();
    private displayCacheFrameKey?: string;
    private displayCacheFrameIndex?: number;

    constructor(editor: Editor) {
        this.editor = editor;
        this.initEvent();
    }

    private normalizeFrameId(frameId: string | number): string {
        return String(frameId);
    }

    private clearDisplayCache(): void {
        this.displayCacheFrameKey = undefined;
        this.displayCacheFrameIndex = undefined;
    }

    private dedupeFrameObjectsByTrackId(objects: AnnotateObject[]): AnnotateObject[] {
        const keptByTrack = new Map<string, AnnotateObject>();
        const withoutTrack: AnnotateObject[] = [];
        objects.forEach((object) => {
            if (!(object instanceof Box)) {
                withoutTrack.push(object);
                return;
            }
            const trackId = object.userData?.trackId;
            if (!trackId) {
                withoutTrack.push(object);
                return;
            }
            const existing = keptByTrack.get(trackId);
            if (!existing) {
                keptByTrack.set(trackId, object);
                return;
            }
            const existingBackId = (existing.userData as IUserData).backId;
            const newBackId = (object.userData as IUserData).backId;
            if (!existingBackId && newBackId) {
                keptByTrack.set(trackId, object);
            }
        });
        return [...withoutTrack, ...keptByTrack.values()];
    }

    private buildDisplayAnnotate3D(
        objects: AnnotateObject[],
        filterMap: ReturnType<DataManager['getActiveFilter']>,
        withoutTaskId: string,
    ): { annotate2D: Object2D[]; annotate3D: Array<Box | GroundPolygon | GroundPolyline> } {
        const annotate2D: Object2D[] = [];
        const annotate3D: Array<Box | GroundPolygon | GroundPolyline> = [];
        objects.forEach((object) => {
            const userData = object.userData as Required<IUserData>;
            const sourceId = userData.sourceId || withoutTaskId;
            const valid = filterMap.all || filterMap.source[sourceId];
            if (!valid) return;
            // 3D annotations are Three.js objects. Do not restrict this to Box:
            // parking slots and future LiDAR shapes must survive a frame reload too.
            if (object instanceof THREE.Object3D) {
                object.parent = this.editor.pc.annotate3D;
                annotate3D.push(object as Box | GroundPolygon | GroundPolyline);
            } else if (object instanceof Object2D) {
                annotate2D.push(object);
            }
        });
        return { annotate2D, annotate3D };
    }

    hasObject(uuid: string, frame?: IFrame): boolean {
        frame = frame || this.editor.getCurrentFrame();
        const frameKey = this.normalizeFrameId(frame.id);
        const frameMap = this.hasMap.get(frameKey);
        return !!frameMap && frameMap.has(uuid);
    }

    setHasMap(uuid: string, object: AnnotateObject, frame?: IFrame) {
        frame = frame || this.editor.getCurrentFrame();
        const frameKey = this.normalizeFrameId(frame.id);
        let frameMap = this.hasMap.get(frameKey);
        if (!frameMap) {
            frameMap = new Map();
            this.hasMap.set(frameKey, frameMap);
        }
        frameMap.set(uuid, object);
    }

    removeHasMap(uuid: string, frame?: IFrame) {
        frame = frame || this.editor.getCurrentFrame();
        const frameMap = this.hasMap.get(this.normalizeFrameId(frame.id));
        if (frameMap) frameMap.delete(uuid);
    }

    addAnnotates(
        objects: AnnotateObject[] | AnnotateObject,
        frame?: IFrame,
        reload: boolean = true,
    ) {
        if (!Array.isArray(objects)) objects = [objects];

        frame = frame || this.editor.getCurrentFrame();
        let allObjects = this.getFrameObject(frame.id) || [];

        objects.forEach((object) => {
            if (this.hasObject(object.uuid, frame)) return;
            if (object instanceof Box && object.userData?.trackId) {
                const trackId = object.userData.trackId;
                const duplicateIndex = allObjects.findIndex(
                    (item) =>
                        item instanceof Box && (item.userData as IUserData).trackId === trackId,
                );
                if (duplicateIndex >= 0) {
                    const removed = allObjects[duplicateIndex];
                    this.removeHasMap(removed.uuid, frame);
                    allObjects.splice(duplicateIndex, 1);
                }
            }
            allObjects.push(object);
            this.setHasMap(object.uuid, object, frame);
            this.editor.trackManager.updateObjectRenderInfo(object);
        });

        frame.needSave = true;
        this.setFrameObject(frame.id, allObjects);
        if (reload) this.loadDataFromManager();
        this.onAnnotatesAdd(objects, frame);
    }

    removeAnnotates(
        objects: AnnotateObject[] | AnnotateObject,
        frame?: IFrame,
        reload: boolean = true,
    ) {
        if (!Array.isArray(objects)) objects = [objects];

        frame = frame || this.editor.getCurrentFrame();
        let allObjects = this.getFrameObject(frame.id) || [];
        if (allObjects.length === 0) return;

        let removeMap = {} as Record<string, boolean>;
        let selectionMap = this.editor.pc.selectionMap;
        let selectFlag = false;
        objects.forEach((e) => {
            removeMap[e.uuid] = true;
            this.removeHasMap(e.uuid, frame);
            if (selectionMap[e.uuid]) {
                selectFlag = true;
                delete selectionMap[e.uuid];
            }
        });

        if (selectFlag) this.editor.updateSelect();

        let remainObjects = allObjects.filter((e) => !removeMap[e.uuid]);
        frame.needSave = true;
        this.setFrameObject(frame.id, remainObjects);
        if (reload) this.loadDataFromManager();
        this.onAnnotatesRemove(objects, frame);
    }

    setAnnotatesVisible(
        objects: AnnotateObject | AnnotateObject[],
        visible: boolean | boolean[],
        frame?: IFrame,
    ) {
        if (!Array.isArray(objects)) objects = [objects];
        frame = frame || this.editor.getCurrentFrame();

        let selectionMap = this.editor.pc.selectionMap;
        let selectFlag = false;
        let isMultiVisible = Array.isArray(visible);
        objects.forEach((object, index) => {
            let visibleNew = isMultiVisible ? visible[index] : visible;
            object.visible = visibleNew;
            if (!visibleNew && selectionMap[object.uuid]) {
                delete selectionMap[object.uuid];
                selectFlag = true;
            }
        });

        if (selectFlag) this.editor.updateSelect();

        this.onAnnotatesChange(objects, frame, { type: 'visible', visible });
    }

    setAnnotatesUserData(
        objects: AnnotateObject[] | AnnotateObject,
        datas: IUserData | IUserData[],
        frame?: IFrame,
    ) {
        if (!Array.isArray(objects)) objects = [objects];

        frame = frame || this.editor.getCurrentFrame();
        frame.needSave = true;
        objects.forEach((obj, index) => {
            // TODO
            let frame = (obj as any).frame as IFrame;
            if (frame) frame.needSave = true;

            let data = Array.isArray(datas) ? datas[index] : datas;
            const needUpdateInfo = data.hasOwnProperty('trackId');
            if (needUpdateInfo) {
                this.editor.trackManager.removeTrackCount(obj, frame);
            }
            Object.assign(obj.userData, data);
            if (needUpdateInfo) {
                this.editor.trackManager.addTrackCount(obj, frame);
            }
        });
        // this.editor.pc.setObjectUserData(objects,datas);
        this.onAnnotatesChange(objects, frame, { type: 'userData', datas });
    }

    setAnnotatesTransform(
        objects: AnnotateObject[] | AnnotateObject,
        datas: IAnnotateTransform | IAnnotateTransform[],
        frame?: IFrame,
    ) {
        if (!Array.isArray(objects)) objects = [objects];

        frame = frame || this.editor.getCurrentFrame();
        objects.forEach((obj, index) => {
            let data = Array.isArray(datas) ? datas[index] : datas;
            if (obj instanceof Box) {
                this.editor.pc.updateObjectTransform(obj, data as any);
            } else if (obj instanceof Rect) {
                this.editor.pc.update2DRect(obj, data as any);
            } else if (obj instanceof Box2D) {
                this.editor.pc.update2DBox(obj, data as any);
            }
        });

        this.editor.markSyncDirtyForTransform(objects, datas);
        this.onAnnotatesChange(objects, frame, { type: 'transform', datas });
    }

    setGroundPolygonPoints(
        object: GroundPolygon | GroundPolyline,
        points: THREE.Vector3[],
        frame?: IFrame,
    ): void {
        object.setPoints(points);
        this.onAnnotatesChange([object], frame, {
            type: 'transform',
            points3D: object.points3D.map((point) => point.clone()),
        });
    }

    initEvent() {}

    clear(): void {
        this.dataMap.clear();
        this.hasMap.clear();
    }

    destroy(): void {
        this.clear();
    }

    onAnnotatesChange(
        objects: AnnotateObject[],
        frame?: IFrame,
        data?: { type?: 'userData' | 'transform' | 'visible'; [k: string]: any },
    ) {
        frame = frame || this.editor.getCurrentFrame();
        frame.needSave = true;
        this.editor.pc.render();

        if (data?.type === 'transform') {
            // ANNOTATE_TRANSFORM_CHANGE
            this.editor.dispatchEvent({
                type: Event.ANNOTATE_TRANSFORM_CHANGE,
                data: { ...data, frame, objects },
            });
        } else {
            console.log('onAnnotatesChange', { ...data, frame });
            this.editor.dispatchEvent({
                type: Event.ANNOTATE_CHANGE,
                data: { ...data, frame, objects },
            });
        }
    }

    onAnnotatesAdd(objects: AnnotateObject[], frame?: IFrame) {
        frame = frame || this.editor.getCurrentFrame();
        frame.needSave = true;
        this.clearDisplayCache();
        this.editor.pc.render();
        this.editor.trackManager.addTrackCount(objects, frame);
        this.editor.dispatchEvent({ type: Event.ANNOTATE_ADD, data: { objects, frame } });
    }

    onAnnotatesRemove(objects: AnnotateObject[], frame?: IFrame) {
        frame = frame || this.editor.getCurrentFrame();
        frame.needSave = true;
        this.clearDisplayCache();
        this.editor.pc.render();
        this.editor.trackManager.removeTrackCount(objects, frame);
        this.editor.dispatchEvent({ type: Event.ANNOTATE_REMOVE, data: { objects, frame } });
    }

    setFrameObject(frameId: string, objects: AnnotateObject[]) {
        const frameKey = this.normalizeFrameId(frameId);
        const frame = this.editor.getFrame(frameId);
        const normalizedObjects = this.dedupeFrameObjectsByTrackId(objects);
        normalizedObjects.forEach((object) => {
            (object as any).frame = frame;
        });
        this.dataMap.set(frameKey, normalizedObjects);
        this.clearDisplayCache();
    }

    getFrameObject(frameId: string) {
        return this.dataMap.get(this.normalizeFrameId(frameId));
    }

    loadDataFromManager() {
        const frame = this.editor.getCurrentFrame();
        const frameKey = this.normalizeFrameId(frame.id);
        const frameIndex = this.editor.state.frameIndex;
        if (
            this.displayCacheFrameKey === frameKey &&
            this.displayCacheFrameIndex === frameIndex
        ) {
            return;
        }

        let objects = this.getFrameObject(frameKey) || [];
        const dedupedObjects = this.dedupeFrameObjectsByTrackId(objects);
        if (dedupedObjects.length !== objects.length) {
            objects = dedupedObjects;
            this.setFrameObject(frameKey, objects);
            const rebuiltHasMap = new Map<string, AnnotateObject>();
            objects.forEach((object) => rebuiltHasMap.set(object.uuid, object));
            this.hasMap.set(frameKey, rebuiltHasMap);
        }

        const {
            config: { withoutTaskId },
        } = this.editor.state;

        if (this.editor.needUpdateFilter) this.setFilterFromData();

        const filterMap = this.getActiveFilter();
        const { annotate2D, annotate3D } = this.buildDisplayAnnotate3D(
            objects,
            filterMap,
            withoutTaskId,
        );

        this.editor.pc.annotate2D = annotate2D;
        this.editor.pc.annotate3D.children = annotate3D;
        const currentObjects = new Set<AnnotateObject>([...annotate2D, ...annotate3D]);
        const validSelection = this.editor.pc.selection.filter((object) => currentObjects.has(object));
        if (validSelection.length !== this.editor.pc.selection.length) {
            this.editor.pc.selectObject(validSelection);
        }
        this.editor.dispatchEvent({ type: Event.ANNOTATE_LOAD });
        this.editor.pc.render();
        this.displayCacheFrameKey = frameKey;
        this.displayCacheFrameIndex = frameIndex;
    }

    setFilterFromData() {
        let { frameIndex, frames } = this.editor.state;
        let { FILTER_ALL } = this.editor.state.config;

        // if (this.editor.playManager.playing) {
        //     this.editor.state.filterActive = [FILTER_ALL];
        //     return;
        // }

        let frame = this.editor.getCurrentFrame();
        let objects = this.getFrameObject(frame.id) || [];
        let all: IFilter = { value: FILTER_ALL, label: FILTER_ALL, type: '' };
        let project: IFilter = { label: 'Ground Truth', options: [], type: 'project' };
        let model: IFilter = { label: 'Model Runs', options: [], type: 'model' };

        let projectMap = {};
        let modelMap = {};

        objects.forEach((object) => {
            let userData = object.userData as Required<IUserData>;
            if (userData.modelRun) {
                let id = userData.modelRun || '';
                let label = userData.modelRunLabel || '';
                if (!modelMap[id]) {
                    let option = { value: id, label: label };
                    model.options?.push(option);
                    modelMap[id] = option;
                }
            } else {
                let name = userData.project || '';
                if (!projectMap[name]) {
                    let option = { value: name, label: name || 'No Project' };
                    project.options?.push(option);
                    projectMap[name] = option;
                }
            }
        });

        let filters = [all] as IFilter[];

        if ((project as any).options.length > 0) filters.push(project);
        if ((model as any).options.length > 0) filters.push(model);

        this.editor.state.filters = filters;
        if (this.editor.state.filterActive.length === 0)
            this.editor.state.filterActive = [FILTER_ALL];

        this.editor.needUpdateFilter = false;
    }

    getActiveFilter() {
        let { FILTER_ALL } = this.editor.state.config;
        let { sourceFilters } = this.editor.state;

        let filterMap = {
            all: false,
            source: {},
            // project: {},
            // model: {},
        };
        sourceFilters.forEach((filter) => {
            if (filter === FILTER_ALL) filterMap.all = true;
            else {
                filterMap.source[filter] = true;
            }
        });

        return filterMap;
    }

    getMaxId(frameId?: string) {
        let { frameIndex, frames } = this.editor.state;
        let curFrame = frames[frameIndex];

        let objects = this.getFrameObject(frameId || curFrame.id) || [];
        let maxId = 0;
        objects.forEach((e) => {
            if (!e.userData.trackName) return;
            let id = parseInt(e.userData.trackName);
            if (id > maxId) maxId = id;
        });
        return maxId;
    }

    updateFrameId(frameId?: string) {
        let { frameIndex, frames } = this.editor.state;
        let curFrame = frames[frameIndex];

        frameId = frameId || curFrame.id;
        let objects = this.getFrameObject(frameId) || [];

        let startId = this.getMaxId(frameId) + 1;
        objects.forEach((e) => {
            let userData = e.userData as IUserData;
            userData.id = userData.id || THREE.MathUtils.generateUUID();

            if (userData.trackId) return;

            userData.trackId = this.editor.createTrackId();
            userData.trackName = startId++ + '';
        });

        // if (curFrame && frameId === curFrame.id) this.editor.idCount = startId;
    }

    updateBackId(keyMap: Record<string, Record<string, string>>) {
        Object.keys(keyMap).forEach((dataId) => {
            let dataKeyMap = keyMap[dataId];
            let annotates = this.getFrameObject(dataId) || [];
            annotates.forEach((annotate) => {
                let frontId = annotate.uuid;
                let backId = dataKeyMap[frontId];
                if (!backId) return;
                (annotate.userData as IUserData).backId = backId;
                // annotate.uuid = backId;
            });
        });
    }

    async pollDataModelResult() {}

    async runModelTrack(
        _curId: string,
        _toIds: string[],
        _direction: 'BACKWARD' | 'FORWARD',
        _targetObjects: any[],
        _trackIdName: Record<string, string>,
        _onComplete?: () => void,
        _useZ?: boolean,
    ) {}
    copyForward() {
        return this.track({
            direction: 'FORWARD',
            object: 'select',
            method: 'copy',
            frameN: 1,
        });
    }
    copyBackWard() {
        return this.track({
            direction: 'BACKWARD',
            object: 'select',
            method: 'copy',
            frameN: 1,
        });
    }
    async track(option: {
        method: 'copy' | 'model';
        object: 'select' | 'all';
        direction: 'BACKWARD' | 'FORWARD';
        frameN: number;
        useZ?: boolean;
    }) {
        let editor = this.editor;
        let { frameIndex, frames } = editor.state;
        let curId = frames[frameIndex].id;

        const getToDataId = function getToDataId() {
            let ids = [] as string[];
            let forward = option.direction === 'FORWARD' ? 1 : -1;
            let frameN = option.frameN;

            if (frameN > 0)
                for (let i = 1; i <= frameN; i++) {
                    let frame = frames[frameIndex + forward * i];
                    if (frame) {
                        ids.push(frame.id);
                    }
                }
            return ids;
        };
        const getObjects = function getObjects() {
            let dataId = frames[frameIndex].id;
            let objects = editor.dataManager.getFrameObject(dataId) || [];

            if (option.object === 'select') {
                objects = editor.pc.selection;
            }

            objects = objects.filter((object) => {
                return object instanceof Box && !object.userData.invisibleFlag;
            });

            return objects as Box[];
        };
        let ids = getToDataId();
        if (ids.length === 0) {
            editor.showMsg('warning', editor.lang('track-no-data'));
            return;
        }

        let objects = getObjects();
        if (objects.length === 0) {
            editor.showMsg('warning', editor.lang('track-no-source'));
            return;
        }

        if (option.method === 'copy') {
            utils.copyData(editor, curId, ids, objects);
            editor.showMsg('success', editor.lang('copy-ok'));
            this.gotoNext(ids[0]);
        } else {
            await this.modelTrack(ids, objects, option.direction, option.useZ ?? true);
        }
    }
    gotoNext(dataId: string) {
        let { frames } = this.editor.state;
        let index = frames.findIndex((e) => e.id === dataId);
        // index = Math.max(0, Math.min(editor.state.frames.length-1, index))
        if (index < 0) return;
        this.editor.loadFrame(index);
        // this.editor.dispatchEvent({ type: EditorEvent.UPDATE_TIME_LINE });
    }
    async modelTrack(
        toIds: string[],
        objects: AnnotateObject[],
        direction: 'BACKWARD' | 'FORWARD',
        useZ = true,
    ) {
        let editor = this.editor;
        let { frameIndex, frames } = editor.state;
        let dataInfo = frames[frameIndex];
        let curId = dataInfo.id;

        let trackIdName = {} as Record<string, string>;
        let targetObjects = [] as any[];
        objects.forEach((object) => {
            if (object instanceof Box) {
                let userData = object.userData as IUserData;
                let { position, scale, rotation } = object;
                let center3D = new THREE.Vector3().set(position.x, position.y, position.z);
                let rotation3D = new THREE.Vector3().set(rotation.x, rotation.y, rotation.z);
                let size3D = new THREE.Vector3().set(scale.x, scale.y, scale.z);

                if (!userData.trackId) {
                    userData.trackId = editor.createTrackId();
                }

                trackIdName[userData.trackId] = userData.trackName || '';

                targetObjects.push({
                    uuid: object.uuid,
                    trackingId: userData.trackId,
                    objType: '3d',
                    modelClass: userData.modelClass || null,
                    confidence: userData.confidence || null,
                    center3D,
                    rotation3D,
                    size3D,
                });
            }
        });

        this.runModelTrack(curId, toIds, direction, targetObjects, trackIdName, () => {
            this.gotoNext(toIds[0]);
        }, useZ);
    }
}
