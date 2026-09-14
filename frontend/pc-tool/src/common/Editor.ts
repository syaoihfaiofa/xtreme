import {
    Editor as BaseEditor,
    IFrame,
    SourceType,
    MotionMode,
    Event,
    OPType,
    ObjectType,
} from 'pc-editor';
import { IBSState } from '../type';
import { getDefault } from '../state';
import { utils, AttrType, IClassificationAttr, IUserData } from 'pc-editor';
import {
    Box,
    GroundPolygon,
    GroundPolyline,
    IrregularWall,
    IGroundShapeSplitPick,
} from 'pc-render';
import * as THREE from 'three';
import hotkeys from 'hotkeys-js';
import * as api from '../api';
import BusinessManager from './BusinessManager';
import DataManager from './DataManager';
import { refreshGroundPolylineBevDisplay } from '../packages/pc-editor/utils/groundPolylineVisibility';
import { IQaIssue, QA_ISSUE_CODE_LABELS, QaIssueCode } from './qaIssue';
import ParkingPointCloudDensityManager from './ParkingPointCloudDensityManager';

const SYNCABLE_MOTION_MODES: string[] = [
    MotionMode.STATIC,
    MotionMode.DYNAMIC_FIXED_SIZE,
    MotionMode.DYNAMIC_VARIABLE_SIZE,
];
const DEFAULT_SYNC_LOCATION_GAP_MS = 1000;
const DEFAULT_DYNAMIC_SYNC_FRAME_COUNT = 1;

type SyncableGroundShape = GroundPolygon | GroundPolyline | IrregularWall;

function isSyncableGroundShape(object: unknown): object is SyncableGroundShape {
    return object instanceof GroundPolygon || object instanceof GroundPolyline || object instanceof IrregularWall;
}

function matchesSyncedTrack(
    candidate: { trackId?: string; classId?: unknown; classType?: string },
    trackId: string,
    sourceClass: { classId?: string | number; classType?: string },
): boolean {
    if (candidate.trackId !== trackId) return false;
    if (sourceClass.classId != null || sourceClass.classType) {
        return utils.sameAnnotationClass(candidate, sourceClass);
    }
    return true;
}

function matchesTrackId(candidate: { trackId?: string }, trackId: string): boolean {
    return candidate.trackId === trackId;
}

const REVIEW_PRESERVE_USER_DATA_KEYS = ['reviewedCorrect', 'reviewedCorrectVisible'] as const;

function buildSyncedUserDataPatch(
    fresh: Record<string, any>,
    existing: { userData?: IUserData } | undefined,
    reviewMode: boolean,
): IUserData {
    const userDataPatch: IUserData = {
        attrs: fresh.attrs,
        classType: fresh.classType,
        classId: fresh.classId,
        motionMode: fresh.motionMode,
        wallHeight: fresh.wallHeight,
        syncDistance: fresh.syncDistance,
        syncMaxDisappearGap: fresh.syncMaxDisappearGap,
        syncLocationGapMs: fresh.syncLocationGapMs,
        showSyncLocationBoundaries: fresh.showSyncLocationBoundaries,
        syncSegmentVisibility: fresh.syncSegmentVisibility === true,
        dynamicRangeSyncEnabled: fresh.dynamicRangeSyncEnabled,
        dynamicSyncPreviousFrames: fresh.dynamicSyncPreviousFrames,
        dynamicSyncNextFrames: fresh.dynamicSyncNextFrames,
        syncPoseSegmentId: fresh.syncPoseSegmentId,
        syncPoseSegmentsInitialized: fresh.syncPoseSegmentsInitialized,
        syncUseZ: fresh.syncUseZ,
        syncYawOffsetDeg: fresh.syncYawOffsetDeg,
        syncXOffsetM: fresh.syncXOffsetM,
        syncYOffsetM: fresh.syncYOffsetM,
        // A C-key orientation change is consumed by the backend during fixed-size sync.
        // Explicitly clear any local one-shot marker after the server refresh.
        pendingSyncQuarterTurns: undefined,
        occluded: fresh.occluded === true,
        syncDirty: fresh.syncDirty === true,
        reviewedCorrect: fresh.reviewedCorrect === true,
    };
    if (reviewMode && existing?.userData) {
        const localUserData = existing.userData as IUserData;
        REVIEW_PRESERVE_USER_DATA_KEYS.forEach((key) => {
            if (localUserData[key] !== undefined) {
                userDataPatch[key] = localUserData[key];
            }
        });
    }
    return userDataPatch;
}

function toGroundShapePoints(points: Array<{ x: number; y: number; z: number }>): THREE.Vector3[] {
    return points.map((point) => new THREE.Vector3(Number(point.x), Number(point.y), Number(point.z)));
}

const QA_NAVIGATOR_HOTKEY = 'alt+shift+j';
const QA_PREV_HOTKEY = 'alt+shift+q';
const QA_TYPE_HOTKEYS: Array<{ keys: string; code: string }> = [
    { keys: 'alt+shift+1', code: 'INVALID_SIZE' },
    { keys: 'alt+shift+2', code: 'SIZE_PRIOR' },
    { keys: 'alt+shift+3', code: 'ASPECT' },
    { keys: 'alt+shift+4', code: 'OVERLAP' },
    { keys: 'alt+shift+s', code: 'SIZE' },
    { keys: 'alt+shift+o', code: 'OVERLAP' },
];

