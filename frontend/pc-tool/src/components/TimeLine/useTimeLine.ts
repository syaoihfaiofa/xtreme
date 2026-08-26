import { reactive, onMounted, onBeforeUnmount, watch, ref } from 'vue';
import {
    Event as EditorEvent,
    Const,
    ObjectType,
    IFrame,
    IObject,
    IUserData,
    utils,
} from 'pc-editor';
import * as THREE from 'three';
import * as _ from 'lodash';
import * as api from '../../api/common';
// import ToolEvent from '../../config/event';
import { useInjectEditor } from '../../state';
import { getPrimaryTrackFrameObject } from './trackFrameData';

const COLOR = new THREE.Color();

export interface IConfig {
    noModelTrack?: boolean;
}

export type ITrackAction =
    | 'Split'
    | 'Delete'
    | 'MergeTo'
    | 'MergeFrom'
    | 'PreSplit'
    | 'PreMergeTo'
    | 'PreMergeFrom'
    | 'Cancel'
    | '';
export interface ITrackObject {
    trackId: string;
    trackName: string;
    list: IUserData[];
}
export type IMsgOption = {
    target: {
        x: number;
        y: number;
    };
    data: {
        msg: { class: string; msg: string }[];
    };
    visible: boolean;
};

export interface IBottomState {
    tip: (option: IMsgOption) => void;
    _config: IConfig;
    colorMap: {};
    // play
    playSpeed: number;
    playStart: number;
    play: boolean;
    animation: number;
    trackSplitIndex: number;
    annotationStatus: boolean[];
    reviewProgress: boolean[];
    trackFrameMask: boolean[];
    segmentBoundaries: boolean[];
    showAnnotation: boolean;

    trackTargetLine: ITrackObject;

    trackList: ITrackObject[];

    trackMergeCode: string;
    trackSplitClass: string;
    trackSplitTrackId: string;
    trackMergeErrFrame: number[]; // 合并冲突帧
    trackPinSelected: string; //

    trackMergeResult: ITrackObject;
    trackAction: ITrackAction; // 操作行为

