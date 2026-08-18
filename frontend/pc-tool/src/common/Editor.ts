import { Editor as BaseEditor, IFrame, SourceType, MotionMode, Event, OPType } from 'pc-editor';
import { IBSState } from '../type';
import { getDefault } from '../state';
import { utils, AttrType, IClassificationAttr, IUserData } from 'pc-editor';
import { Box } from 'pc-render';
import * as THREE from 'three';
import hotkeys from 'hotkeys-js';
import * as api from '../api';
import BusinessManager from './BusinessManager';
import DataManager from './DataManager';

const SYNCABLE_MOTION_MODES: string[] = [
    MotionMode.STATIC,
    MotionMode.DYNAMIC_FIXED_SIZE,
    MotionMode.DYNAMIC_VARIABLE_SIZE,
];
const DEFAULT_SYNC_LOCATION_GAP_MS = 200;
const DEFAULT_DYNAMIC_SYNC_FRAME_COUNT = 1;

const OCCLUSION_HOTKEY = 'o';
const REVIEW_CORRECT_HOTKEY = 'r';
const REVIEW_NEXT_UNREVIEWED_HOTKEY = 'alt+n';

interface IQaIssue {
    frameId: string;
    frameName: string;
    objectUuid: string;
    objectId?: string;
    trackId?: string;
    label: string;
    message: string;
}

export default class Editor extends BaseEditor {
    businessManager: BusinessManager;
    dataManager: DataManager;
    bsState: IBSState = getDefault();
    private syncKeydownHandler?: (event: KeyboardEvent) => void;
    private qaIssues: IQaIssue[] = [];
    private qaIssueIndex = 0;
    private reviewStatusUpdating = new Set<string>();
    constructor() {
        super();

        this.businessManager = new BusinessManager(this);
        this.dataManager = new DataManager(this);
        this.initSyncModeHotkey();
        this.initOcclusionHotkey();
        this.initReviewHotkey();
        this.initReviewNavigationHotkey();
        this.initQaHotkey();
        this.addEventListener(Event.ANNOTATE_CHANGE, (event: any) => {
            const data = event.data || {};
            if (data.type !== 'userData') return;
            const patches = Array.isArray(data.datas) ? data.datas : [data.datas];
            if (
                patches.length > 0 &&
                patches.every(
                    (patch) =>
                        patch &&
                        Object.keys(patch).length === 1 &&
                        Object.prototype.hasOwnProperty.call(patch, 'reviewedCorrect'),
                )
            ) {
                return;
            }
            this.markModifiedInferenceObjects(data.objects || []);
            this.clearReviewedTracks(data.objects || []);
        });
        this.addEventListener(Event.ANNOTATE_TRANSFORM_CHANGE, (event: any) => {
            this.markModifiedInferenceObjects(event.data?.objects || []);
            this.clearReviewedTracks(event.data?.objects || []);
        });
    }

    destroy(): void {
        if (this.syncKeydownHandler) {
            window.removeEventListener('keydown', this.syncKeydownHandler, true);
            this.syncKeydownHandler = undefined;
        }
        this.reviewStatusUpdating.clear();
        this.qaIssues = [];
        super.destroy();
    }

    // ---- Sync Mode (LiDAR Fusion Sync) ----------------------------------------------------
    // Sync is *not* triggered automatically on every transform change - each sync round trip is
    // a save + refetch over the network, so doing that on every small drag/nudge would make
    // editing feel laggy. Instead it's a deliberate action: press ctrl+y (cmd+y on mac) with a
    // tracked object selected to push its current sync-relevant state to every other frame in
    // the Scene.
    private static readonly SYNC_EVENT_SOURCE = 'lidar-fusion-sync';
    private static readonly REVIEW_PRESERVE_USER_DATA_KEYS = [
        'reviewedCorrect',
        'reviewedCorrectVisible',
    ] as const;
    private syncLockQueue: Array<() => Promise<void>> = [];
    private syncLockRunning = false;

