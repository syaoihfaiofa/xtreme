<template>
    <div class="main-view-info">
        <div v-show="state.visible">
            <div class="item" style="border-bottom: 1px solid #626262"
                ><span class="title">{{ $$('info-name') }}：</span>{{ state.name }}</div
            >
            <div class="item"
                ><span class="title">{{ $$('info-l') }}：</span>{{ state.lMin }}~{{ state.lMax }} -
                {{ formatNumber(state.size.x) }}</div
            >
            <div class="item"
                ><span class="title">{{ $$('info-w') }}：</span>{{ state.wMin }}~{{ state.wMax }} -
                {{ formatNumber(state.size.y) }}</div
            >
            <div class="item"
                ><span class="title">{{ $$('info-h') }}：</span>{{ state.hMin }}~{{ state.hMax }} -
                {{ formatNumber(state.size.z) }}</div
            >
            <div class="item"
                ><span class="title">{{ $$('info-point') }}：</span>{{ state.pointN }}</div
            >
            <div class="item"
                ><span class="title">{{ $$('info-position') }}：</span
                >{{
                    `${formatNumber(state.position.x)},${formatNumber(
                        state.position.y,
                    )},${formatNumber(state.position.z)}`
                }}</div
            >
        </div>
        <!-- Vehicle speed belongs to the frame, not to a selected 3D box. Keep it
             visible when annotating curb/wall or irregular-wall ground shapes. -->
        <div class="item">
            <span class="title">Speed：</span>{{ state.speed }}
        </div>
        <div class="item">
            <span class="title">Location：</span>
            x: {{ state.location.x }}, y: {{ state.location.y }}, z: {{ state.location.z }}
        </div>
        <div class="item location-rotation">
            yaw: {{ state.location.yaw }}, pitch: {{ state.location.pitch }}, roll: {{ state.location.roll }}
        </div>
        <div v-if="editor.bsState.syncMode" class="item nearest-static-target">
            <span class="title">Location 校正目标：</span>
            <template v-if="state.nearestStaticTrackId">
                <span>
                    最近非源 · {{ state.nearestStaticName }} · {{ state.nearestStaticTrackId }}
                    · {{ state.nearestStaticDistance }} m
                </span>
                <button type="button" @click="selectNearestStaticTarget">选中</button>
            </template>
            <span v-else>当前帧没有可用的非源静态框</span>
        </div>
        <Setting />
    </div>
</template>

