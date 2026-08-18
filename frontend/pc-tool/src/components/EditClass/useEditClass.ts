import { reactive, onMounted, onBeforeUnmount, watch } from 'vue';
import { useClipboard } from '@vueuse/core';
import { AttrType, IClassType, Event, utils, IUserData, Const, MotionMode } from 'pc-editor';
import { AnnotateObject, Box, Rect } from 'pc-render';
import { useInjectState } from '../../state';
import { IState, IInstanceItem, MsgType, IControl } from './type';
import { useInjectEditor } from '../../state';
import * as _ from 'lodash';
import * as THREE from 'three';
import * as locale from './lang';
import useControl from './useControl';

let SOURCE_CLASS = 'edit_class';
const DEFAULT_SYNC_DISTANCE = 12;
const DEFAULT_SYNC_MAX_DISAPPEAR_GAP = 50;
const DEFAULT_SYNC_LOCATION_GAP_MS = 200;
const DEFAULT_DYNAMIC_SYNC_FRAME_COUNT = 1;
// type IEmit = (event: 'close', ...args: any[]) => void;

export default function useEditClass() {
    const { copy } = useClipboard();
    let editor = useInjectEditor();
    let editorState = useInjectState();
    let control = useControl();
    // object
    let trackAttrs = {} as Record<string, any>;
    let trackObject = {} as AnnotateObject;
    let tempObjects = [] as AnnotateObject[];
    // lang
    let $$ = editor.bindLocale(locale);

    let state = reactive<IState>({
        activeTab: ['attribute', 'objects', 'cuboid', 'motion'],
        showType: 'select',
        // batch
        batchVisible: true,
        isBatch: false,
        batchTrackIds: [],
        instances: [],
        filterInstances: [],
        modelClass: '',
        confidenceRange: [0.2, 1],
        //
        objectId: '',
        trackId: '',
        trackName: '',
        groupId: '',
        sourceType: '',
        occluded: false,
        reviewedCorrect: false,
        sensorDistance: 0,
        motionMode: '',
        syncDistance: DEFAULT_SYNC_DISTANCE,
        syncMaxDisappearGap: DEFAULT_SYNC_MAX_DISAPPEAR_GAP,
        syncLocationGapMs: DEFAULT_SYNC_LOCATION_GAP_MS,
        dynamicRangeSyncEnabled: false,
        dynamicSyncPreviousFrames: DEFAULT_DYNAMIC_SYNC_FRAME_COUNT,
        dynamicSyncNextFrames: DEFAULT_DYNAMIC_SYNC_FRAME_COUNT,
        syncPoseSegmentId: undefined,
        syncPoseSegmentsInitialized: undefined,
        syncUseZ: true,
        syncYawOffsetDeg: 0,
        syncXOffsetM: 0,
        syncYOffsetM: 0,
        syncing: false,
        trackVisible: false,
        isStandard: false,
        resultStatus: '',
        resultType: '',
        resultInstances: [],
        annotateType: '',
        classType: '',
        isClassStandard: false,
        isInvisible: false,
        attrs: [],
        // msg
        showMsgType: '',
        //
    });
    watch(
        () => [state.confidenceRange, state.instances],
        () => {
            let [min, max] = state.confidenceRange;
            let filterInstances = state.instances.filter((e) => {
                let confidence = e.confidence || 0;
                return confidence >= min && confidence <= max;
            });
            let objectMap = {} as Record<string, AnnotateObject>;
            tempObjects.forEach((e) => {
                objectMap[e.uuid] = e;
            });
            let noVisible = filterInstances.filter((e) => !objectMap[e.id].visible);
            state.filterInstances = filterInstances;
            state.batchVisible = noVisible.length === 0;
        },
    );

    let update = _.debounce(() => {
        if (!control.needUpdate()) return;
        clear();
        console.log('class edit update');
        if (state.isBatch) {
            showBatchObject(state.batchTrackIds);
        } else {
            showObject(state.trackId);
        }
    }, 100);
    const onShowClassInfo = (data: any) => {
        let trackIds = data.data.id;
        state.showType = 'msg';
        handleObject(trackIds);
    };

    onMounted(() => {
        editor.addEventListener(Event.SHOW_CLASS_INFO, onShowClassInfo);
        editor.addEventListener(Event.ANNOTATE_SELECT, onSelect);
        editor.addEventListener(Event.ANNOTATE_REMOVE, syncUpdate);
        editor.addEventListener(Event.ANNOTATE_ADD, syncUpdate);
        editor.addEventListener(Event.ANNOTATE_CHANGE, syncUpdate);
    });

    onBeforeUnmount(() => {
        editor.removeEventListener(Event.SHOW_CLASS_INFO, onShowClassInfo);
        editor.removeEventListener(Event.ANNOTATE_SELECT, onSelect);
        editor.removeEventListener(Event.ANNOTATE_REMOVE, syncUpdate);
        editor.removeEventListener(Event.ANNOTATE_ADD, syncUpdate);
        editor.removeEventListener(Event.ANNOTATE_CHANGE, syncUpdate);
        update.cancel();
    });

    function onClearMergeSplit() {
        if (
            state.showMsgType === 'split' ||
            state.showMsgType === 'merge-from' ||
            state.showMsgType === 'merge-to'
        ) {
            state.showMsgType = '';
        }
    }

    function onSelect(data: any) {
        let selection = data.data.curSelection as AnnotateObject[];
        if (selection.length > 0) {
            state.showType = 'select';
            handleObject(selection[0].userData.trackId);
        } else {
            if (state.showType === 'select') close();
        }
    }

    function syncUpdate() {
        if (editor.eventSource === SOURCE_CLASS) return;
        update();
    }

    function handleObject(trackId: string | string[]) {
        if (Array.isArray(trackId)) {
            state.batchTrackIds = trackId;
            state.isBatch = true;
        } else {
            state.trackId = trackId;
            state.isBatch = false;
        }
        update();
    }

    function clear() {
        state.batchVisible = true;
        state.classType = '';
        state.isClassStandard = false;
        state.isStandard = false;
        state.isInvisible = false;
        state.resultType = '';
        state.resultStatus = '';
        state.resultInstances = [];
        state.objectId = '';
        state.trackName = '';
        state.groupId = '';
        state.occluded = false;
        state.reviewedCorrect = false;
        state.sensorDistance = 0;
        state.sourceType = '';
        state.motionMode = '';
        state.syncDistance = DEFAULT_SYNC_DISTANCE;
        state.syncMaxDisappearGap = DEFAULT_SYNC_MAX_DISAPPEAR_GAP;
        state.syncLocationGapMs = DEFAULT_SYNC_LOCATION_GAP_MS;
        state.dynamicRangeSyncEnabled = false;
        state.dynamicSyncPreviousFrames = DEFAULT_DYNAMIC_SYNC_FRAME_COUNT;
        state.dynamicSyncNextFrames = DEFAULT_DYNAMIC_SYNC_FRAME_COUNT;
        state.syncPoseSegmentId = undefined;
        state.syncPoseSegmentsInitialized = undefined;
        state.syncUseZ = true;
        state.syncYawOffsetDeg = 0;
        state.syncXOffsetM = 0;
        state.syncYOffsetM = 0;
        state.trackVisible = false;
        state.annotateType = '';

        state.modelClass = '';
        state.instances = [];
        state.attrs = [];
        state.showMsgType = '';

        // state.trackId = '';
        // state.isBatch = false;
    }

    function close() {
        // emit('close');
        control.close();
    }

    function showBatchObject(trackIds: string[]) {
        let trackIdMap = {};
        trackIds.forEach((id) => (trackIdMap[id] = true));
        let objects = editor.pc
            .getAnnotate3D()
            .filter((e) => trackIdMap[e.userData.trackId]) as AnnotateObject[];

        if (objects.length === 0) {
            close();
            return;
        }

        let object = objects[0];
        state.objectId = new Date().getTime() + '';
        state.modelClass = (object.userData as IUserData).modelClass || '';
        state.classType = object.userData.classId || object.userData.classType || '';
        state.groupId = (object.userData as IUserData).groupId || '';
        state.sourceType = (object.userData as IUserData).sourceType || '';
        state.occluded = objects.some((object) => object.userData?.occluded === true);
        state.reviewedCorrect = objects.every(
            (object) => object.userData?.reviewedCorrect === true,
        );
        state.sensorDistance = object instanceof Box ? getSensorDistance(object) : 0;
        state.motionMode =
            (object.userData as IUserData).motionMode ||
            utils.getDefaultMotionMode((object.userData as IUserData).classType);
        state.syncDistance = getSyncDistance(object.userData as IUserData);
        state.syncMaxDisappearGap = getSyncMaxDisappearGap(object.userData as IUserData);
        state.syncLocationGapMs = getSyncLocationGapMs(object.userData as IUserData);
        state.dynamicRangeSyncEnabled =
            (object.userData as IUserData).dynamicRangeSyncEnabled === true;
        state.dynamicSyncPreviousFrames = getDynamicSyncFrameCount(
            (object.userData as IUserData).dynamicSyncPreviousFrames,
        );
        state.dynamicSyncNextFrames = getDynamicSyncFrameCount(
            (object.userData as IUserData).dynamicSyncNextFrames,
        );
        state.syncPoseSegmentId = (object.userData as IUserData).syncPoseSegmentId;
        state.syncPoseSegmentsInitialized = (object.userData as IUserData).syncPoseSegmentsInitialized;
        state.syncUseZ = getSyncUseZ(object.userData as IUserData);
        state.syncYawOffsetDeg = getSyncYawOffsetDeg(object.userData as IUserData);
        state.syncXOffsetM = getSyncOffsetM(object.userData as IUserData, 'syncXOffsetM');
        state.syncYOffsetM = getSyncOffsetM(object.userData as IUserData, 'syncYOffsetM');

        let confidenceMax = 0;
        let confidenceMin = 1;
        let instances: IInstanceItem[] = objects.map((e) => {
            let name = e.userData.trackName || '';
            let confidence = e.userData.confidence || 1;
            if (confidence > confidenceMax) confidenceMax = confidence;
            if (confidence < confidenceMin) confidenceMin = confidence;
            return { id: e.uuid, name: name, confidence: confidence };
        });

        let confidenceMinFix = +confidenceMin.toFixed(2);
        confidenceMinFix = Math.max(confidenceMinFix - 0.01, 0);
        let confidenceMaxFix = +confidenceMax.toFixed(2);
        confidenceMaxFix = Math.min(confidenceMaxFix + 0.01, 1);

        state.instances = instances;
        state.confidenceRange = [confidenceMinFix, confidenceMaxFix];

        tempObjects = objects;
    }

    function showObject(trackId: string) {
        let annotate2d = editor.pc.getAnnotate2D();
        let annotate3d = editor.pc.getAnnotate3D();

        let info = getAnnotateByTrackId([...annotate3d, ...annotate2d], trackId);

        if (info.annotate3D.length === 0 && info.annotate2D.length === 0) {
            close();
            return;
        }

        let object = info.annotate3D.length > 0 ? info.annotate3D[0] : info.annotate2D[0];
        let userData = editor.getObjectUserData(object);

        state.objectId = object.uuid;
        state.modelClass = userData.modelClass || '';
        state.classType = userData.classId || userData.classType || '';
        // state.isInvisible = !!userData.invisibleFlag;
        state.trackId = userData.trackId || '';
        state.trackName = userData.trackName || '';
        state.groupId = userData.groupId || '';
        state.sourceType = userData.sourceType || '';
        state.occluded = userData.occluded === true;
        state.reviewedCorrect = userData.reviewedCorrect === true;
        state.sensorDistance = object instanceof Box ? getSensorDistance(object as Box) : 0;
        state.motionMode = userData.motionMode || utils.getDefaultMotionMode(userData.classType);
        state.syncDistance = getSyncDistance(userData);
        state.syncMaxDisappearGap = getSyncMaxDisappearGap(userData);
        state.syncLocationGapMs = getSyncLocationGapMs(userData);
        state.dynamicRangeSyncEnabled = userData.dynamicRangeSyncEnabled === true;
        state.dynamicSyncPreviousFrames = getDynamicSyncFrameCount(
            userData.dynamicSyncPreviousFrames,
        );
        state.dynamicSyncNextFrames = getDynamicSyncFrameCount(userData.dynamicSyncNextFrames);
        state.syncPoseSegmentId = userData.syncPoseSegmentId;
        state.syncPoseSegmentsInitialized = userData.syncPoseSegmentsInitialized;
        state.syncUseZ = getSyncUseZ(userData);
        state.syncYawOffsetDeg = getSyncYawOffsetDeg(userData);
        state.syncXOffsetM = getSyncOffsetM(userData, 'syncXOffsetM');
        state.syncYOffsetM = getSyncOffsetM(userData, 'syncYOffsetM');
        // state.isStandard = userData.isStandard || false;
        // state.resultStatus = userData.resultStatus || Const.True_Value;
        // state.resultType = userData.resultType || Const.Dynamic;

        // temp
        trackObject = object;
        tempObjects = [...info.annotate3D, ...info.annotate2D];

        let trackVisible = false;
        let rectTitle = $$('rect-title');
        let boxTitle = $$('box-title');
        state.resultInstances = tempObjects.map((e) => {
            let userData = e.userData as Required<IUserData>;
            let is3D = e instanceof Box;
            let info = $$('cloud-object');
            if (!is3D) {
                let isRect = e instanceof Rect;
                let index = get2DIndex((e as Rect).viewId);
                info = $$('image-object', {
                    index: index + 1,
                    type: isRect ? rectTitle : boxTitle,
                });
                // info = `Image ${index + 1} Object(${isRect ? 'Rect' : 'Box'})`;
            }

            if (e.visible) trackVisible = true;

            return { id: e.uuid, name: userData.id.slice(-4), info, confidence: 0 };
        });

        state.trackVisible = trackVisible;
        // state.annotateType = object.annotateType;
        if (state.classType) {
            updateAttrInfo(userData, state.classType);
            updateClassInfo();
        }
    }

    function updateAttrInfo(userData: IUserData, classType: string) {
        let classConfig = editor.getClassType(classType);
        if (!classConfig) return;
        let attrs = userData.attrs || {};
        // let newAttrs = classConfig.attrs.map((e) => {
        //     let defaultValue = e.type === AttrType.MULTI_SELECTION ? [] : '';
        //     // The array type may be a single value
        //     if (e.type === AttrType.MULTI_SELECTION && attrs[e.id] && !Array.isArray(attrs[e.id])) {
        //         attrs[e.id] = [attrs[e.id]];
        //     }
        //     let value = e.id in attrs ? attrs[e.id] : defaultValue;
        //     return { ...e, value };
        // });
        // state.attrs = newAttrs;
        state.attrs = utils.copyClassAttrs(classConfig, attrs);
        trackAttrs = JSON.parse(JSON.stringify(attrs));
    }

    function onInstanceRemove(item: IInstanceItem) {
        state.instances = state.instances.filter((e) => e.id !== item.id);
        tempObjects = tempObjects.filter((e) => e.uuid !== item.id);
    }

    function onToggleObjectsVisible() {
        let visible = !state.batchVisible;
        state.batchVisible = visible;

        let objects = getFilterObjects();
        if (objects.length > 0) {
            // pc.setVisible(objects, visible);
            editor.cmdManager.execute('toggle-visible', { objects: objects, visible });
        }
    }

    function getFilterObjects() {
        let insMap = {};
        state.filterInstances.forEach((e) => (insMap[e.id] = true));
        let objects = tempObjects.filter((e) => insMap[e.uuid]);
        return objects;
    }

    function onRemoveObjects() {
        if (tempObjects.length === 0) return;
        editor
            .showConfirm({ title: $$('msg-delete-title'), subTitle: $$('msg-delete-subtitle') })
            .then(
                () => {
                    let objects = getFilterObjects();
                    editor.cmdManager.execute('delete-object', [{ objects: objects }]);

                    let [min, max] = state.confidenceRange;
                    state.instances = state.instances.filter(
                        (e) => !(e.confidence >= min && e.confidence <= max),
                    );
                    if (state.instances.length === 0) close();
                },
                () => {},
            );
    }

    function updateClassInfo() {
        let classConfig = editor.getClassType(state.classType);
        if (!classConfig) return;

        state.isClassStandard = classConfig.type === 'standard';
    }

    function onClassChange() {
        if (state.isBatch) {
            updateClassMulti();
            return;
        }

        updateClassInfo();

        // let classConfig = editor.getClassType(state.classType);
        // let size3D = undefined;
        const { isSeriesFrame, frameIndex, frames } = editor.state;
        let classConfig = editor.getClassType(state.classType);
        let userData = {
            classType: classConfig?.name,
            classId: classConfig?.id,
            attrs: {},
            resultStatus: Const.True_Value,
        } as IUserData;

        editor.cmdManager.withGroup(() => {
            editor.trackManager.setTrackData(state.trackId, {
                userData: { classType: userData.classType, classId: userData.classId },
            });

            editor.trackManager.setDataByTrackId(
                state.trackId,
                {
                    userData: userData,
                },
                isSeriesFrame ? frames : [editor.getCurrentFrame()],
            );
        });

        state.resultStatus = Const.True_Value;
        updateAttrInfo(trackObject.userData, state.classType);
    }

    function getSyncDistance(userData?: IUserData) {
        const value = Number(userData?.syncDistance);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_SYNC_DISTANCE;
    }

    function getSyncUseZ(userData?: IUserData) {
        return userData?.syncUseZ !== false;
    }

    function getSyncMaxDisappearGap(userData?: IUserData) {
        const value = Number(userData?.syncMaxDisappearGap);
        return Number.isInteger(value) && value >= 0 ? value : DEFAULT_SYNC_MAX_DISAPPEAR_GAP;
    }

    function getSyncLocationGapMs(userData?: IUserData): number {
        const value = Number(userData?.syncLocationGapMs);
        return Number.isInteger(value) && value > 0 ? value : DEFAULT_SYNC_LOCATION_GAP_MS;
    }

    function getDynamicSyncFrameCount(value?: number): number {
        const frameCount = Number(value);
        return Number.isInteger(frameCount) && frameCount >= 0
            ? frameCount
            : DEFAULT_DYNAMIC_SYNC_FRAME_COUNT;
    }

    function getSyncYawOffsetDeg(userData?: IUserData) {
        const value = Number(userData?.syncYawOffsetDeg);
        return Number.isFinite(value) ? value : 0;
    }

    function getSyncOffsetM(userData: IUserData | undefined, key: 'syncXOffsetM' | 'syncYOffsetM') {
        const value = Number(userData?.[key]);
        return Number.isFinite(value) ? value : 0;
    }

    function getSensorDistance(object: Box) {
        const halfX = Math.max(Math.abs(object.scale.x) / 2, 0);
        const halfY = Math.max(Math.abs(object.scale.y) / 2, 0);
        const dx = -object.position.x;
        const dy = -object.position.y;
        const yaw = object.rotation.z || 0;
        const localX = dx * Math.cos(yaw) + dy * Math.sin(yaw);
        const localY = -dx * Math.sin(yaw) + dy * Math.cos(yaw);
        const outsideX = Math.max(Math.abs(localX) - halfX, 0);
        const outsideY = Math.max(Math.abs(localY) - halfY, 0);
        return Math.sqrt(outsideX * outsideX + outsideY * outsideY);
    }

    function onGroupIdChange() {
        const objects = state.isBatch
            ? tempObjects
            : tempObjects.filter((object) => object.userData?.trackId === state.trackId);
        if (objects.length === 0) return;
        editor.cmdManager.execute('update-object-user-data', {
            objects,
            data: { groupId: state.groupId },
        });
    }

    function onOccludedChange() {
        const objects = state.isBatch
            ? tempObjects
            : tempObjects.filter((object) => object.userData?.trackId === state.trackId);
        if (objects.length === 0) return;
        const occluded = state.occluded === true;
        const data = objects.map((object) => {
            const classConfig = editor.getClassType(object.userData || {});
            return utils.getOccludedUserDataPatch(classConfig, object.userData, occluded);
        });
        applyOcclusionStateToAttrPanel(occluded);
        editor.cmdManager.execute('update-object-user-data', {
            objects,
            data,
        });
    }

    function onReviewedCorrectChange() {
        if (!state.trackId) return;
        editor.setTrackReviewedCorrect(state.trackId, state.reviewedCorrect === true);
    }

    // Writes sync settings only onto this track's object(s) in the current frame. During a manual
    // sync the current frame is the source of truth; saving loaded sibling frames here would let
    // stale cached boxes trigger backend sync again and overwrite the user's latest edit.
    function applyMotionSettingsToTrack(trackId: string, motionMode: MotionMode) {
        const frame = editor.getCurrentFrame();
        const objects = (editor.dataManager.getFrameObject(frame.id) || []).filter(
            (object) => object.userData?.trackId === trackId,
        );
        if (objects.length === 0) return;
        editor.cmdManager.execute('update-object-user-data', {
            objects,
            data: {
                motionMode,
                syncDistance: state.syncDistance,
                syncMaxDisappearGap: state.syncMaxDisappearGap,
                syncLocationGapMs: state.syncLocationGapMs,
                dynamicRangeSyncEnabled: state.dynamicRangeSyncEnabled,
                dynamicSyncPreviousFrames: state.dynamicSyncPreviousFrames,
                dynamicSyncNextFrames: state.dynamicSyncNextFrames,
                syncPoseSegmentId: state.syncPoseSegmentId,
                syncPoseSegmentsInitialized: state.syncPoseSegmentsInitialized,
                syncUseZ: state.syncUseZ,
                syncYawOffsetDeg: state.syncYawOffsetDeg,
                syncXOffsetM: state.syncXOffsetM,
                syncYOffsetM: state.syncYOffsetM,
            },
        });
    }

    function onMotionModeChange() {
        if (state.isBatch) {
            onMotionModeChangeMulti();
            return;
        }
        const motionMode = state.motionMode as MotionMode;
        applyMotionSettingsToTrack(state.trackId, motionMode);
    }

    function onSyncDistanceChange(value?: number) {
        const nextValue = Number(value);
        state.syncDistance =
            Number.isFinite(nextValue) && nextValue > 0 ? nextValue : DEFAULT_SYNC_DISTANCE;
        if (!state.trackId || !state.motionMode) return;
        applyMotionSettingsToTrack(state.trackId, state.motionMode as MotionMode);
    }

    function onSyncMaxDisappearGapChange(value?: number) {
        const nextValue = Number(value);
        state.syncMaxDisappearGap =
            Number.isInteger(nextValue) && nextValue >= 0
                ? nextValue
                : DEFAULT_SYNC_MAX_DISAPPEAR_GAP;
        if (!state.trackId || !state.motionMode) return;
        applyMotionSettingsToTrack(state.trackId, state.motionMode as MotionMode);
    }

    function onSyncLocationGapMsChange(value?: number): void {
        const nextValue = Number(value);
        state.syncLocationGapMs =
            Number.isInteger(nextValue) && nextValue > 0
                ? nextValue
                : DEFAULT_SYNC_LOCATION_GAP_MS;
        if (!state.trackId || !state.motionMode) return;
        applyMotionSettingsToTrack(state.trackId, state.motionMode as MotionMode);
    }

    function applyDynamicRangeSettingsChange(): void {
        if (!state.motionMode) return;
        if (state.isBatch) {
            editor.cmdManager.execute('update-object-user-data', {
                objects: tempObjects,
                data: {
                    dynamicRangeSyncEnabled: state.dynamicRangeSyncEnabled,
                    dynamicSyncPreviousFrames: state.dynamicSyncPreviousFrames,
                    dynamicSyncNextFrames: state.dynamicSyncNextFrames,
                },
            });
            return;
        }
        if (!state.trackId) return;
        applyMotionSettingsToTrack(state.trackId, state.motionMode as MotionMode);
    }

    function onDynamicRangeSyncEnabledChange(): void {
        state.dynamicRangeSyncEnabled = state.dynamicRangeSyncEnabled === true;
        applyDynamicRangeSettingsChange();
    }

    function onDynamicSyncPreviousFramesChange(value?: number): void {
        state.dynamicSyncPreviousFrames = getDynamicSyncFrameCount(value);
        applyDynamicRangeSettingsChange();
    }

    function onDynamicSyncNextFramesChange(value?: number): void {
        state.dynamicSyncNextFrames = getDynamicSyncFrameCount(value);
        applyDynamicRangeSettingsChange();
    }

    function onSyncUseZChange() {
        if (!state.trackId || !state.motionMode) return;
        applyMotionSettingsToTrack(state.trackId, state.motionMode as MotionMode);
    }

    function onSyncYawOffsetChange(value?: number) {
        const nextValue = Number(value);
        state.syncYawOffsetDeg = Number.isFinite(nextValue) ? nextValue : 0;
        if (!state.trackId || !state.motionMode) return;
        applyMotionSettingsToTrack(state.trackId, state.motionMode as MotionMode);
    }

    function onSyncXYOffsetChange(axis: 'x' | 'y', value?: number) {
        const nextValue = Number(value);
        const offset = Number.isFinite(nextValue) ? nextValue : 0;
        if (axis === 'x') state.syncXOffsetM = offset;
        else state.syncYOffsetM = offset;
        if (!state.trackId || !state.motionMode) return;
        applyMotionSettingsToTrack(state.trackId, state.motionMode as MotionMode);
    }

    async function onSyncClick() {
        if (state.isBatch) {
            await onSyncClickMulti();
            return;
        }
        state.syncing = true;
        try {
            if (state.trackId && state.motionMode) {
                applyMotionSettingsToTrack(state.trackId, state.motionMode as MotionMode);
            }
            // Use the same selected-object path as Ctrl/Cmd+Y. The reactive panel state can
            // briefly lag behind a box transform or selection change, while the editor reads
            // the track and motion mode directly from the current selected box.
            await editor.syncSelectedTrack();
        } catch (e) {
            console.warn(e);
            editor.showMsg('error', $$('msg-sync-fail'));
        } finally {
            state.syncing = false;
        }
    }

    async function onSyncClickMulti() {
        const motionMode = state.motionMode as MotionMode;
        if (!motionMode) return;
        const objects = getFilterObjects();
        const trackIdMap = {} as Record<string, boolean>;
        objects.forEach((e) => (trackIdMap[e.userData.trackId] = true));
        const trackIds = Object.keys(trackIdMap);
        if (trackIds.length === 0) return;
        state.syncing = true;
        try {
            await editor.runWithSyncLock(async () => {
                for (let i = 0; i < trackIds.length; i++) {
                    editor.showLoading({
                        type: 'loading',
                        content: `${$$('msg-syncing')} (${i + 1}/${trackIds.length})`,
                    });
                    applyMotionSettingsToTrack(trackIds[i], motionMode);
                    const trackObject = objects.find((e) => e.userData.trackId === trackIds[i]);
                    await editor.syncMotionMode(
                        trackIds[i],
                        motionMode,
                        undefined,
                        trackObject?.userData.classId,
                        trackObject?.userData.classType,
                    );
                }
            });
            editor.showMsg('success', $$('msg-sync-success'));
        } catch (e) {
            console.warn(e);
            editor.showMsg('error', $$('msg-sync-fail'));
        } finally {
            state.syncing = false;
            editor.showLoading(false);
        }
    }

    function onMotionModeChangeMulti() {
        const motionMode = state.motionMode as MotionMode;
        editor.cmdManager.execute('update-object-user-data', {
            objects: tempObjects,
            data: {
                motionMode,
                syncDistance: state.syncDistance,
                syncMaxDisappearGap: state.syncMaxDisappearGap,
                syncLocationGapMs: state.syncLocationGapMs,
                dynamicRangeSyncEnabled: state.dynamicRangeSyncEnabled,
                dynamicSyncPreviousFrames: state.dynamicSyncPreviousFrames,
                dynamicSyncNextFrames: state.dynamicSyncNextFrames,
                syncPoseSegmentId: state.syncPoseSegmentId,
                syncPoseSegmentsInitialized: state.syncPoseSegmentsInitialized,
                syncUseZ: state.syncUseZ,
                syncYawOffsetDeg: state.syncYawOffsetDeg,
                syncXOffsetM: state.syncXOffsetM,
                syncYOffsetM: state.syncYOffsetM,
            },
        });
    }

    function updateClassMulti() {
        let { frameIndex, frames } = editor.state;

        let objects = getFilterObjects();
        let trackIdMap = {};
        objects.forEach((e) => (trackIdMap[e.userData.trackId] = true));
        let ids = Object.keys(trackIdMap);
        if (ids.length === 0) return;

        // let userData = {} as IUserData;
        // userData.classType = state.classType;
        // userData.attrs = {};
        // userData.resultStatus = Const.True_Value;
        let classConfig = editor.getClassType(state.classType);
        editor.cmdManager.execute('update-object-user-data', {
            objects: tempObjects,

            data: {
                classType: classConfig?.name,
                classId: classConfig?.id,
            },
        });
    }

    // attr
    let updateTrackAttr = _.debounce(() => {
        editor.withEventSource(SOURCE_CLASS, () => {
            let attrs = JSON.parse(JSON.stringify(trackAttrs));
            editor.cmdManager.execute('update-object-user-data', {
                objects: tempObjects,
                data: { attrs },
            });
        });
    }, 100);

    function onAttChange(name: string, value: any) {
        trackAttrs[name] = value;
        const classConfig = editor.getClassType(state.classType);
        const occlusionAttr = utils.getOcclusionAttr(classConfig);
        if (occlusionAttr && occlusionAttr.id === name) {
            state.occluded = utils.isOcclusionAttrValue(classConfig, value);
            const objects = state.isBatch
                ? tempObjects
                : tempObjects.filter((object) => object.userData?.trackId === state.trackId);
            if (objects.length > 0) {
                editor.cmdManager.execute('update-object-user-data', {
                    objects,
                    data: { occluded: state.occluded },
                });
            }
        }
        updateTrackAttr();
        state.resultStatus = Const.True_Value;
    }

    function applyOcclusionStateToAttrPanel(occluded: boolean) {
        const classConfig = editor.getClassType(state.classType);
        const occlusionAttr = utils.getOcclusionAttr(classConfig);
        const value = utils.getOcclusionAttrValue(classConfig, occluded);
        if (!occlusionAttr || value === undefined) return;
        trackAttrs[occlusionAttr.id] = value;
        const panelAttr = state.attrs.find((attr) => attr.id === occlusionAttr.id);
        if (panelAttr) panelAttr.value = value;
    }

    function onObjectInstanceRemove(item: IInstanceItem) {
        state.showType = 'msg';
        let annotate = tempObjects.find((e) => e.uuid === item.id);
        tempObjects = tempObjects.filter((e) => e.uuid !== item.id);
        if (annotate) {
            editor.cmdManager.withGroup(() => {
                if (tempObjects.length > 0) {
                    editor.cmdManager.execute('select-object', tempObjects);
                }
                editor.cmdManager.execute('delete-object', annotate);
            });
        }

        if (tempObjects.length === 0) {
            close();
        }
    }

    function copyAttrFrom(trackId: string) {
        // console.log(trackId);
        let box = editor.pc.getAnnotate3D().find((e) => e.userData.trackId === trackId) as Box;
        if (box) {
            let attrs = JSON.parse(JSON.stringify(box.userData.attrs));
            editor.cmdManager.execute('update-object-user-data', {
                objects: tempObjects,
                data: { attrs: attrs },
            });
            trackObject.userData.attrs = attrs;
            updateAttrInfo(trackObject.userData, state.classType);
            editor.showMsg('success', $$('msg-copy-success'));
        } else {
            editor.showMsg('error', $$('msg-no-object'));
        }
    }

    function onToggleTrackVisible() {
        let visible = !state.trackVisible;
        state.trackVisible = visible;

        let objects = tempObjects;
        state.showType = 'msg';
        editor.cmdManager.execute('toggle-visible', { objects, visible });
    }

    function onCopy() {
        copy(state.trackId);
        editor.showMsg('success', $$('copy-success'));
    }

    return {
        state,
        update,
        control,
        onAttChange,
        onClassChange,
        onGroupIdChange,
        onOccludedChange,
        onReviewedCorrectChange,
        onMotionModeChange,
        onSyncDistanceChange,
        onSyncMaxDisappearGapChange,
        onSyncLocationGapMsChange,
        onDynamicRangeSyncEnabledChange,
        onDynamicSyncPreviousFramesChange,
        onDynamicSyncNextFramesChange,
        onSyncUseZChange,
        onSyncYawOffsetChange,
        onSyncXYOffsetChange,
        onSyncClick,
        onInstanceRemove,
        onToggleObjectsVisible,
        onRemoveObjects,
        // onObjectStatusChange,
        onObjectInstanceRemove,
        copyAttrFrom,
        // copyAttrTo,
        onToggleTrackVisible,
        // toggleStandard,
    };
}

function getAnnotateByTrackId(annotates: AnnotateObject[], trackId: string) {
    let annotate3D = [] as AnnotateObject[];
    let annotate2D = [] as AnnotateObject[];
    annotates.forEach((obj) => {
        let userData = obj.userData as Required<IUserData>;
        if (userData.trackId !== trackId) return;

        if (obj instanceof Box) {
            annotate3D.push(obj);
        } else {
            annotate2D.push(obj);
        }
    });

    return { annotate2D, annotate3D };
}

function get2DIndex(viewId: string) {
    return parseInt((viewId.match(/[0-9]{1,5}$/) as any)[0]);
}

function getControl() {}