const REVIEW_CORRECT_HOTKEY = 'r';
const REVIEW_NEXT_UNREVIEWED_HOTKEY = 'alt+n';
const OCCLUSION_HOTKEY = 'o';

export default class Editor extends BaseEditor {
    businessManager: BusinessManager;
    dataManager: DataManager;
    bsState: IBSState = getDefault();
    private syncKeydownHandler?: (event: KeyboardEvent) => void;
    private qaIssues: IQaIssue[] = [];
    private qaIssueIndex = 0;
    private qaTypeCycleCursor: Record<string, number> = {};
    private reviewStatusUpdating = new Set<string>();
    // Review navigation used to start at frame zero on every Alt+N press.  Keep a
    // cursor so a reviewer progresses through a long scene instead of repeatedly
    // querying the same leading batches.
    private reviewNavigationCursor?: number;
    private reviewNavigationRunning = false;
    parkingDensityManager: ParkingPointCloudDensityManager;
    constructor() {
        super();

        this.businessManager = new BusinessManager(this);
        this.dataManager = new DataManager(this);
        this.parkingDensityManager = new ParkingPointCloudDensityManager(this);
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

    async deleteTrackAcrossScene(trackId: string): Promise<void> {
        if (!trackId) {
            throw new Error('trackId is required to delete a tracked object');
        }
        const frame = this.getCurrentFrame();
        await api.deleteTrack(String(frame.id), trackId);
        this.dataManager.purgeTrackFromCachedFrames(trackId);
        this.trackManager.removeTrackObject(trackId);
        this.trackManager.trackInfo.delete(trackId);
        this.trackManager.trackFrameIndexMap.delete(trackId);
        if (this.currentTrack === trackId) {
            this.setCurrentTrack(undefined, '');
        }
        this.pc.render();
    }

    async splitGroundShapeTrack(pick: IGroundShapeSplitPick): Promise<boolean> {
        if (this.state.modeConfig.op !== OPType.EXECUTE) return false;
        const object = pick.object;
        const trackId = object.userData?.trackId;
        if (!trackId || !this.pc.selection.includes(object)) {
            this.showMsg('warning', '请先选中需要截断的 curb、wall 或不规则的路沿');
            return false;
        }

        let frameIds: string[];
        try {
            frameIds = await api.getTrackFrameIds(
                this.state.frames.map((frame) => frame.id),
                trackId,
            );
        } catch (error) {
            this.handleErr(error as any, '查询 Track 帧范围失败');
            return false;
        }
        if (frameIds.length === 0) {
            this.showMsg('warning', '当前 Track 没有可截断的帧');
            return false;
        }

        try {
            await this.showConfirm({
                title: '截断整条 Track',
                subTitle: `将截断全场景 ${frameIds.length} 帧，生成两个独立 Track。此操作不可撤销，是否继续？`,
                okText: '确认截断',
                cancelText: '取消',
                okDanger: true,
                centered: true,
            });
        } catch (_) {
            return false;
        }

        const saved = await this.saveObject(undefined, false, true);
        if (!saved) {
            this.showMsg('error', '未保存修改，截断已取消');
            return false;
        }

        this.showLoading({ type: 'loading', content: '正在截断整条 Track…' });
        try {
            const result = await api.splitTrack({
                dataId: this.getCurrentFrame().id,
                trackId,
                classId: object.userData?.classId || undefined,
                objectType: pick.objectType,
                side: pick.side,
                segmentIndex: pick.segmentIndex,
                t: pick.t,
            });
            const affected = (result.affectedDataIds || []).map((id) => String(id));
            this.setCurrentTrack(undefined, '');
            this.dataManager.invalidateFrameObjects(affected);
            this.trackManager.trackInfo.delete(trackId);
            this.trackManager.trackInfo.delete(result.newTrackId);
            this.trackManager.trackFrameIndexMap.delete(trackId);
            this.trackManager.trackFrameIndexMap.delete(result.newTrackId);
            await this.loadFrame(this.state.frameIndex, true, true);
            const newObject = (this.dataManager.getFrameObject(this.getCurrentFrame().id) || []).find(
                (candidate) =>
                    candidate.userData?.trackId === result.newTrackId &&
                    (candidate instanceof GroundPolyline || candidate instanceof IrregularWall),
            );
            this.loadManager.updateTrackMap();
            const affectedSet = new Set(affected);
            const affectedIndices = this.state.frames
                .map((frame, index) => (affectedSet.has(String(frame.id)) ? index : -1))
                .filter((index) => index >= 0);
            this.trackManager.setTrackFrameIndices(trackId, affectedIndices);
            this.trackManager.setTrackFrameIndices(result.newTrackId, affectedIndices);
            if (newObject) this.selectObject(newObject);
            this.showMsg(
                'success',
                `已截断 ${affected.length} 帧，新 Track：${result.newTrackName}`,
            );
            return true;
        } catch (error: any) {
            const failedFrames = error?.oriError?.response?.data?.data?.frameIds;
            this.showMsg(
                'error',
                Array.isArray(failedFrames) && failedFrames.length > 0
                    ? `截断失败，无法匹配帧：${failedFrames.join(', ')}`
                    : error?.message || 'Track 截断失败',
                8,
            );
            return false;
        } finally {
            this.showLoading(false);
        }
    }

    destroy(): void {
        this.parkingDensityManager?.destroy();
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
            hotkeys(QA_PREV_HOTKEY, (event) => {
                event.preventDefault();
                this.focusPrevQaIssue();
            });
            hotkeys(QA_NAVIGATOR_HOTKEY, (event) => {
                event.preventDefault();
                this.openQaIssueNavigator();
            });
            QA_TYPE_HOTKEYS.forEach(({ keys, code }) => {
                hotkeys(keys, (event) => {
                    event.preventDefault();
                    this.focusNextQaIssueInType(code);
                });
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
        if (this.reviewNavigationRunning) {
            this.showMsg('info', '正在查找未审阅目标，请稍候');
            return;
        }
        const batchSize = 200;
        const frames = this.state.frames;
        if (frames.length === 0) return;
        const startIndex =
            this.reviewNavigationCursor == null
                ? this.state.frameIndex
                : this.reviewNavigationCursor % frames.length;
        this.reviewNavigationRunning = true;
        try {
            for (let offset = 0; offset < frames.length; offset += batchSize) {
                const batch = Array.from(
                    { length: Math.min(batchSize, frames.length - offset) },
                    (_, batchIndex) => {
                        const frameIndex = (startIndex + offset + batchIndex) % frames.length;
                        return { frame: frames[frameIndex], frameIndex };
                    },
                );
                let data: any;
                try {
                    data = await this.businessManager.getFrameObject(batch.map(({ frame }) => frame));
                } catch (error) {
                    console.warn('find next unreviewed object failed', error);
                    this.showMsg('error', '未审阅目标查询失败');
                    return;
                }
                for (const { frame, frameIndex } of batch) {
                    const candidate = (
                        utils.objectsMapForFrame(data.objectsMap, frame.id) as any[]
                    ).find((object) => object.trackId && object.reviewedCorrect !== true);
                    if (!candidate) continue;
                    await this.loadFrame(frameIndex);
                    const object = (this.dataManager.getFrameObject(frame.id) || []).find((item: any) => {
                        const userData = item.userData || {};
                        return (
                            (item instanceof Box || isSyncableGroundShape(item)) &&
                            userData.trackId === candidate.trackId &&
                            userData.reviewedCorrect !== true
                        );
                    });
                    if (object) {
                        this.reviewNavigationCursor = (frameIndex + 1) % frames.length;
                        this.selectObject(object);
                        // Boxes have a meaningful Object3D position. Ground shapes use
                        // point arrays and are still selected by Alt+N, without jumping
                        // the camera to their default origin.
                        if (object instanceof Box) this.focusObject(object);
                        this.showMsg('success', `已定位未审阅目标。${REVIEW_NEXT_UNREVIEWED_HOTKEY.toUpperCase()} 下一个`, 3);
                        return;
                    }
                }
            }
            this.reviewNavigationCursor = 0;
            this.showMsg('success', '全部目标已审阅');
        } finally {
            this.reviewNavigationRunning = false;
        }
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
        const object = this.pc.selection.find(
            (item) => item instanceof Box || isSyncableGroundShape(item),
        ) as Box | SyncableGroundShape | undefined;
        const trackId = object?.userData?.trackId;
        if (!object || !trackId) {
            this.showMsg('warning', '请先选中一个有追踪ID的3D目标');
            return;
        }
        await this.setTrackReviewedCorrect(trackId, true);
        this.showMsg('success', `Track ${trackId} 已标记为正确`);
    }

    async toggleSelectedTrackReviewedCorrect() {
        const object = this.pc.selection.find(
            (item) => item instanceof Box || isSyncableGroundShape(item),
        ) as Box | SyncableGroundShape | undefined;
        const trackId = object?.userData?.trackId;
        if (!object || !trackId) {
            this.showMsg('warning', '请先选中一个有追踪ID的3D目标');
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
            this.updateObjectRenderInfo(this.trackManager.getObjects(trackId));
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
        let box = this.pc.selection.find(
            (e) => e instanceof Box || isSyncableGroundShape(e),
        ) as Box | SyncableGroundShape | undefined;
        if (!box) {
            const currentObjects = this.dataManager.getFrameObject(this.getCurrentFrame().id) || [];
            box = currentObjects.find(
                (e) =>
                    (e instanceof Box || isSyncableGroundShape(e)) &&
                    this.pc.selection.includes(e),
            ) as
                | Box
                | SyncableGroundShape
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
        const isStaticGroundShape = isSyncableGroundShape(box);
        let motionMode = isStaticGroundShape
            ? MotionMode.STATIC
            : box.userData?.motionMode || utils.getDefaultMotionMode(box.userData?.classType);
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
                    box,
                ),
            );
            this.showMsg(
                'success',
                dynamicRangeSyncEnabled
                    ? `已向前同步 ${normalizedPreviousFrames} 帧，向后同步 ${normalizedNextFrames} 帧`
                    : '已同步到全场景',
            );
        } catch (e: any) {
            console.warn('sync-mode propagation failed', e);
            this.showMsg('error', e?.message || '同步失败');
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
        sourceObject?: Box | SyncableGroundShape,
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
        const sourceFrameNeededSaveBeforeSync = sourceFrame.needSave;
        sourceFrame.needSave = true;
        // Persist every unsaved syncable 3D object on dirty loaded frames first. The selected
        // track is still the only one propagated by /sync, but other new boxes/polylines on
        // those frames must not stay local-only.
        const framesToSave = this.state.frames.filter((frame) => frame.needSave);
        if (!framesToSave.some((frame) => String(frame.id) === String(sourceFrame.id))) {
            framesToSave.push(sourceFrame);
        }
        const saved = await this.saveDirtySyncableObjects(
            framesToSave,
            sourceFrame,
            sourceObject,
        );
        if (!saved) {
            sourceFrame.needSave = sourceFrameNeededSaveBeforeSync;
            return;
        }
        try {
            const syncResult = await api.syncObject(String(sourceFrame.id), trackId, classId);
            await this.refreshTrackFromServer(
                trackId,
                sourceFrame.id,
                classId,
                classType,
                syncResult.affectedDataIds,
            );
        } finally {
            // The selected track was persisted through the partial sync-save endpoint.
            // Keep only dirty state that existed before sync so a later normal save does not
            // replace the complete source frame unnecessarily.
            sourceFrame.needSave = sourceFrameNeededSaveBeforeSync;
        }
    }

    async refreshTrackFromServer(
        trackId: string,
        sourceFrameId: string,
        classId?: string | number,
        classType?: string,
        affectedDataIds?: Array<string | number>,
    ) {
        // Refresh metadata for every loaded frame so backend-generated segment ids are available
        // immediately. The source frame keeps its local transform because it is the sync source.
        const sourceFrameKey = String(sourceFrameId);
        const affectedFrameIds = new Set((affectedDataIds || []).map((id) => String(id)));
        let frames = this.state.frames.filter(
            (frame) =>
                !!this.dataManager.getFrameObject(frame.id) &&
                (affectedFrameIds.size === 0 || affectedFrameIds.has(String(frame.id))),
        );
        if (frames.length === 0) return;
        const needSaveBeforeRefresh = new Map(
            frames.map((frame) => [String(frame.id), frame.needSave]),
        );

        let data: any;
        try {
            data = await api.getSyncTrackObjectBatch(frames.map((f) => f.id), trackId);
        } catch (e) {
            console.warn('refreshTrackFromServer: fetch failed', e);
            return;
        }

        let addDatas: { objects: any[]; frame: IFrame }[] = [];
        let removeDatas: { objects: SyncableGroundShape[]; frame: IFrame }[] = [];
        let updateTrans: { objects: Box[]; transforms: any[] } = { objects: [], transforms: [] };
        let updateDatas: { objects: Array<Box | SyncableGroundShape>; data: IUserData[] } = {
            objects: [],
            data: [],
        };
        let groundShapePointUpdates: {
            object: SyncableGroundShape;
            points: THREE.Vector3[];
            frame: IFrame;
        }[] = [];
        let groundPolylineHeightUpdates: {
            object: GroundPolyline;
            wallHeight: number;
        }[] = [];
        let irregularWallPointUpdates: {
            object: IrregularWall;
            bottomPoints: THREE.Vector3[];
            topPoints: THREE.Vector3[];
            frame: IFrame;
        }[] = [];
        // The sync endpoint is authoritative. Keep these references so a stale local
        // dirty flag cannot survive after the server confirms the target is clean.
        const cleanAfterServerRefresh = new Set<Box | SyncableGroundShape>();
        const sourceClass = { classId, classType };

        const resolvePrimaryShape = <T extends Box | SyncableGroundShape>(
            shapes: T[],
        ): T | undefined => {
            if (shapes.length === 0) return undefined;
            return (
                shapes.find((shape) => (shape.userData as IUserData).backId) ||
                shapes[0]
            );
        };

        const dedupeSyncedShapes = <T extends Box | SyncableGroundShape>(
            shapes: T[],
            frame: IFrame,
        ): T | undefined => {
            if (shapes.length <= 1) return shapes[0];
            const primary = resolvePrimaryShape(shapes);
            const duplicates = shapes.filter((shape) => shape !== primary);
            if (duplicates.length > 0) {
                this.dataManager.removeAnnotates(duplicates, frame, false, false);
            }
            return primary;
        };

        frames.forEach((frame) => {
            const frameObjects = this.dataManager.getFrameObject(frame.id) || [];
            const frameObjectsFromServer = utils.objectsMapForFrame(
                data.objectsMap,
                frame.id,
            ) as any[];

            const duplicateBoxes = frameObjects.filter(
                (object) =>
                    object instanceof Box &&
                    matchesTrackId(object.userData as IUserData, trackId),
            ) as Box[];
            const duplicateGroundShapes = frameObjects.filter(
                (object) =>
                    isSyncableGroundShape(object) &&
                    matchesTrackId(object.userData as IUserData, trackId),
            ) as SyncableGroundShape[];

            const freshBox = frameObjectsFromServer.find(
                (object) =>
                    matchesSyncedTrack(object, trackId, sourceClass) &&
                    object.center3D &&
                    object.size3D,
            );
            const freshGroundPolyline = frameObjectsFromServer.find((object) => {
                const objType = object.objType || object.type;
                return (
                    matchesSyncedTrack(object, trackId, sourceClass) &&
                    objType === ObjectType.TYPE_GROUND_POLYLINE &&
                    Array.isArray(object.points) &&
                    object.points.length >= 2
                );
            });
            const freshGroundPolygon = frameObjectsFromServer.find((object) => {
                const objType = object.objType || object.type;
                return (
                    matchesSyncedTrack(object, trackId, sourceClass) &&
                    objType === ObjectType.TYPE_GROUND_POLYGON &&
                    Array.isArray(object.points) &&
                    object.points.length === 4
                );
            });
            const freshIrregularWall = frameObjectsFromServer.find((object) => {
                const objType = object.objType || object.type;
                return matchesSyncedTrack(object, trackId, sourceClass) &&
                    objType === ObjectType.TYPE_IRREGULAR_WALL &&
                    Array.isArray(object.bottomPoints) && object.bottomPoints.length >= 2 &&
                    Array.isArray(object.topPoints) && object.topPoints.length !== 1;
            });

            let existingBox = dedupeSyncedShapes(duplicateBoxes, frame);
            let existingGroundPolyline = dedupeSyncedShapes(
                duplicateGroundShapes.filter((object) => object instanceof GroundPolyline),
                frame,
            );
            let existingGroundPolygon = dedupeSyncedShapes(
                duplicateGroundShapes.filter((object) => object instanceof GroundPolygon),
                frame,
            );
            let existingIrregularWall = dedupeSyncedShapes(
                duplicateGroundShapes.filter((object) => object instanceof IrregularWall),
                frame,
            );

            if (freshBox && !existingBox) {
                const annotate = utils.convertObject2Annotate([freshBox], this)[0];
                if (annotate) addDatas.push({ objects: [annotate], frame });
            } else if (freshBox && existingBox) {
                if (String(frame.id) !== sourceFrameKey) {
                    updateTrans.objects.push(existingBox);
                    updateTrans.transforms.push({
                        position: new THREE.Vector3(
                            freshBox.center3D.x,
                            freshBox.center3D.y,
                            freshBox.center3D.z,
                        ),
                        scale: new THREE.Vector3(
                            freshBox.size3D.x,
                            freshBox.size3D.y,
                            freshBox.size3D.z,
                        ),
                        rotation: new THREE.Euler(
                            freshBox.rotation3D?.x || 0,
                            freshBox.rotation3D?.y || 0,
                            freshBox.rotation3D?.z || 0,
                        ),
                    });
                }
                updateDatas.objects.push(existingBox);
                updateDatas.data.push(
                    buildSyncedUserDataPatch(freshBox, existingBox, this.bsState.reviewMode),
                );
                if (freshBox.syncDirty !== true) cleanAfterServerRefresh.add(existingBox);
            }

            if (freshGroundPolyline && !existingGroundPolyline) {
                const annotate = utils.convertObject2Annotate([freshGroundPolyline], this)[0];
                if (annotate) addDatas.push({ objects: [annotate], frame });
            } else if (freshGroundPolyline && existingGroundPolyline) {
                if (String(frame.id) !== sourceFrameKey) {
                    groundShapePointUpdates.push({
                        object: existingGroundPolyline,
                        points: toGroundShapePoints(freshGroundPolyline.points),
                        frame,
                    });
                }
                const wallHeight = Number(freshGroundPolyline.wallHeight);
                groundPolylineHeightUpdates.push({
                    object: existingGroundPolyline,
                    wallHeight: Number.isFinite(wallHeight) ? Math.max(0, wallHeight) : 0,
                });
                updateDatas.objects.push(existingGroundPolyline);
                updateDatas.data.push(
                    buildSyncedUserDataPatch(
                        freshGroundPolyline,
                        existingGroundPolyline,
                        this.bsState.reviewMode,
                    ),
                );
                if (freshGroundPolyline.syncDirty !== true) {
                    cleanAfterServerRefresh.add(existingGroundPolyline);
                }
            } else if (
                !freshGroundPolyline &&
                existingGroundPolyline &&
                String(frame.id) !== sourceFrameKey
            ) {
                removeDatas.push({ objects: [existingGroundPolyline], frame });
            }

            if (freshGroundPolygon && !existingGroundPolygon) {
                const annotate = utils.convertObject2Annotate([freshGroundPolygon], this)[0];
                if (annotate) addDatas.push({ objects: [annotate], frame });
            } else if (freshGroundPolygon && existingGroundPolygon) {
                if (String(frame.id) !== sourceFrameKey) {
                    groundShapePointUpdates.push({
                        object: existingGroundPolygon,
                        points: toGroundShapePoints(freshGroundPolygon.points),
                        frame,
                    });
                }
                updateDatas.objects.push(existingGroundPolygon);
                updateDatas.data.push(
                    buildSyncedUserDataPatch(
                        freshGroundPolygon,
                        existingGroundPolygon,
                        this.bsState.reviewMode,
                    ),
                );
                if (freshGroundPolygon.syncDirty !== true) {
                    cleanAfterServerRefresh.add(existingGroundPolygon);
                }
            } else if (
                !freshGroundPolygon &&
                existingGroundPolygon &&
                // The source frame has just been saved and is the sync truth.
                // A delayed/filtered batch response must not remove its local P
                // annotation during refresh; only target frames may be pruned.
                String(frame.id) !== sourceFrameKey
            ) {
                removeDatas.push({ objects: [existingGroundPolygon], frame });
            }

            if (freshIrregularWall && !existingIrregularWall) {
                const annotate = utils.convertObject2Annotate([freshIrregularWall], this)[0];
                if (annotate) addDatas.push({ objects: [annotate], frame });
            } else if (freshIrregularWall && existingIrregularWall) {
                if (String(frame.id) !== sourceFrameKey) {
                    irregularWallPointUpdates.push({
                        object: existingIrregularWall,
                        bottomPoints: toGroundShapePoints(freshIrregularWall.bottomPoints),
                        topPoints: toGroundShapePoints(freshIrregularWall.topPoints),
                        frame,
                    });
                }
                updateDatas.objects.push(existingIrregularWall);
                updateDatas.data.push(buildSyncedUserDataPatch(freshIrregularWall, existingIrregularWall, this.bsState.reviewMode));
                if (freshIrregularWall.syncDirty !== true) {
                    cleanAfterServerRefresh.add(existingIrregularWall);
                }
            } else if (
                !freshIrregularWall &&
                existingIrregularWall &&
                String(frame.id) !== sourceFrameKey
            ) {
                removeDatas.push({ objects: [existingIrregularWall], frame });
            }
        });

        this.withEventSource(Editor.SYNC_EVENT_SOURCE, () => {
            this.cmdManager.withGroup(() => {
                removeDatas.forEach(({ objects, frame }) => {
                    this.dataManager.removeAnnotates(objects, frame, false, false);
                });
                if (addDatas.length > 0) this.cmdManager.execute('add-object', addDatas);
                groundShapePointUpdates.forEach(({ object, points, frame }) => {
                    if (object instanceof GroundPolyline) {
                        const oldPointCount = object.points3D.length;
                        const newPointCount = points.length;
                        if (
                            String(frame.id) !== sourceFrameKey &&
                            newPointCount > oldPointCount
                        ) {
                            object.padNewSegmentsForAllViews(
                                oldPointCount,
                                newPointCount,
                                false,
                            );
                        }
                    }
                    this.dataManager.setGroundPolygonPoints(object, points, frame);
                });
                groundPolylineHeightUpdates.forEach(({ object, wallHeight }) => {
                    object.setWallHeight(wallHeight);
                });
                irregularWallPointUpdates.forEach(({ object, bottomPoints, topPoints }) => {
                    object.setPoints(bottomPoints, topPoints);
                });
                if (updateTrans.objects.length > 0)
                    this.cmdManager.execute('update-transform-batch', updateTrans);
                if (updateDatas.objects.length > 0)
                    this.cmdManager.execute('update-object-user-data', updateDatas);
            });
            if (
                removeDatas.length > 0 ||
                groundShapePointUpdates.length > 0 ||
                irregularWallPointUpdates.length > 0 ||
                addDatas.length > 0
            ) {
                this.dataManager.loadDataFromManager();
            }
        });
        if (cleanAfterServerRefresh.size > 0) {
            cleanAfterServerRefresh.forEach((object) => {
                (object.userData as IUserData).syncDirty = false;
            });
            this.updateObjectRenderInfo(Array.from(cleanAfterServerRefresh));
        }
        // Sync changes are already persisted by the backend. Refresh commands mark target
        // frames dirty as a side effect; restoring the previous state prevents a later full
        // frame save from deleting server objects missing from a stale local snapshot.
        frames.forEach((frame) => {
            frame.needSave = needSaveBeforeRefresh.get(String(frame.id)) === true;
        });
        this.invalidateTrackDisplayCaches();
        // Only the source frame is mounted with the current camera configuration.  Refreshing
        // target-frame polylines here would incorrectly render them through the source cameras
        // before their one-time, frame-local auto-occlusion calculation runs on first open.
        const syncedPolylines = (this.dataManager.getFrameObject(sourceFrameId) || []).filter(
            (object): object is GroundPolyline =>
                object instanceof GroundPolyline &&
                matchesSyncedTrack(object.userData as IUserData, trackId, sourceClass),
        );
        if (syncedPolylines.length > 0) {
            refreshGroundPolylineBevDisplay(this, syncedPolylines);
        }
        this.selectByTrackId(trackId);
        // The selected track does not change during sync, so CURRENT_TRACK_CHANGE will not fire.
        // Use a dedicated event: normal ANNOTATE_CHANGE listeners require an objects array.
        this.dispatchEvent({ type: Event.TRACK_SYNC_COMPLETE, data: { trackId } });
        this.pc.render();
    }

    /**
     * Persist unsaved 3D boxes and ground shapes through the partial sync-save endpoint.
     * This includes every track on the dirty frames, not only the one about to be synced.
     * Derived 2D projections are omitted so a later ordinary save can still write them.
     */
    private async saveDirtySyncableObjects(
        frames: IFrame[],
        sourceFrame?: IFrame,
        sourceObject?: Box | SyncableGroundShape,
    ): Promise<boolean> {
        if (this.bsState.saving) return false;
        const dataInfos = frames
            .map((frame) => {
                const trackObjects = (this.dataManager.getFrameObject(frame.id) || []).filter(
                    (object) => object instanceof Box || isSyncableGroundShape(object),
                ) as Array<Box | SyncableGroundShape>;
                // The context-menu selection can outlive a frame-cache refresh.  In that case
                // the object is visible and selected, but is absent from getFrameObject(), so
                // the old code sent an empty source to /sync/save.  Persist this exact source
                // object once; this endpoint is partial and never replaces other frame labels.
                if (
                    sourceObject &&
                    sourceFrame &&
                    String(frame.id) === String(sourceFrame.id)
                ) {
                    const sourceIndex = trackObjects.findIndex(
                        (object) =>
                            object === sourceObject ||
                            object.uuid === sourceObject.uuid ||
                            ((object.userData as IUserData).backId &&
                                (object.userData as IUserData).backId ===
                                    (sourceObject.userData as IUserData).backId),
                    );
                    if (sourceIndex >= 0) trackObjects[sourceIndex] = sourceObject;
                    else trackObjects.push(sourceObject);
                }
                const objects = utils.convertAnnotate2Object(trackObjects, this).map((object) => {
                    const classConfig = this.getClassType(object.classId || object.classType || '');
                    const objectV2 = utils.translateToObjectV2(object, classConfig);
                    return {
                        id: object.uuid || undefined,
                        frontId: object.frontId,
                        classId: classConfig?.id,
                        source: object.modelRun ? 'MODEL' : 'ARTIFICIAL',
                        sourceId: object.sourceId,
                        sourceType: object.sourceType,
                        promoteToHuman: object.manualModified === true,
                        classAttributes: objectV2,
                    };
                });
                return { dataId: frame.id, objects, dataAnnotations: [] };
            })
            .filter((dataInfo) => dataInfo.objects.length > 0);
        if (dataInfos.length === 0) return true;

        this.bsState.saving = true;
        try {
            const keyMap = await api.saveSyncObjects({
                datasetId: this.bsState.datasetId,
                dataInfos,
            });
            this.updateBackId(keyMap);
            return true;
        } catch (error) {
            console.error('track sync source save failed', error);
            return false;
        } finally {
            this.bsState.saving = false;
        }
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
            const frameBoxes: utils.AnnotationBoxCheckInput[] = [];
            objects.forEach((object: any) => {
                const userData = object.userData as IUserData;
                const label = userData.trackName || userData.trackId || userData.id || object.uuid;
                const classConfig = this.getClassType(userData);
                const className = classConfig?.name || userData.classType || '';
                const addIssue = (text: string, code?: QaIssueCode, targetObject: any = object) => {
                    violations.push({
                        frameId: String(frame.id),
                        frameName: frame.name || String(frame.id),
                        objectUuid: targetObject.uuid,
                        objectId: (targetObject.userData as IUserData).id || (targetObject.userData as IUserData).backId,
                        trackId: (targetObject.userData as IUserData).trackId,
                        label,
                        message: `${frame.name || frame.id}: ${label} ${text}`,
                        code,
                    });
                };
                if (!userData.classId && !userData.classType) {
                    addIssue('缺少类别');
                }
                if (object instanceof Box && !userData.trackId) {
                    addIssue('缺少追踪ID');
                }
                if (object instanceof Box) {
                    frameBoxes.push({
                        box: object,
                        className,
                        trackId: userData.trackId,
                    });
                    utils.checkAnnotationBoxSize(object, className).forEach((finding) => {
                        addIssue(finding.message, finding.code);
                    });
                    if (userData.motionMode === MotionMode.STATIC) {
                        const syncDistance = Number(userData.syncDistance || 12);
                        if (!Number.isFinite(syncDistance) || syncDistance <= 0) {
                            addIssue('同步距离异常');
                        }
                    }
                }
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
            utils.checkAnnotationFrameOverlaps(frameBoxes).forEach((finding) => {
                const primaryUserData = finding.primaryBox.userData as IUserData;
                const primaryLabel =
                    primaryUserData.trackName ||
                    primaryUserData.trackId ||
                    primaryUserData.id ||
                    finding.primaryBox.uuid;
                violations.push({
                    frameId: String(frame.id),
                    frameName: frame.name || String(frame.id),
                    objectUuid: finding.primaryBox.uuid,
                    objectId: primaryUserData.id || primaryUserData.backId,
                    trackId: primaryUserData.trackId,
                    label: primaryLabel,
                    message: `${frame.name || frame.id}: ${finding.message}`,
                    code: finding.code,
                });
            });
        });
        return violations;
    }

    getQaIssues(): IQaIssue[] {
        return [...this.qaIssues];
    }

    getQaIssueGlobalIndex(): number {
        return this.qaIssueIndex;
    }

    getQaIssueIndicesByType(typeId: string): number[] {
        return this.qaIssues
            .map((issue, globalIndex) => ({ issue, globalIndex }))
            .filter(({ issue }) => {
                if (typeId === 'ALL') {
                    return true;
                }
                if (typeId === 'OTHER') {
                    return !issue.code;
                }
                if (typeId === 'SIZE') {
                    return (
                        issue.code === 'INVALID_SIZE' ||
                        issue.code === 'SIZE_PRIOR' ||
                        issue.code === 'ASPECT'
                    );
                }
                return issue.code === typeId;
            })
            .map(({ globalIndex }) => globalIndex);
    }

    async focusQaIssueAt(globalIndex: number, showMessage = true): Promise<void> {
        if (globalIndex < 0 || globalIndex >= this.qaIssues.length) {
            this.showMsg('warning', `问题序号无效: ${globalIndex + 1}`);
            return;
        }
        this.qaIssueIndex = globalIndex;
        await this.focusQaIssue(this.qaIssues[globalIndex], showMessage);
    }

    async focusQaIssueByType(typeId: string, typeIndex = 0): Promise<void> {
        if (this.qaIssues.length === 0) {
            await this.runAutoCheck();
            if (this.qaIssues.length === 0) {
                return;
            }
        }
        const indices = this.getQaIssueIndicesByType(typeId);
        if (indices.length === 0) {
            const label =
                typeId === 'SIZE'
                    ? '尺寸相关'
                    : QA_ISSUE_CODE_LABELS[typeId] || typeId;
            this.showMsg('warning', `没有 ${label} 类型的问题`);
            return;
        }
        const safeIndex = Math.max(0, Math.min(typeIndex, indices.length - 1));
        await this.focusQaIssueAt(indices[safeIndex]);
    }

    async focusNextQaIssueInType(typeId: string): Promise<void> {
        if (this.qaIssues.length === 0) {
            await this.runAutoCheck();
            if (this.qaIssues.length === 0) {
                return;
            }
        }
        const indices = this.getQaIssueIndicesByType(typeId);
        if (indices.length === 0) {
            const label =
                typeId === 'SIZE'
                    ? '尺寸相关'
                    : QA_ISSUE_CODE_LABELS[typeId] || typeId;
            this.showMsg('warning', `没有 ${label} 类型的问题`);
            return;
        }
        const cursor = this.qaTypeCycleCursor[typeId] ?? -1;
        const nextPos = (cursor + 1) % indices.length;
        this.qaTypeCycleCursor[typeId] = nextPos;
        await this.focusQaIssueAt(indices[nextPos]);
    }

    async openQaIssueNavigator(): Promise<void> {
        if (this.qaIssues.length === 0) {
            await this.runAutoCheck();
            if (this.qaIssues.length === 0) {
                return;
            }
        }
        this.showModal('QaIssueNavigator', {
            title: 'QA 问题导航',
            width: 760,
        }).catch(() => {});
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
                `QA ${this.qaIssueIndex + 1}/${this.qaIssues.length}: ${issue.message}。Alt+Q 下一个，Alt+Shift+Q 上一个，Alt+Shift+J 问题列表`,
                8,
            );
        }
    }

    async focusPrevQaIssue() {
        if (this.qaIssues.length === 0) {
            await this.runAutoCheck();
            return;
        }
        this.qaIssueIndex = (this.qaIssueIndex - 1 + this.qaIssues.length) % this.qaIssues.length;
        await this.focusQaIssue(this.qaIssues[this.qaIssueIndex]);
    }

    async focusNextQaIssue() {
        if (this.qaIssues.length === 0) {
            await this.runAutoCheck();
            return;
        }
        this.qaIssueIndex = (this.qaIssueIndex + 1) % this.qaIssues.length;
        await this.focusQaIssue(this.qaIssues[this.qaIssueIndex]);
    }

    async runAutoCheck() {
        const { bsState } = this;
        if (bsState.checking || bsState.saving) {
            return;
        }
        if (this.dataManager.isInferenceRunning()) {
            this.showMsg(
                'warning',
                'Dataset inference is running. Auto check is disabled until the scene labels are refreshed.',
                8,
            );
            return;
        }

        bsState.checking = true;
        try {
            await this.loadManager.loadAllObjects();
            const violations = this.runQaLite(this.state.frames);
            this.qaIssues = violations;
            this.qaIssueIndex = 0;
            this.qaTypeCycleCursor = {};
            if (violations.length === 0) {
                this.showMsg('success', `Auto Check 完成：已检查 ${this.state.frames.length} 帧，未发现问题`);
                return;
            }
            await this.focusQaIssue(violations[0], false);
            this.showMsg(
                'warning',
                `Auto Check 发现 ${violations.length} 个问题（${this.state.frames.length} 帧）: ${violations[0].message}。Alt+Q 下一个，Alt+Shift+J 按类型/序号跳转`,
                8,
            );
        } catch (error: any) {
            console.error(error);
            this.showMsg('error', 'Auto Check 失败');
        } finally {
            bsState.checking = false;
        }
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

        if (frames.length === 0) return true;

        let dataInfos = [] as any[];
        let queryTime = frames[0].queryTime;
        frames.forEach((dataMeta) => {
            // if (dataMeta.skipped) return;
            if (!force && !dataMeta.needSave) return;
            let annotates = this.dataManager.getFrameObject(dataMeta.id) || [];
            if (new Date(dataMeta.queryTime).getTime() > new Date(queryTime).getTime())
                queryTime = dataMeta.queryTime;

            // result object
            let data = utils.convertAnnotate2Object(annotates, this) || [];
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

            // Frames introduced into the local cache by track sync may not have loaded
            // classification values. Saving their objects must not abort the whole sync.
            (dataMeta.classifications || []).forEach((classification) => {
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
                deletedObjectIds: this.dataManager.getDeletedObjectIds(dataMeta.id),
            });
        });

        let objectInfo = {
            datasetId: bsState.datasetId,
            dataInfos: dataInfos,
        };
        bsState.saving = true;
        try {
            await api.saveDelta(objectInfo).then((keyMap) => {
                this.updateBackId(keyMap);
            });
            dataInfos.forEach((dataInfo) => {
                this.dataManager.clearDeletedObjectIds(
                    dataInfo.dataId,
                    dataInfo.deletedObjectIds,
                );
            });
            frames.forEach((e) => {
                e.needSave = false;
            });
            if (!silent) {
                this.qaIssues = [];
                this.qaIssueIndex = 0;
                this.showMsg('success', this.lang('save-ok'));
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
    async getResultSources(frame?: IFrame, shouldApply: () => boolean = () => true) {
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
        if (shouldApply()) this.setSources(frame.sources);

        // let sourceMap = {};
        // sources.forEach((e) => {
        //     sourceMap[e.sourceId] = true;
        // });
        // state.sourceFilters = [state.config.withoutTaskId];
        // state.sources = sources;
    }
}