<script setup lang="ts">
    import { onMounted, onBeforeUnmount, reactive } from 'vue';
    import { Points, Event, Box } from 'pc-render';
    import { useInjectEditor } from '../../state';
    import * as _ from 'lodash';
    import * as THREE from 'three';
    import { formatNumber } from '../../utils';
    import { utils } from 'pc-editor';
    import * as api from '../../api';
    // import { CloseCircleOutlined } from '@ant-design/icons-vue';
    import { IUserData, MotionMode, StatusType, Event as EditorEvent } from 'pc-editor';
    import * as locale from './lang';
    import Setting from './setting.vue';

    // ***************Props and Emits***************

    // *********************************************

    let editor = useInjectEditor();
    const $$ = editor.bindLocale(locale);
    let pc = editor.pc;
    let state = reactive({
        visible: false,
        name: '',
        pointN: 0,
        size: new THREE.Vector3(),
        position: new THREE.Vector3(),
        //
        lMin: '' as any,
        wMin: '' as any,
        hMin: '' as any,
        lMax: '' as any,
        wMax: '' as any,
        hMax: '' as any,
        speed: '--',
        location: {
            x: '--',
            y: '--',
            z: '--',
            yaw: '--',
            pitch: '--',
            roll: '--',
        },
        nearestStaticName: '',
        nearestStaticTrackId: '',
        nearestStaticDistance: '--',
    });

    const poseCache = new Map<string, api.IScenePose>();
    let speedRequestVersion = 0;
    let nearestStaticTarget: Box | undefined;

    function sensorDistance(object: Box): number {
        const halfX = Math.max(Math.abs(object.scale.x) / 2, 0);
        const halfY = Math.max(Math.abs(object.scale.y) / 2, 0);
        const dx = -object.position.x;
        const dy = -object.position.y;
        const yaw = object.rotation.z || 0;
        const localX = dx * Math.cos(yaw) + dy * Math.sin(yaw);
        const localY = -dx * Math.sin(yaw) + dy * Math.cos(yaw);
        return Math.hypot(
            Math.max(Math.abs(localX) - halfX, 0),
            Math.max(Math.abs(localY) - halfY, 0),
        );
    }

    function updateNearestStaticTarget() {
        const currentFrameId = String(editor.getCurrentFrame()?.id || '');
        const nearest = (pc.getAnnotate3D().filter((object) => {
            if (!(object instanceof Box)) return false;
            const userData = object.userData as IUserData;
            const motionMode = userData.motionMode || utils.getDefaultMotionMode(userData.classType);
            // A box on the current source frame is local annotation evidence only. Its edits
            // drive propagation, not this frame's location correction, so never offer it here.
            return motionMode === MotionMode.STATIC
                && !!userData.trackId
                && String(userData.syncSourceDataId || '') !== currentFrameId;
        }) as Box[]).sort((left, right) => sensorDistance(left) - sensorDistance(right))[0];
        nearestStaticTarget = nearest;
        if (!nearest) {
            state.nearestStaticName = '';
            state.nearestStaticTrackId = '';
            state.nearestStaticDistance = '--';
            return;
        }
        const userData = nearest.userData as IUserData;
        state.nearestStaticName = userData.trackName || userData.classType || '未命名目标';
        state.nearestStaticTrackId = userData.trackId || '无 Track ID';
        state.nearestStaticDistance = formatNumber(sensorDistance(nearest));
    }

    function selectNearestStaticTarget() {
        if (!nearestStaticTarget) return;
        editor.selectObject(nearestStaticTarget);
        editor.focusObject(nearestStaticTarget);
    }
    let update = _.throttle(() => {
        let obj = pc.selection.find((item) => item instanceof Box) as Box;
        if (!obj || pc.groupPoints.children.length === 0) {
            state.visible = false;
            return;
        }
        let points = pc.groupPoints.children[0] as Points;
        let positions = points.geometry.attributes['position'] as THREE.BufferAttribute;
        let pointN = utils.computePointN(obj, positions);
        // console.timeEnd('update');
        setStateName(obj.userData);
        // state.name = obj.userData.classType || obj.userData.modelClass || $$('info-empty');
        state.pointN = pointN;
        state.size.copy(obj.scale);
        state.position.copy(obj.position);
        state.visible = true;

        obj.userData.pointN = pointN;
    }, 200);

    function onSelect() {
        let selection = pc.selection;
        if (selection.length === 0 && editor.state.status === StatusType.Play) return;
        update();
    }

    function setStateName(userData: IUserData) {
        if (!userData) return;
        const classTypes = editor.state.classTypes;
        const empty = $$('info-empty');
        const modelInfo = $$('info-model');
        let classType = empty;

        state.lMin = 0;
        state.lMax = $$('info-infinity');
        state.wMin = 0;
        state.wMax = state.lMax;
        state.hMin = 0;
        state.hMax = state.lMax;

        if (userData.classType) {
            let config = editor.getClassType(userData);
            if (config) classType = config.label || config.name;
            if (config?.type === 'constraint') {
                let sizeMin = config.sizeMin as THREE.Vector3;
                let sizeMax = config.sizeMax as THREE.Vector3;
                state.lMin = sizeMin.x || '';
                state.wMin = sizeMin.y || '';
                state.hMin = sizeMin.z || '';
                state.lMax = sizeMax.x || '';
                state.wMax = sizeMax.y || '';
                state.hMax = sizeMax.z || '';
            } else if (config?.type === 'standard') {
                let size3D = config.size3D as THREE.Vector3;
                state.lMin = size3D.x || '';
                state.wMin = size3D.y || '';
                state.hMin = size3D.z || '';
                state.lMax = size3D.x || '';
                state.wMax = size3D.y || '';
                state.hMax = size3D.z || '';
            }
        } else if (userData.modelClass) {
            classType = `${userData.modelClass}(${modelInfo})`;
        }
        state.name = classType;
    }

    /**
     * Parse the location-import timestamp from the frame name. Point-cloud uploads
     * may retain a file extension or append a sensor suffix, so accept both while
     * preserving the backend's `_seconds_nanoseconds` convention.
     */
    function getFrameTimestampMs(name?: string): number | undefined {
        const parts = name?.trim().replace(/\.[^.]+$/, '').split('_') || [];
        // A name can contain a date and clock prefix (for example
        // `20260814_153659_7916_909321440`).  Find the last adjacent numeric
        // pair instead of letting a greedy regexp mistake `153659_7916` for
        // the timestamp.  This also tolerates a trailing sensor name.
        for (let index = parts.length - 1; index > 0; index--) {
            if (!/^\d+$/.test(parts[index - 1]) || !/^\d{1,9}$/.test(parts[index])) continue;
            const seconds = Number(parts[index - 1]);
            const nanoseconds = Number(parts[index]);
            if (
                !Number.isSafeInteger(seconds) ||
                !Number.isSafeInteger(nanoseconds) ||
                nanoseconds < 0 ||
                nanoseconds >= 1e9
            ) {
                continue;
            }
            // Nanoseconds since epoch exceed JavaScript's safe-integer range. Speed
            // needs only a frame interval, so retain millisecond precision instead.
            return seconds * 1000 + nanoseconds / 1e6;
        }
        return undefined;
    }

    function updateLocation(pose?: api.IScenePose): void {
        const formatPoseValue = (value?: number): string =>
            Number.isFinite(Number(value)) ? formatNumber(Number(value)) : '--';
        state.location.x = formatPoseValue(pose?.posX);
        state.location.y = formatPoseValue(pose?.posY);
        state.location.z = formatPoseValue(pose?.posZ);
        state.location.yaw = formatPoseValue(pose?.yaw);
        state.location.pitch = formatPoseValue(pose?.pitch);
        state.location.roll = formatPoseValue(pose?.roll);
    }

    async function updateSpeed() {
        const requestVersion = ++speedRequestVersion;
        const { frames, frameIndex } = editor.state;
        const current = frames[frameIndex];
        const previous = frames[frameIndex - 1];
        const next = frames[frameIndex + 1];
        if (!current) {
            state.speed = '--';
            updateLocation();
            return;
        }

        const candidates = [previous, current, next].filter(
            (frame): frame is NonNullable<typeof frame> => !!frame,
        );
        try {
            const missingIds = candidates
                .map((frame) => String(frame.id))
                .filter((id) => !poseCache.has(id));
            if (missingIds.length) {
                const poses = await api.getScenePoses(missingIds);
                Object.entries(poses).forEach(([id, pose]) => poseCache.set(id, pose));
            }
            // Ignore a late request after the annotator has switched frames again.
            if (requestVersion !== speedRequestVersion) return;

            const currentPose = poseCache.get(String(current.id));
            const currentTime = getFrameTimestampMs(current.name);
            updateLocation(currentPose);
            if (!currentPose || currentTime === undefined) {
                state.speed = '--';
                return;
            }

            const validNeighbours = [previous, next]
                .map((frame) => {
                    if (!frame) return undefined;
                    const time = getFrameTimestampMs(frame.name);
                    const pose = poseCache.get(String(frame.id));
                    return time === undefined || !pose ? undefined : { time, pose };
                })
                .filter(Boolean) as Array<{ time: number; pose: api.IScenePose }>;
            if (!validNeighbours.length) {
                state.speed = '--';
                return;
            }

            // Prefer a centered estimate to make the displayed speed less sensitive to one frame's pose noise.
            const before = validNeighbours.find((item) => item.time < currentTime);
            const after = validNeighbours.find((item) => item.time > currentTime);
            const currentSample = { time: currentTime, pose: currentPose };
            const start = before || currentSample;
            const end = after || currentSample;
            const elapsedSeconds = Math.abs(end.time - start.time) / 1000;
            if (!elapsedSeconds) {
                state.speed = '--';
                return;
            }
            const dx = end.pose.posX - start.pose.posX;
            const dy = end.pose.posY - start.pose.posY;
            const kmh = (Math.hypot(dx, dy) / elapsedSeconds) * 3.6;
            state.speed = Number.isFinite(kmh) ? `${formatNumber(kmh)} km/h` : '--';
        } catch (error) {
            if (requestVersion === speedRequestVersion) {
                state.speed = '--';
                updateLocation();
            }
        }
    }

    function onFrameChange() {
        update();
        updateNearestStaticTarget();
        updateSpeed();
    }

    function onAnnotateChange() {
        update();
        updateNearestStaticTarget();
    }

    // Location correction is persisted by track sync and may reload the same
    // frame. Drop the cached pose before refreshing so the overlay does not
    // briefly keep the pre-correction x/y/z/yaw/pitch/roll values.
    function onTrackSyncComplete() {
        const current = editor.state.frames[editor.state.frameIndex];
        if (current) poseCache.delete(String(current.id));
        updateSpeed();
    }

    onMounted(() => {
        editor.pc.addEventListener(Event.OBJECT_TRANSFORM, onAnnotateChange);
        editor.pc.addEventListener(Event.SELECT, onSelect);
        editor.addEventListener(EditorEvent.ANNOTATE_CHANGE, onAnnotateChange);
        editor.addEventListener(EditorEvent.FRAME_CHANGE, onFrameChange);
        editor.addEventListener(EditorEvent.TRACK_SYNC_COMPLETE, onTrackSyncComplete);
        updateNearestStaticTarget();
        updateSpeed();
    });

    onBeforeUnmount(() => {
        editor.pc.removeEventListener(Event.OBJECT_TRANSFORM, onAnnotateChange);
        editor.pc.removeEventListener(Event.SELECT, onSelect);
        editor.removeEventListener(EditorEvent.ANNOTATE_CHANGE, onAnnotateChange);
        editor.removeEventListener(EditorEvent.FRAME_CHANGE, onFrameChange);
        editor.removeEventListener(EditorEvent.TRACK_SYNC_COMPLETE, onTrackSyncComplete);
    });
</script>

<style lang="less">
    .main-view-info {
        position: absolute;
        left: 16px;
        top: 16px;
        color: #cdd3da;
        pointer-events: none;
        user-select: none;

        .item {
            font-size: 12px;
            text-align: left;
            line-height: 20px;
        }

        .location-rotation {
            padding-left: 54px;
        }

        .nearest-static-target {
            color: #ffd666;

            button {
                margin-left: 6px;
                padding: 0 4px;
                color: #ffd666;
                background: rgba(255, 214, 102, 0.12);
                border: 1px solid rgba(255, 214, 102, 0.6);
                border-radius: 2px;
                cursor: pointer;
                pointer-events: auto;
            }
        }

    }
</style>