    private initSyncModeHotkey() {
        this.bindPersistentSyncHotkey();
        let bind = () => {
            hotkeys('ctrl+y,command+y', (event) => {
                if (this.state.modeConfig.op !== OPType.EXECUTE) return;
                event.preventDefault();
                this.syncSelectedTrack();
            });
        };
        bind();
        // HotkeyManager.setHotKeyFromAction() calls hotkeys.unbind() (clearing *every* binding,
        // ours included) and rebinds only the mode's own config every time the mode changes -
        // which happens after this constructor runs. Wrap it so our binding always survives.
        let original = this.hotkeyManager.setHotKeyFromAction.bind(this.hotkeyManager);
        this.hotkeyManager.setHotKeyFromAction = (actions: any) => {
            original(actions);
            bind();
        };
    }

    private bindPersistentSyncHotkey() {
        if (this.syncKeydownHandler) return;
        this.syncKeydownHandler = (event: KeyboardEvent) => {
            const key = event.key.toLowerCase();
            if (key !== 'y' || (!event.ctrlKey && !event.metaKey) || event.altKey) return;
            if (this.state.modeConfig.op !== OPType.EXECUTE) return;
            event.preventDefault();
            event.stopPropagation();
            this.syncSelectedTrack();
        };
        window.addEventListener('keydown', this.syncKeydownHandler, true);
    }

    private initOcclusionHotkey() {
        let bind = () => {
            hotkeys(OCCLUSION_HOTKEY, (event) => {
                if (this.state.modeConfig.op !== OPType.EXECUTE) return;
                event.preventDefault();
                this.toggleSelectedOcclusion();
            });
        };
        bind();
        let original = this.hotkeyManager.setHotKeyFromAction.bind(this.hotkeyManager);
        this.hotkeyManager.setHotKeyFromAction = (actions: any) => {
            original(actions);
            bind();
        };
    }

    private initQaHotkey() {
        let bind = () => {
            hotkeys('alt+q', (event) => {
                event.preventDefault();
                this.focusNextQaIssue();
            });
        };
        bind();
        let original = this.hotkeyManager.setHotKeyFromAction.bind(this.hotkeyManager);
        this.hotkeyManager.setHotKeyFromAction = (actions: any) => {
            original(actions);
            bind();
        };
    }

    private initReviewHotkey() {
        let bind = () => {
            hotkeys(REVIEW_CORRECT_HOTKEY, (event) => {
                if (!this.bsState.reviewMode) return;
                event.preventDefault();
                this.toggleSelectedTrackReviewedCorrect();
            });
        };
        bind();
        let original = this.hotkeyManager.setHotKeyFromAction.bind(this.hotkeyManager);
        this.hotkeyManager.setHotKeyFromAction = (actions: any) => {
            original(actions);
            bind();
        };
    }

    private initReviewNavigationHotkey() {
        let bind = () => {
            hotkeys(REVIEW_NEXT_UNREVIEWED_HOTKEY, (event) => {
                if (!this.bsState.reviewMode) return;
                event.preventDefault();
                this.focusFirstUnreviewedObject();
            });
        };
        bind();
        let original = this.hotkeyManager.setHotKeyFromAction.bind(this.hotkeyManager);
        this.hotkeyManager.setHotKeyFromAction = (actions: any) => {
            original(actions);
            bind();
        };
    }

    async focusFirstUnreviewedObject() {
        if (!this.bsState.reviewMode) {
            this.showMsg('warning', '请先开启 Review Mode');
            return;
        }
        const batchSize = 200;
        const frames = this.state.frames;
        for (let offset = 0; offset < frames.length; offset += batchSize) {
            const batch = frames.slice(offset, offset + batchSize);
            let data: any;
            try {
                data = await this.businessManager.getFrameObject(batch);
            } catch (error) {
                console.warn('find first unreviewed object failed', error);
                this.showMsg('error', '未审阅目标查询失败');
                return;
            }
            for (const frame of batch) {
                const candidate = (
                    utils.objectsMapForFrame(data.objectsMap, frame.id) as any[]
                ).find((object) => object.trackId && object.reviewedCorrect !== true);
                if (!candidate) continue;
                await this.loadFrame(offset + batch.indexOf(frame));
                const object = (this.dataManager.getFrameObject(frame.id) || []).find((item: any) => {
                    const userData = item.userData || {};
                    return (
                        item instanceof Box &&
                        userData.trackId === candidate.trackId &&
                        userData.reviewedCorrect !== true
                    );
                });
                if (object) {
                    this.selectObject(object);
                    this.focusObject(object);
                    this.showMsg('success', `已定位第一个未审阅目标。${REVIEW_NEXT_UNREVIEWED_HOTKEY.toUpperCase()} 可重新定位`, 3);
                    return;
                }
            }
        }
        this.showMsg('success', '全部目标已审阅');
    }