    activeType: {
        classType: any;
        modelClass: any;
    };
    frameConfig: {
        curFrameIndex: number;
        interval: number;
        spanWidth: number;
        // showProcess: boolean;
    };
}
export default function useBottom() {
    const editor = useInjectEditor();
    const zoomContainer = ref<HTMLElement>();
    const iState = reactive<IBottomState>({
        tip: async (option: IMsgOption) => {},
        _config: {},
        colorMap: {},
        playSpeed: 1,
        playStart: 0,
        play: false,
        animation: 1,
        // trackFlag: true,
        trackList: [],
        annotationStatus: [],
        reviewProgress: [],
        trackFrameMask: [],
        segmentBoundaries: [],
        showAnnotation: false,
        // trackPinList: [],
        trackSplitIndex: -1,
        trackSplitClass: '',
        trackSplitTrackId: '',
        trackTargetLine: { trackId: '', trackName: '', list: [] },
        trackMergeResult: { trackId: '', trackName: '', list: [] },
        trackMergeCode: 'ok',
        // 合并冲突帧
        trackMergeErrFrame: [],
        // 操作行为
        trackAction: '',
        trackPinSelected: '',
        activeType: {
            classType: undefined as any,
            modelClass: undefined as any,
        },
        frameConfig: {
            curFrameIndex: editor.state.frameIndex + 1,
            interval: 5, // default 5
            spanWidth: 18,
            // showProcess: false,
        },
    });
    let reviewProgressRequest = 0;
    let trackLineRequest = 0;
    let segmentBoundaryRequest = 0;
    const trackLineCache = new Map<string, IUserData[]>();
    let trackLineCacheKey = '';
    let trackLineLoadingKey = '';
    let trackLineCachePromise: Promise<void> | null = null;
    const segmentBoundaryCache = new Map<string, boolean[]>();
    const maxSegmentBoundaryCacheEntries = 20;
    const cacheSegmentBoundaries = (key: string, boundaries: boolean[]) => {
        segmentBoundaryCache.delete(key);
        segmentBoundaryCache.set(key, boundaries);
        while (segmentBoundaryCache.size > maxSegmentBoundaryCacheEntries) {
            const oldestKey = segmentBoundaryCache.keys().next().value;
            if (oldestKey === undefined) break;
            segmentBoundaryCache.delete(oldestKey);
        }
    };
    //@ts-ignore
    window.iSState = iState;
    watch(
        () => editor.state.classTypes,
        (classTypes) => {
            const colorMap = {};
            classTypes.forEach((item) => {
                colorMap[item.id] = item.color;
                colorMap[`false_${item.id}`] = `#${COLOR.set(item.color).getHexString()}aa`;
            });
            iState.colorMap = colorMap;
        },
        { immediate: true },
    );

    watch(
        () => editor.state.frameIndex,
        () => {
            iState.frameConfig.curFrameIndex = editor.state.frameIndex + 1;
        },
    );
    watch(
        () => editor.state.frames,
        () => {
            if (iState.trackTargetLine.list.length !== editor.state.frames.length) {
                iState.trackTargetLine = emptyTrackObject();
                iState.segmentBoundaries = [];
            }
            updateReviewProgress();
            updateTrackFrameMask();
            void prefetchTrackLines();
            if (editor.bsState.reviewMode) refreshReviewProgressFromServer();
        },
        {
            immediate: true,
            deep: true,
        },
    );
    watch(
        () => editor.bsState.reviewMode,
        (reviewMode) => {
            if (reviewMode) refreshReviewProgressFromServer();
        },
        { immediate: true },
    );
    watch(
        () => editor.state.config.filterFramesByTrack,
        () => updateTrackFrameMask(),
        { immediate: true },
    );
    watch(
        () => [
            editor.state.config.filterFramesByComment,
            editor.state.config.commentFrameIds.join(','),
        ],
        () => updateTrackFrameMask(),
        { immediate: true },
    );

    onMounted(() => {
        editor.addEventListener(EditorEvent.CURRENT_TRACK_CHANGE, onSelect);
        editor.playManager.addEventListener(EditorEvent.PLAY_STOP, onFrameStop);
        // editor.addEventListener(EditorEvent.PRE_MERGE_ACTION, onPreMergeEvent);
        // editor.addEventListener(EditorEvent.PRE_SPLIT_ACTION, onPreSplitEvent);
        // editor.addEventListener(EditorEvent.UPDATE_TIME_LINE, onUpdate);
        editor.addEventListener(EditorEvent.ANNOTATE_CHANGE, onUpdate);
        editor.addEventListener(EditorEvent.ANNOTATE_ADD, onUpdate);
        editor.addEventListener(EditorEvent.ANNOTATE_LOAD, onAnnotateLoad);
        // editor.addEventListener(EditorEvent.ANNOTATE_CLEAR, onUpdate);
        editor.addEventListener(EditorEvent.ANNOTATE_TRANSFORM_CHANGE, onUpdate);
        // editor.addEventListener(EditorEvent.VALID_CHANGE, onUpdate);
        editor.cmdManager.addEventListener(EditorEvent.UNDO, onUpdate);
        editor.cmdManager.addEventListener(EditorEvent.REDO, onUpdate);
        updateReviewProgress();
        updateTrackFrameMask();
        if (editor.bsState.reviewMode) refreshReviewProgressFromServer();
        // editor.addEventListener(EditorEvent.CLEAR_MERGE_SPLIT, onClear);
        if (zoomContainer.value) {
            const container = zoomContainer.value as HTMLElement;
            container.addEventListener('wheel', onMouseWheel);
        }
    });

    onBeforeUnmount(() => {
        editor.removeEventListener(EditorEvent.CURRENT_TRACK_CHANGE, onSelect);
        editor.playManager.removeEventListener(EditorEvent.PLAY_STOP, onFrameStop);
        editor.removeEventListener(EditorEvent.ANNOTATE_CHANGE, onUpdate);
        editor.removeEventListener(EditorEvent.ANNOTATE_ADD, onUpdate);
        editor.removeEventListener(EditorEvent.ANNOTATE_LOAD, onAnnotateLoad);
        editor.removeEventListener(EditorEvent.ANNOTATE_TRANSFORM_CHANGE, onUpdate);
        // editor.removeEventListener(EditorEvent.PRE_MERGE_ACTION, onPreMergeEvent);
        // editor.removeEventListener(EditorEvent.PRE_SPLIT_ACTION, onPreSplitEvent);
        // editor.removeEventListener(EditorEvent.UPDATE_TIME_LINE, onUpdate);
        // editor.removeEventListener(EditorEvent.VALID_CHANGE, onUpdate);
        editor.removeEventListener(EditorEvent.ANNOTATE_CLEAR, onUpdate);
        editor.cmdManager.removeEventListener(EditorEvent.UNDO, onUpdate);
        editor.cmdManager.removeEventListener(EditorEvent.REDO, onUpdate);
        // editor.removeEventListener(EditorEvent.CLEAR_MERGE_SPLIT, onClear);
        if (zoomContainer.value) {
            const container = zoomContainer.value as HTMLElement;
            container.removeEventListener('wheel', onMouseWheel);
        }
        refreshSegmentBoundaries.cancel();
        reviewProgressRequest += 1;
        trackLineRequest += 1;
        segmentBoundaryRequest += 1;
        trackLineCache.clear();
        trackLineCacheKey = '';
        segmentBoundaryCache.clear();
        //@ts-ignore
        if (window.iSState === iState) window.iSState = undefined;
    });

    // function updateAnnotationStatus() {
    //     const trackId = editor.currentTrack;
    //     const length = editor.state.frames.length;
    //     const annotations = editor.state.annotations;
    //     const annotationStatus = Array(length);
    //     let showAnnotation = false;

    //     if (trackId) {
    //         const objectMap: Record<string, any> = annotations.reduce((map, obj) => {
    //             const { data, type, dataId } = obj;
    //             if (type === 'object') {
    //                 map[data.uuid] = editor.getFrameIndex(dataId);
    //             }
    //             return map;
    //         }, {});
    //         const objects = editor.trackManager.getObjects(trackId);
    //         objects.forEach((item) => {
    //             if (item) {
    //                 if (objectMap.hasOwnProperty(item.uuid)) {
    //                     annotationStatus[objectMap[item.uuid]] = true;
    //                     showAnnotation = true;
    //                 }
    //             }
    //         });
    //     } else {
    //         annotations.forEach((item) => {
    //             annotationStatus[editor.getFrameIndex(item.dataId)] = true;
    //         });
    //         showAnnotation = annotations.length > 0;
    //     }
    //     iState.annotationStatus = annotationStatus;
    //     iState.showAnnotation = showAnnotation;
    // }

    function onFrameStop() {
        iState.play = false;
        editor.loadManager.loadFrame(editor.state.frameIndex, false, true);
    }

    // ------
    // 时间轴 缩放
    function onMouseWheel(event: WheelEvent) {
        // return;

        event.preventDefault();

        if (event.deltaY < 0) {
            if (++iState.frameConfig.spanWidth > 36) {
                iState.frameConfig.spanWidth = 36;
            }
        } else {
            if (--iState.frameConfig.spanWidth < 14) {
                iState.frameConfig.spanWidth = 14;
            }
        }

        iState.frameConfig.interval = iState.frameConfig.spanWidth < 18 ? 10 : 5;
    }

    function onPreMergeEvent(data: any) {
        const { trackId, action, trackName } = data.data;

        if (action === 'cancel') {
            onHandleTrackAction('Cancel');
            return;
        }

        if (!trackId || !action) {
            return;
        }
        Object.assign(iState.trackMergeResult, {
            trackId: trackId,
            trackName: trackName,
        });
        switch (action) {
            case 'merge-to':
                onHandleTrackAction('PreMergeTo');
                break;
            case 'merge-from':
                onHandleTrackAction('PreMergeFrom');
                break;
            default:
                break;
        }
    }

    function onPreSplitEvent(data: any) {
        const { classId, action, trackId } = data.data;
        if (action === 'cancel') {
            onHandleTrackAction('Cancel');
        } else if (action === 'split') {
            iState.trackSplitClass = classId;
            iState.trackSplitTrackId = trackId;
            onHandleTrackAction('PreSplit');
        }
    }

    // function setInvisibleFlag(frameIndex: number, invisible: boolean) {
    //     const trackId = iState.trackTargetLine.trackId;
    //     if (!trackId) return;
    //     editor.toggleInvisible(trackId, invisible);
    //     updateTrackLine();
    // }

    function onPreTrackAction(action: ITrackAction) {
        const trackTargetId = iState.trackTargetLine.trackId;
        const { frames, frameIndex } = editor.state;
        if (!trackTargetId) {
            onClear();

            editor.showMsg('warning', editor.lang('selectObject'));

            return;
        }

        switch (action) {
            case 'PreSplit':
                iState.trackSplitIndex = frameIndex;
                onPreSplitData();
                break;
            case 'PreMergeTo':
            case 'PreMergeFrom':
                if (!iState.trackMergeResult.trackId) {
                    onClear();
                    // tool.editor.showMsg('warning', 'Please chose track object trackId');
                } else {
                    onPreMergeData();
                }
                break;
            default:
                break;
        }
    }

    const onHandleTrackAction = _.debounce((action: ITrackAction) => {
        iState.trackAction = action;
        switch (action) {
            case 'Cancel':
                onClear();
                break;
            case 'PreSplit':
            case 'PreMergeFrom':
            case 'PreMergeTo':
                onPreTrackAction(action);
                break;
            case 'MergeTo':
            case 'MergeFrom':
                onMerge();
                break;
            case 'Split':
                onSplit();
                break;
            case 'Delete':
                onDelete();
                break;
            default:
            case '':
                break;
        }
    }, 100);
    function onDelete() {
        const trackTargetId = iState.trackTargetLine.trackId;
        if (!trackTargetId) {
            editor.showMsg('warning', editor.lang('warnNoObject'));
            return;
        }
        editor
            .showConfirm({
                title: editor.lang('btnDelete'),
                subTitle: editor.lang('deleteTitle'),
                okText: editor.lang('btnDelete'),
                cancelText: editor.lang('btnCancelText'),
                okDanger: true,
            })
            .then(
                async () => {
                    try {
                        await editor.deleteTrackAcrossScene(trackTargetId);
                        editor.pc.selectObject(editor.pc.selection);
                        editor.showMsg('success', editor.lang('successDelete'));
                        onClear();
                    } catch (error) {
                        editor.showMsg('error', editor.lang('errorDelete'));
                    }
                },
                () => {},
            );
    }
    function updateMergeCodeMsg() {
        const trackIdMerge = iState.trackMergeResult.trackId;

        const trackId = iState.trackTargetLine.trackId;
        const { code, data } = editor.trackManager.canMerge(trackId, trackIdMerge);

        iState.trackMergeCode = code;

        if (code === 'object_repeat') {
            iState.trackMergeErrFrame = data || [];
        } else {
            iState.trackMergeErrFrame = [];
        }
    }
    // 合并预览
    function onPreMergeData() {
        const trackIdMerge = iState.trackMergeResult.trackId;
        const trackName = iState.trackMergeResult.trackName;
        const trackId = iState.trackTargetLine.trackId;

        if (!trackId || !trackIdMerge) return;

        updateMergeCodeMsg();

        const trackList: any[] = [];

        // const frameCount = tool.state.dataList.length;

        const mergeTargetTrackList: IUserData[] = getTrackLine(trackIdMerge);

        trackList.push({
            trackName: trackName,
            trackId: trackIdMerge,
            list: mergeTargetTrackList,
        });

        iState.trackList = trackList;
    }
    // 拆分预览
    function onPreSplitData() {
        const trackId = iState.trackTargetLine.trackId;
        const list = iState.trackTargetLine.list;
        const dataIndex = iState.trackSplitIndex;
        if (!trackId || dataIndex < 0) return;
        const frameCount = list.length;
        if (!iState.trackSplitTrackId) {
            iState.trackSplitTrackId = editor.createTrackId();
        }
        const trackIdNew = iState.trackSplitTrackId;
        const trackListMap: ITrackObject[] = [];
        const beforeList = Array(frameCount);
        const afterList = Array(frameCount);
        const classType = iState.trackSplitClass;
        list.forEach((item, index) => {
            if (!item) return;
            if (index < dataIndex) {
                beforeList[index] = item;
            } else {
                afterList[index] = { ...item, classType: classType };
            }
        });
        trackListMap.push({
            trackName: iState.trackTargetLine.trackName,
            trackId: trackId,
            list: beforeList,
        });

        trackListMap.push({
            trackName: '',
            trackId: trackIdNew,
            list: afterList,
        });

        iState.trackList = trackListMap;
    }
    // 合并
    function onMerge() {
        const curTrackId = iState.trackTargetLine.trackId;
        const mergeTrackId = iState.trackMergeResult.trackId;
        const trackMergeCode = iState.trackMergeCode;
        if (trackMergeCode !== 'ok') {
            let msg = 'error';
            switch (trackMergeCode) {
                case 'classType_diff':
                    msg = editor.lang('warnClassTypeDiff');
                    break;
                case 'object_repeat':
                    msg = editor.lang('warnObjectRepeat');
                    break;
                default:
                    break;
            }
            editor.showMsg('warning', msg);
            return;
        }
        try {
            switch (iState.trackAction) {
                case 'MergeFrom':
                    editor.trackManager.mergeTrackObject(mergeTrackId, curTrackId);
                    updateTrackLine(true);
                    break;

                case 'MergeTo':
                    editor.trackManager.mergeTrackObject(curTrackId, mergeTrackId);
                    editor.selectByTrackId(mergeTrackId);
                    break;

                default:
                    break;
            }
            onClear();
            editor.showMsg('success', editor.lang('successMerge'));
        } catch (error) {
            editor.showMsg('error', editor.lang('errorMerge'));
        }
    }
    // 拆分
    function onSplit() {
        const trackId = iState.trackTargetLine.trackId;
        const start = iState.trackSplitIndex;

        const canSplit = editor.trackManager.canSplit(trackId, start);

        if (!canSplit) {
            editor.showMsg('warning', editor.lang('warnEmptyObject'));
            return;
        }
        try {
            const splitTrackId = iState.trackList[1].trackId;
            const classConfig = editor.getClassType(iState.trackSplitClass);
            editor.trackManager.splitTrackObject({
                trackId: trackId,
                start: start,
                userData: {
                    trackId: splitTrackId,
                    classId: iState.trackSplitClass,
                    classType: classConfig.name,
                },
            });
            onClear();
            updateTrackLine();
            editor.showMsg('success', editor.lang('successSplit'));
        } catch (error) {
            editor.showMsg('error', editor.lang('errorSplit'));
        }
    }
    function updateTrackFrameSlot(frameIndex: number, refreshSegments: boolean = false) {
        const trackId = editor.currentTrack;
        if (!trackId || trackId !== iState.trackTargetLine.trackId) return;
        if (frameIndex < 0 || frameIndex >= iState.trackTargetLine.list.length) return;
        iState.trackTargetLine.list[frameIndex] = getTrackFrameData(
            trackId,
            frameIndex,
        ) as IUserData;
        if (refreshSegments) {
            iState.segmentBoundaries = getSegmentBoundaries(iState.trackTargetLine.list);
            refreshSegmentBoundaries(trackId, iState.trackTargetLine.list);
        }
    }

    function handleTrackActionPreview() {
        const trackIds = [
            ...iState.trackList.map((item) => item.trackId),
            iState.trackMergeResult.trackId,
        ];
        if (editor.currentTrack && trackIds.indexOf(editor.currentTrack) < 0) return;
        const { trackAction } = iState;
        switch (trackAction) {
            case 'PreMergeFrom':
            case 'PreMergeTo':
                updateMergeCodeMsg();
            // falls through
            case 'PreSplit':
                onPreTrackAction(trackAction);
                break;
        }
    }

    // 更新当前TrackLine
    function updateTrackLine(
        force: boolean = false,
        refreshSegments: boolean = false,
        refreshFromServer: boolean = true,
    ) {
        const trackId = editor.currentTrack;
        if (trackId && trackId === iState.trackTargetLine.trackId && !force) return;
        if (trackId) {
            const trackChanged = trackId !== iState.trackTargetLine.trackId;
            Object.assign(iState.trackTargetLine, {
                trackId: trackId,
                trackName: editor.trackManager.trackMap.get(trackId + '')?.trackName || '',
            });
            iState.trackTargetLine.list = getTrackLine(trackId);
            if (trackChanged || refreshSegments) {
                iState.segmentBoundaries = getSegmentBoundaries(iState.trackTargetLine.list);
                refreshSegmentBoundaries(trackId, iState.trackTargetLine.list);
            }
            if (refreshFromServer) {
                refreshTrackLineFromServer(trackId);
            }
        } else {
            segmentBoundaryRequest++;
            refreshSegmentBoundaries.cancel();
            iState.trackTargetLine = emptyTrackObject();
            iState.segmentBoundaries = [];
        }
        updateTrackFrameMask();
    }

    function getSegmentBoundaries(trackList: IUserData[]): boolean[] {
        const boundaries = trackList.map(() => false);
        let previousSegmentId: string | undefined;
        trackList.forEach((userData, index) => {
            const segmentId = userData?.syncPoseSegmentId;
            if (segmentId === undefined || segmentId === null) return;
            const normalizedSegmentId = String(segmentId);
            if (previousSegmentId !== undefined && normalizedSegmentId !== previousSegmentId) {
                boundaries[index] = true;
            }
            previousSegmentId = normalizedSegmentId;
        });
        return boundaries;
    }

    function getSegmentBoundariesFromFrames(segmentByDataId: Record<string, number>): boolean[] {
        const boundaries = editor.state.frames.map(() => false);
        let previousSegmentId: number | undefined;
        editor.state.frames.forEach((frame, index) => {
            const segmentId = segmentByDataId[String(frame.id)];
            if (segmentId === undefined || segmentId === null) return;
            if (previousSegmentId !== undefined && segmentId !== previousSegmentId) {
                boundaries[index] = true;
            }
            previousSegmentId = segmentId;
        });
        return boundaries;
    }

    const refreshSegmentBoundaries = _.debounce(
        async (trackId: string, trackList: IUserData[]) => {
            const sourceIndex = trackList.findIndex((userData) => !!userData);
            const sourceFrame = editor.state.frames[sourceIndex];
            if (!sourceFrame) return;
            const locationGapMs = trackList[sourceIndex]?.syncLocationGapMs ?? 200;
            const sceneFrameId = editor.state.frames[0]?.id;
            const cacheKey = `${sceneFrameId}:${locationGapMs}`;
            const cachedBoundaries = segmentBoundaryCache.get(cacheKey);
            if (cachedBoundaries) {
                iState.segmentBoundaries = [...cachedBoundaries];
                return;
            }
            const requestId = ++segmentBoundaryRequest;
            try {
                const segmentByDataId = await api.getSyncSegments(String(sourceFrame.id), trackId);
                if (requestId !== segmentBoundaryRequest || editor.currentTrack !== trackId) return;
                if (Object.keys(segmentByDataId).length > 0) {
                    const boundaries = getSegmentBoundariesFromFrames(segmentByDataId);
                    cacheSegmentBoundaries(cacheKey, boundaries);
                    iState.segmentBoundaries = [...boundaries];
                }
            } catch (error) {
                console.warn('load location segment boundaries failed', error);
            }
        },
        200,
    );

    function updateTrackFrameMask() {
        if (editor.isCommentFrameFilterActive()) {
            const commentFrameIds = new Set(editor.state.config.commentFrameIds.map(String));
            iState.trackFrameMask = editor.state.frames.map((frame) =>
                commentFrameIds.has(String(frame.id)),
            );
            return;
        }
        if (!editor.isTrackFrameFilterActive()) {
            iState.trackFrameMask = editor.state.frames.map(() => true);
            return;
        }
        const visibleIndices = new Set(
            editor.trackManager.getTrackFrameIndices(editor.currentTrack),
        );
        iState.trackFrameMask = editor.state.frames.map((_, index) => visibleIndices.has(index));
    }

    function updateReviewProgress() {
        iState.reviewProgress = editor.state.frames.map((frame, index) => {
            const loaded =
                editor.dataManager.dataMap.has(frame.id) ||
                editor.dataManager.dataMap.has(String(frame.id));
            if (!loaded) {
                return iState.reviewProgress[index] ?? false;
            }
            const objects = (editor.dataManager.getFrameObject(frame.id) || []).filter(isReviewTarget);
            // Frames without tracked targets require no review action.
            return objects.every(isReviewTargetReviewed);
        });
    }

    // A review is a Track-level decision for the 3D cuboid. 2D projection boxes
    // share its track id but are not independently reviewed.
    function isReviewTarget(object: any) {
        const userData = object.userData || object;
        const objectType = object.objectType || object.objType || object.type;
        return (
            !!userData.trackId &&
            (objectType === ObjectType.TYPE_3D_BOX ||
                objectType === ObjectType.TYPE_3D ||
                (!!object.center3D && !!object.size3D))
        );
    }

    function isReviewTargetReviewed(object: any) {
        const userData = object.userData || object;
        const trackReviewStatus = editor.trackManager.getTrackObject(userData.trackId)?.reviewedCorrect;
        return userData.reviewedCorrect === true || trackReviewStatus === true;
    }

    async function refreshReviewProgressFromServer() {
        const frames = [...editor.state.frames];
        if (frames.length === 0) return;
        const requestId = ++reviewProgressRequest;
        try {
            const data = await editor.businessManager.getFrameObject(frames);
            if (requestId !== reviewProgressRequest) return;
            iState.reviewProgress = frames.map((frame) => {
                const objects = (data.objectsMap?.[frame.id] || []).filter(isReviewTarget);
                return objects.every(isReviewTargetReviewed);
            });
        } catch (error) {
            console.warn('load review progress failed', error);
        }
    }

    function getTrackLine(trackId: string) {
        const length = editor.state.frames.length;
        if (!trackId) return Array(length);
        const localList = editor.trackManager.getTrackObjectMap(trackId)[trackId] || Array(length);
        const cachedList = trackLineCache.get(trackId);
        return editor.state.frames.map(
            (_, frameIndex) =>
                toTrackFrameData(localList[frameIndex]) ?? cachedList?.[frameIndex],
        );
    }

    function toTrackFrameDataFromServer(objects: IObject[]): IUserData | undefined {
        if (!objects || objects.length === 0) return undefined;
        const object = objects[0];
        return {
            trackId: object.trackId,
            trackName: object.trackName,
            classId: object.classId,
            classType: object.classType,
            motionMode: object.motionMode,
            syncPoseSegmentId: object.syncPoseSegmentId,
            syncPoseSegmentsInitialized: object.syncPoseSegmentsInitialized,
            syncLocationGapMs: object.syncLocationGapMs,
            syncDirty: object.syncDirty === true,
            occluded: object.occluded === true,
            reviewedCorrect: object.reviewedCorrect === true,
            invalid: false,
            trueValue: object.resultStatus === Const.True_Value,
        } as IUserData;
    }

    function applyTrackLineList(serverList: IUserData[]) {
        if (iState.trackTargetLine.list.length !== serverList.length) {
            iState.trackTargetLine.list = serverList;
            return;
        }
        serverList.forEach((userData, frameIndex) => {
            iState.trackTargetLine.list[frameIndex] = userData;
        });
    }

    function getFramesCacheKey(frames: IFrame[]): string {
        return frames.map((frame) => String(frame.id)).join(',');
    }

    async function prefetchTrackLines(force: boolean = false): Promise<void> {
        const frames = [...editor.state.frames];
        const cacheKey = getFramesCacheKey(frames);
        if (frames.length === 0) {
            trackLineCache.clear();
            trackLineCacheKey = '';
            return;
        }
        if (!force && trackLineCacheKey === cacheKey) return;
        if (trackLineCachePromise && trackLineLoadingKey === cacheKey) {
            await trackLineCachePromise;
            return;
        }

        trackLineLoadingKey = cacheKey;
        const loadPromise = (async (): Promise<void> => {
            const data = await editor.businessManager.getFrameObject(frames);
            if (getFramesCacheKey(editor.state.frames) !== cacheKey) return;

            const nextCache = new Map<string, IUserData[]>();
            frames.forEach((frame, frameIndex) => {
                const objects = utils.objectsMapForFrame(
                    data.objectsMap,
                    frame.id,
                ) as IObject[];
                const objectsByTrack = new Map<string, IObject[]>();
                objects.forEach((object) => {
                    if (!object.trackId) return;
                    const trackId = String(object.trackId);
                    const trackObjects = objectsByTrack.get(trackId) || [];
                    trackObjects.push(object);
                    objectsByTrack.set(trackId, trackObjects);
                });
                objectsByTrack.forEach((trackObjects, trackId) => {
                    const userData = toTrackFrameDataFromServer(trackObjects);
                    if (!userData) return;
                    const list = nextCache.get(trackId) || Array(frames.length);
                    list[frameIndex] = userData;
                    nextCache.set(trackId, list);
                });
            });
            trackLineCache.clear();
            nextCache.forEach((list, trackId) => trackLineCache.set(trackId, list));
            trackLineCacheKey = cacheKey;
        })();
        trackLineCachePromise = loadPromise;
        try {
            await loadPromise;
        } catch (error) {
            console.warn('prefetch track lines failed', error);
        } finally {
            if (trackLineCachePromise === loadPromise) {
                trackLineCachePromise = null;
                trackLineLoadingKey = '';
            }
        }
    }

    async function refreshTrackLineFromServer(trackId: string): Promise<void> {
        const frames = editor.state.frames;
        if (!trackId || frames.length === 0) return;
        const requestId = ++trackLineRequest;
        try {
            await prefetchTrackLines(true);
            if (requestId !== trackLineRequest || editor.currentTrack !== trackId) return;
            const serverList = getTrackLine(trackId);
            const frameIndices: number[] = [];
            serverList.forEach((userData, frameIndex) => {
                if (userData) frameIndices.push(frameIndex);
            });
            editor.trackManager.setTrackFrameIndices(trackId, frameIndices);
            if (editor.currentTrack !== trackId) return;
            applyTrackLineList(serverList);
            iState.segmentBoundaries = getSegmentBoundaries(serverList);
            refreshSegmentBoundaries(trackId, serverList);
            updateTrackFrameMask();
        } catch (error) {
            console.warn('load track line failed', error);
        }
    }

    function getTrackFrameData(trackId: string, frameIndex: number): IUserData | undefined {
        const frame = editor.state.frames[frameIndex];
        if (!frame) return undefined;
        const item = (editor.dataManager.getFrameObject(frame.id) || []).filter(
            (object) => object.userData.trackId === trackId,
        );
        return toTrackFrameData(item);
    }

    function toTrackFrameData(item: any[]): IUserData | undefined {
        if (!item || item.length === 0) return undefined;
        const primaryObject = getPrimaryTrackFrameObject(item);
        if (!primaryObject) return undefined;
        const invalid = item.some((object: any) => object.invalidConfig);
        const trueValue = item.every(
            (object: any) => object.userData.resultStatus === Const.True_Value,
        );
        return {
            ...primaryObject.userData,
            invalid,
            trueValue,
        };
    }

    function hasSegmentMetadataPatch(data: any): boolean {
        const patches = Array.isArray(data?.data?.datas)
            ? data.data.datas
            : [data?.data?.datas].filter(Boolean);
        return patches.some(
            (patch: Partial<IUserData>) =>
                !!patch &&
                (patch.syncLocationGapMs !== undefined ||
                    patch.syncPoseSegmentId !== undefined ||
                    patch.syncPoseSegmentsInitialized !== undefined),
        );
    }

    function updateReviewProgressAt(frameIndex: number) {
        const frames = editor.state.frames;
        if (frameIndex < 0 || frameIndex >= frames.length) return;
        if (iState.reviewProgress.length !== frames.length) {
            updateReviewProgress();
            return;
        }
        const frame = frames[frameIndex];
        const loaded =
            editor.dataManager.dataMap.has(frame.id) ||
            editor.dataManager.dataMap.has(String(frame.id));
        if (!loaded) return;
        const objects = (editor.dataManager.getFrameObject(frame.id) || []).filter(isReviewTarget);
        iState.reviewProgress[frameIndex] = objects.every(isReviewTargetReviewed);
    }

    function onAnnotateLoad() {
        const trackId = editor.currentTrack;
        if (!trackId || trackId !== iState.trackTargetLine.trackId) return;
        updateTrackFrameSlot(editor.state.frameIndex);
        updateReviewProgressAt(editor.state.frameIndex);
        handleTrackActionPreview();
    }

    // Object userData change Event
    const onUpdate = _.throttle((data: any) => {
        const trackId = editor.currentTrack;
        const eventType = data?.type;
        const segmentMetadataChanged = hasSegmentMetadataPatch(data);

        if (trackId && trackId === iState.trackTargetLine.trackId) {
            if (eventType === EditorEvent.ANNOTATE_TRANSFORM_CHANGE) {
                updateTrackFrameSlot(editor.state.frameIndex);
                updateReviewProgress();
                return;
            }
            const frameId = data?.data?.frame?.id;
            if (
                frameId &&
                (eventType === EditorEvent.ANNOTATE_CHANGE || eventType === EditorEvent.ANNOTATE_ADD)
            ) {
                const frameIndex = editor.getFrameIndex(String(frameId));
                if (frameIndex >= 0) {
                    updateTrackFrameSlot(frameIndex, segmentMetadataChanged);
                    updateReviewProgress();
                    if (data?.data?.type === 'reviewMode') refreshReviewProgressFromServer();
                    handleTrackActionPreview();
                    return;
                }
            }
        }

        updateTrackLine(true, segmentMetadataChanged, false);
        updateReviewProgress();
        if (data?.data?.type === 'reviewMode') refreshReviewProgressFromServer();
        handleTrackActionPreview();
    }, 200);

    function emptyTrackObject(): ITrackObject {
        const length = editor.state.frames.length;
        return {
            trackId: '',
            trackName: '',
            list: Array(length),
        };
    }
    // object select event
    function onSelect() {
        const trackId = editor.currentTrack;
        if (trackId === iState.trackTargetLine.trackId) return;
        onClear();
        updateTrackLine();
        updateReviewProgress();
    }
    // 重置
    function onClear() {
        iState.trackAction = '';
        iState.trackMergeErrFrame = [];
        iState.trackMergeResult = emptyTrackObject();
        iState.trackList = [];
        iState.trackSplitClass = '';
        iState.trackSplitTrackId = '';
        // iState.trackMergeResultList = [];
        iState.trackSplitIndex = -1;
    }

    function setConfig(config?: IConfig) {
        Object.assign(iState._config, config || {});
    }
    return {
        editor,
        iState,
        setConfig,
        zoomContainer,
        updateTrackLine,
        onHandleTrackAction,
    };
}