    toggleSelectedOcclusion() {
        if (this.state.modeConfig.op !== OPType.EXECUTE) return;
        let objects = this.pc.selection.filter((e) => e instanceof Box) as Box[];
        if (objects.length === 0) {
            this.showMsg('warning', '请先选中一个3D框');
            return;
        }
        const occluded = !objects.some((box) => box.userData?.occluded === true);
        const data = objects.map((box) => {
            const classConfig = this.getClassType(box.userData || {});
            return utils.getOccludedUserDataPatch(classConfig, box.userData, occluded);
        });
        this.cmdManager.execute('update-object-user-data', {
            objects,
            data,
        });
        this.showMsg('success', occluded ? '已标记为完全遮挡' : '已标记为不遮挡');
    }

    async runWithSyncLock<T>(task: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.syncLockQueue.push(async () => {
                try {
                    resolve(await task());
                } catch (error) {
                    reject(error);
                }
            });
            void this.drainSyncLockQueue();
        });
    }

    private async drainSyncLockQueue(): Promise<void> {
        if (this.syncLockRunning) return;
        this.syncLockRunning = true;
        while (this.syncLockQueue.length > 0) {
            const task = this.syncLockQueue.shift();
            if (task) await task();
        }
        this.syncLockRunning = false;
    }

    invalidateTrackDisplayCaches(): void {
        this.trackManager.rebuildTrackCountCaches();
    }

    async markSelectedTrackReviewedCorrect() {
        const object = this.pc.selection.find((item) => item instanceof Box) as Box | undefined;
        const trackId = object?.userData?.trackId;
        if (!object || !trackId) {
            this.showMsg('warning', '请先选中一个有追踪ID的3D框');
            return;
        }
        await this.setTrackReviewedCorrect(trackId, true);
        this.showMsg('success', `Track ${trackId} 已标记为正确`);
    }

    async toggleSelectedTrackReviewedCorrect() {
        const object = this.pc.selection.find((item) => item instanceof Box) as Box | undefined;
        const trackId = object?.userData?.trackId;
        if (!object || !trackId) {
            this.showMsg('warning', '请先选中一个有追踪ID的3D框');
            return;
        }
        const reviewedCorrect = object.userData?.reviewedCorrect !== true;
        await this.setTrackReviewedCorrect(trackId, reviewedCorrect);
        this.showMsg(
            'success',
            reviewedCorrect ? `Track ${trackId} 已标记为正确` : `Track ${trackId} 已取消正确标记`,
        );
    }

    async setTrackReviewedCorrect(trackId: string, reviewedCorrect: boolean) {
        if (!trackId || this.reviewStatusUpdating.has(trackId)) return;
        this.reviewStatusUpdating.add(trackId);
        try {
            this.trackManager.setDataByTrackId(trackId, {
                userData: {
                    reviewedCorrect,
                    reviewedCorrectVisible: this.bsState.reviewMode && reviewedCorrect,
                },
            });
            const track = this.trackManager.getTrackObject(trackId);
            if (track) {
                this.trackManager.updateTrackData(trackId, { reviewedCorrect });
            } else {
                this.trackManager.addTrackObject(trackId, { reviewedCorrect });
            }
            await api.reviewTrack(String(this.getCurrentFrame().id), trackId, reviewedCorrect);
        } catch (error) {
            console.warn('review-track update failed', error);
            this.showMsg('error', '审阅状态保存失败');
        } finally {
            this.reviewStatusUpdating.delete(trackId);
        }
    }

    setReviewMode(reviewMode: boolean) {
        this.bsState.reviewMode = reviewMode;
        const objects: any[] = [];
        this.state.frames.forEach((frame) => {
            const frameObjects = this.dataManager.getFrameObject(frame.id) || [];
            frameObjects.forEach((object) => {
                const userData = object.userData as IUserData;
                userData.reviewedCorrectVisible = reviewMode && userData.reviewedCorrect === true;
                objects.push(object);
            });
        });
        if (objects.length > 0) this.updateObjectRenderInfo(objects);
        this.dispatchEvent({
            type: Event.ANNOTATE_CHANGE,
            data: { type: 'reviewMode', objects },
        });
    }

    private clearReviewedTracks(objects: any[]) {
        const trackIds = new Set<string>();
        objects.forEach((object) => {
            const userData = object?.userData as IUserData | undefined;
            if (userData?.reviewedCorrect === true && userData.trackId) {
                trackIds.add(userData.trackId);
            }
        });
        trackIds.forEach((trackId) => {
            this.setTrackReviewedCorrect(trackId, false);
        });
    }

    /**
     * Manual sync trigger (ctrl+y / cmd+y, or the "Sync Now" button in the property panel).
     * Takes whichever tracked object is currently selected, makes sure its motionMode is
     * actually written into userData (so the backend's propagation engine has something to key
     * off), then pushes it to the backend and pulls the propagated result back into every other
     * loaded frame.
     */
    async syncSelectedTrack() {
        if (this.state.modeConfig.op !== OPType.EXECUTE) return;
        let box = this.pc.selection.find((e) => e instanceof Box) as Box | undefined;
        if (!box) {
            const currentObjects = this.dataManager.getFrameObject(this.getCurrentFrame().id) || [];
            box = currentObjects.find((e) => e instanceof Box && this.pc.selection.includes(e)) as
                | Box
                | undefined;
        }
        if (!box) {
            this.showMsg('warning', 'Please Select a 3D Result');
            return;
        }
        let trackId = box.userData?.trackId;
        if (!trackId) {
            this.showMsg('warning', '该对象没有追踪ID');
            return;
        }
        let motionMode =
            box.userData?.motionMode || utils.getDefaultMotionMode(box.userData?.classType);
        if (!SYNCABLE_MOTION_MODES.includes(motionMode)) {
            this.showMsg('warning', '该对象的运动模式不支持同步');
            return;
        }

        let sourceFrameId = this.getCurrentFrame().id;
        const syncLocationGapMs = Number(box.userData?.syncLocationGapMs);
        const dynamicRangeSyncEnabled = box.userData?.dynamicRangeSyncEnabled === true;
        const dynamicSyncPreviousFrames = Number(box.userData?.dynamicSyncPreviousFrames);
        const dynamicSyncNextFrames = Number(box.userData?.dynamicSyncNextFrames);
        const normalizedPreviousFrames =
            Number.isInteger(dynamicSyncPreviousFrames) && dynamicSyncPreviousFrames >= 0
                ? dynamicSyncPreviousFrames
                : DEFAULT_DYNAMIC_SYNC_FRAME_COUNT;
        const normalizedNextFrames =
            Number.isInteger(dynamicSyncNextFrames) && dynamicSyncNextFrames >= 0
                ? dynamicSyncNextFrames
                : DEFAULT_DYNAMIC_SYNC_FRAME_COUNT;
        this.cmdManager.execute('update-object-user-data', {
            objects: box,
            data: {
                motionMode,
                syncLocationGapMs:
                    Number.isInteger(syncLocationGapMs) && syncLocationGapMs > 0
                        ? syncLocationGapMs
                        : DEFAULT_SYNC_LOCATION_GAP_MS,
                dynamicRangeSyncEnabled,
                dynamicSyncPreviousFrames: normalizedPreviousFrames,
                dynamicSyncNextFrames: normalizedNextFrames,
                syncDirty: false,
            },
        });

        this.showLoading({ type: 'loading', content: '正在同步到其他帧…' });
        try {
            await this.runWithSyncLock(() =>
                this.syncMotionMode(
                    trackId,
                    motionMode,
                    sourceFrameId,
                    box.userData?.classId,
                    box.userData?.classType,
                ),
            );
            this.showMsg(
                'success',
                dynamicRangeSyncEnabled
                    ? `已向前同步 ${normalizedPreviousFrames} 帧，向后同步 ${normalizedNextFrames} 帧`
                    : '已同步到全场景',
            );
        } catch (e) {
            console.warn('sync-mode propagation failed', e);
            this.showMsg('error', '同步失败');
        } finally {
            this.showLoading(false);
        }
    }

    /**
     * Explicit Sync Now action. Normal Save is local-only; this method first saves the source
     * frame, then calls the dedicated backend sync endpoint for this one track.
     */
    async syncMotionMode(
        trackId: string,
        motionMode: string,
        sourceFrameId?: string,
        classId?: string | number,
        classType?: string,
    ) {
        if (this.dataManager.isInferenceRunning()) {
            this.showMsg(
                'warning',
                'Dataset inference is running. Sync is disabled until the scene labels are refreshed.',
                8,
            );
            return;
        }
        if (!SYNCABLE_MOTION_MODES.includes(motionMode)) {
            throw new Error(`Unsupported sync motion mode: ${motionMode}`);
        }
        let sourceFrame = this.getFrame(sourceFrameId || this.getCurrentFrame().id);
        if (!sourceFrame) sourceFrame = this.getCurrentFrame();
        sourceFrame.needSave = true;
        // Sync refreshes every loaded frame from the server. Persist pending changes first for
        // every loaded frame containing this track, otherwise a local per-frame state such as
        // occlusion could be replaced by its stale server value after a frame switch.
        const framesToSave = this.state.frames.filter((frame) => {
            if (!frame.needSave) return false;
            return (this.dataManager.getFrameObject(frame.id) || []).some(
                (object) => object instanceof Box && object.userData?.trackId === trackId,
            );
        });
        if (!framesToSave.some((frame) => String(frame.id) === String(sourceFrame.id))) {
            framesToSave.push(sourceFrame);
        }
        await this.saveObject(framesToSave, true, true);
        await api.syncObject(String(sourceFrame.id), trackId, classId);
        await this.refreshTrackFromServer(trackId, sourceFrame.id, classId, classType);
    }

    async refreshTrackFromServer(
        trackId: string,
        sourceFrameId: string,
        classId?: string | number,
        classType?: string,
    ) {
        // Refresh metadata for every loaded frame so backend-generated segment ids are available
        // immediately. The source frame keeps its local transform because it is the sync source.
        const sourceFrameKey = String(sourceFrameId);
        let frames = this.state.frames.filter((f) => !!this.dataManager.getFrameObject(f.id));
        if (frames.length === 0) return;

        let data: any;
        try {
            data = await api.getDataObjectBatch(frames.map((f) => f.id));
        } catch (e) {
            console.warn('refreshTrackFromServer: fetch failed', e);
            return;
        }

        let addDatas: { objects: any[]; frame: IFrame }[] = [];
        let updateTrans: { objects: Box[]; transforms: any[] } = { objects: [], transforms: [] };
        let updateDatas: { objects: Box[]; data: IUserData[] } = { objects: [], data: [] };
        const sourceClass = { classId, classType };

        frames.forEach((frame) => {
            const frameObjects = this.dataManager.getFrameObject(frame.id) || [];
            const duplicateBoxes = frameObjects.filter((object) => {
                if (!(object instanceof Box)) return false;
                const userData = object.userData as IUserData;
                if (userData.trackId !== trackId) return false;
                if (classId != null || classType) {
                    return utils.sameAnnotationClass(userData, sourceClass);
                }
                return true;
            }) as Box[];

            let fresh = (
                utils.objectsMapForFrame(data.objectsMap, frame.id) as any[]
            ).find((o) => {
                if (o.trackId !== trackId || !o.center3D || !o.size3D) return false;
                if (classId != null || classType) {
                    return utils.sameAnnotationClass(o, sourceClass);
                }
                return true;
            });
            let existing = duplicateBoxes[0];

            if (duplicateBoxes.length > 1) {
                const primary =
                    existing ||
                    duplicateBoxes.find((box) => (box.userData as IUserData).backId) ||
                    duplicateBoxes[0];
                const duplicates = duplicateBoxes.filter((box) => box !== primary);
                if (duplicates.length > 0) {
                    this.dataManager.removeAnnotates(duplicates, frame, false);
                }
                existing = primary;
            }

            if (fresh && !existing) {
                let annotate = utils.convertObject2Annotate([fresh], this)[0];
                if (annotate) addDatas.push({ objects: [annotate], frame });
            } else if (fresh && existing) {
                if (String(frame.id) !== sourceFrameKey) {
                    updateTrans.objects.push(existing);
                    updateTrans.transforms.push({
                        position: new THREE.Vector3(
                            fresh.center3D.x,
                            fresh.center3D.y,
                            fresh.center3D.z,
                        ),
                        scale: new THREE.Vector3(fresh.size3D.x, fresh.size3D.y, fresh.size3D.z),
                        rotation: new THREE.Euler(
                            fresh.rotation3D?.x || 0,
                            fresh.rotation3D?.y || 0,
                            fresh.rotation3D?.z || 0,
                        ),
                    });
                }
                updateDatas.objects.push(existing);
                const userDataPatch: IUserData = {
                    attrs: fresh.attrs,
                    classType: fresh.classType,
                    classId: fresh.classId,
                    motionMode: fresh.motionMode,
                    syncDistance: fresh.syncDistance,
                    syncMaxDisappearGap: fresh.syncMaxDisappearGap,
                    syncLocationGapMs: fresh.syncLocationGapMs,
                    dynamicRangeSyncEnabled: fresh.dynamicRangeSyncEnabled,
                    dynamicSyncPreviousFrames: fresh.dynamicSyncPreviousFrames,
                    dynamicSyncNextFrames: fresh.dynamicSyncNextFrames,
                    syncPoseSegmentId: fresh.syncPoseSegmentId,
                    syncPoseSegmentsInitialized: fresh.syncPoseSegmentsInitialized,
                    syncUseZ: fresh.syncUseZ,
                    syncYawOffsetDeg: fresh.syncYawOffsetDeg,
                    syncXOffsetM: fresh.syncXOffsetM,
                    syncYOffsetM: fresh.syncYOffsetM,
                    occluded: fresh.occluded === true,
                    syncDirty: fresh.syncDirty === true,
                    reviewedCorrect: fresh.reviewedCorrect === true,
                };
                if (this.bsState.reviewMode && existing.userData) {
                    const localUserData = existing.userData as IUserData;
                    Editor.REVIEW_PRESERVE_USER_DATA_KEYS.forEach((key) => {
                        if (localUserData[key] !== undefined) {
                            userDataPatch[key] = localUserData[key];
                        }
                    });
                }
                updateDatas.data.push(userDataPatch);
            }
        });

        this.withEventSource(Editor.SYNC_EVENT_SOURCE, () => {
            this.cmdManager.withGroup(() => {
                if (addDatas.length > 0) this.cmdManager.execute('add-object', addDatas);
                if (updateTrans.objects.length > 0)
                    this.cmdManager.execute('update-transform-batch', updateTrans);
                if (updateDatas.objects.length > 0)
                    this.cmdManager.execute('update-object-user-data', updateDatas);
            });
        });
        this.invalidateTrackDisplayCaches();
        this.selectByTrackId(trackId);
        this.pc.render();
    }

    needSave(frames?: IFrame[]) {
        frames = frames || this.state.frames;
        let needSaveData = frames.filter((e) => e.needSave);
        return needSaveData.length > 0;
    }

    runQaLite(frames?: IFrame[]) {
        frames = frames || this.state.frames;
        const violations: IQaIssue[] = [];
        frames.forEach((frame) => {
            const objects = this.dataManager.getFrameObject(frame.id) || [];
            objects.forEach((object: any) => {
                const userData = object.userData as IUserData;
                const label = userData.trackName || userData.trackId || userData.id || object.uuid;
                const addIssue = (text: string) => {
                    violations.push({
                        frameId: String(frame.id),
                        frameName: frame.name || String(frame.id),
                        objectUuid: object.uuid,
                        objectId: userData.id || userData.backId,
                        trackId: userData.trackId,
                        label,
                        message: `${frame.name || frame.id}: ${label} ${text}`,
                    });
                };
                if (!userData.classId && !userData.classType) {
                    addIssue('缺少类别');
                }
                if (object instanceof Box && !userData.trackId) {
                    addIssue('缺少追踪ID');
                }
                if (object instanceof Box) {
                    const invalidSize =
                        object.scale.x <= 0 ||
                        object.scale.y <= 0 ||
                        object.scale.z <= 0 ||
                        !Number.isFinite(object.scale.x + object.scale.y + object.scale.z);
                    if (invalidSize) addIssue('尺寸异常');
                    if (userData.motionMode === MotionMode.STATIC) {
                        const syncDistance = Number(userData.syncDistance || 12);
                        if (!Number.isFinite(syncDistance) || syncDistance <= 0) {
                            addIssue('同步距离异常');
                        }
                    }
                }
                const classConfig = this.getClassType(userData);
                (classConfig?.attrs || []).forEach((attr: any) => {
                    if (!attr.required) return;
                    const value = userData.attrs?.[attr.id];
                    const empty =
                        value == null ||
                        value === '' ||
                        (Array.isArray(value) && value.length === 0);
                    if (empty) addIssue(`缺少必填属性 ${attr.name || attr.label || attr.id}`);
                });
            });
        });
        return violations;
    }

    async focusQaIssue(issue: IQaIssue, showMessage = true) {
        const frameIndex = this.getFrameIndex(issue.frameId);
        if (typeof frameIndex === 'number' && Number.isFinite(frameIndex)) {
            await this.loadFrame(frameIndex);
        }
        const objects = this.dataManager.getFrameObject(issue.frameId) || [];
        const object = objects.find((item: any) => {
            const userData = item.userData || {};
            return (
                item.uuid === issue.objectUuid ||
                (!!issue.trackId && userData.trackId === issue.trackId) ||
                (!!issue.objectId && (userData.id === issue.objectId || userData.backId === issue.objectId))
            );
        });
        if (object) {
            this.selectObject(object);
            if (object instanceof Box) this.focusObject(object);
        }
        if (showMessage) {
            this.showMsg(
                'warning',
                `QA ${this.qaIssueIndex + 1}/${this.qaIssues.length}: ${issue.message}。Alt+Q 下一个`,
                8,
            );
        }
    }

    async focusNextQaIssue() {
        if (this.qaIssues.length === 0) {
            this.showMsg('warning', '当前没有QA问题');
            return;
        }
        this.qaIssueIndex = (this.qaIssueIndex + 1) % this.qaIssues.length;
        await this.focusQaIssue(this.qaIssues[this.qaIssueIndex]);
    }

    async saveObject(frames?: IFrame[], force?: boolean, silent?: boolean): Promise<boolean> {
        let { bsState } = this;
        if (bsState.saving) return false;
        if (this.dataManager.isInferenceRunning()) {
            if (!silent) {
                this.showMsg(
                    'warning',
                    'Dataset inference is running. Saving is disabled until the scene labels are refreshed.',
                    8,
                );
            }
            return false;
        }

        frames = frames || this.state.frames;

        if (!force && !this.needSave(frames)) return true;

        const qaViolations = silent ? [] : this.runQaLite(frames);

        let dataInfos = [] as any[];
        let queryTime = frames[0].queryTime;
        frames.forEach((dataMeta) => {
            // if (dataMeta.skipped) return;
            if (!force && !dataMeta.needSave) return;
            let annotates = this.dataManager.getFrameObject(dataMeta.id) || [];
            if (new Date(dataMeta.queryTime).getTime() > new Date(queryTime).getTime())
                queryTime = dataMeta.queryTime;

            // result object
            let data = utils.convertAnnotate2Object(annotates, this);
            let infos = [] as any[];
            let dataAnnotations = [] as any[];
            data.forEach((e) => {
                let classConfig = this.getClassType(e.classId || e.classType || '');
                let objectV2 = utils.translateToObjectV2(e, classConfig);
                infos.push({
                    id: e.uuid || undefined,
                    frontId: e.frontId,
                    classId: classConfig?.id,
                    source: e.modelRun ? 'MODEL' : 'ARTIFICIAL',
                    sourceId: e.sourceId,
                    sourceType: e.sourceType,
                    promoteToHuman: e.manualModified === true,
                    classAttributes: objectV2,
                });
            });

            dataMeta.classifications.forEach((classification) => {
                let values = utils.classificationToSave(classification);
                dataAnnotations.push({
                    classificationId: classification.id,
                    classificationAttributes: {
                        id: classification.id,
                        values: values,
                    },
                });
            });

            dataInfos.push({
                dataId: dataMeta.id,
                objects: infos,
                dataAnnotations: dataAnnotations,
            });
        });

        let objectInfo = {
            datasetId: bsState.datasetId,
            dataInfos: dataInfos,
        };
        bsState.saving = true;
        try {
            await api.saveObject(objectInfo).then((keyMap) => {
                this.updateBackId(keyMap);
            });
            frames.forEach((e) => {
                e.needSave = false;
            });
            if (!silent) {
                if (qaViolations.length > 0) {
                    this.qaIssues = qaViolations;
                    this.qaIssueIndex = 0;
                    await this.focusQaIssue(qaViolations[0], false);
                    this.showMsg(
                        'warning',
                        `保存成功，但QA发现 ${qaViolations.length} 个问题: ${qaViolations[0].message}。已定位到第1个，Alt+Q 下一个`,
                        8,
                    );
                } else {
                    this.qaIssues = [];
                    this.qaIssueIndex = 0;
                    this.showMsg('success', this.lang('save-ok'));
                }
            }
            return true;
        } catch (e: any) {
            console.error(e);
            if (!silent) this.showMsg('error', this.lang('save-error'));
            return false;
        } finally {
            bsState.saving = false;
        }
    }

    private markModifiedInferenceObjects(objects: any[]): void {
        objects.forEach((object) => {
            const userData = this.getObjectUserData(object);
            if (userData.sourceType === SourceType.INFERENCE) {
                userData.manualModified = true;
                userData.sourceId = this.state.config.withoutTaskId;
                userData.sourceType = SourceType.DATA_FLOW;
            }
        });
    }

    updateBackId(keyMap: Record<string, Record<string, string>>) {
        Object.keys(keyMap).forEach((dataId) => {
            let dataKeyMap = keyMap[dataId];
            let annotates = this.dataManager.getFrameObject(dataId) || [];
            annotates.forEach((annotate: any) => {
                let frontId = annotate.uuid;
                let backId = dataKeyMap[frontId];
                if (!backId) return;
                annotate.userData.backId = backId;
                // annotate.uuid = backId;
            });
        });
    }
    async getResultSources(frame?: IFrame) {
        let { state } = this;
        frame = frame || this.getCurrentFrame();
        if (!frame.sources) {
            let sources = await api.getResultSources(frame.id);
            sources.unshift({
                name: 'Without Task',
                sourceId: state.config.withoutTaskId,
                sourceType: SourceType.DATA_FLOW,
            });
            frame.sources = sources;
        }
        this.setSources(frame.sources);

        // let sourceMap = {};
        // sources.forEach((e) => {
        //     sourceMap[e.sourceId] = true;
        // });
        // state.sourceFilters = [state.config.withoutTaskId];
        // state.sources = sources;
    }
}
