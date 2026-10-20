<template>
    <div v-if="isVisibilityMode" class="visibility-overlay-panel">
        <a-button size="small" @click="exitVisibility">退出只读查看</a-button>
        <div class="visibility-overlay-status" :class="statusKind">{{ statusText }}</div>
        <template v-if="taskRun">
            <div class="visibility-overlay-task-status">
                <div>任务状态：{{ taskStatusText }}</div>
                <div>阶段：{{ taskStageText }}</div>
                <div>
                    进度：{{ taskProgressText }}（{{ taskRun.completedFrames }}/{{ taskRun.totalFrames }} 帧）
                </div>
            </div>
            <a-button
                v-if="canStartVisibility"
                size="small"
                type="primary"
                :loading="isStartingVisibility"
                @click="startVisibilityTask"
            >
                开始计算遮挡
            </a-button>
        </template>
        <div v-if="visibilitySummary" class="visibility-overlay-summary">{{ visibilitySummary }}</div>
        <div class="visibility-overlay-legend">
            <span><i class="box-color"></i>自动遮挡框（类别色虚线）</span>
            <span><i class="visible-color"></i>自动可见线段</span>
            <span><i class="hidden-color"></i>自动遮挡线段</span>
        </div>
        <div class="visibility-overlay-control">
            <span>OCC 稀疏体素</span>
            <a-switch
                v-model:checked="occEnabled"
                size="small"
                :disabled="!occRunId"
                @change="onOccEnabledChange"
            />
        </div>
        <template v-if="occEnabled">
            <div class="visibility-overlay-control">
                <span>体素图层</span>
                <a-select v-model:value="occLayer" size="small" @change="reloadOcc">
                    <a-select-option value="semantic">semantic</a-select-option>
                    <a-select-option value="lidar-mask">lidar-mask</a-select-option>
                    <a-select-option value="camera-mask">camera-mask</a-select-option>
                </a-select>
            </div>
            <div class="visibility-overlay-label">透明度 {{ occOpacity.toFixed(2) }}</div>
            <a-slider
                v-model:value="occOpacity"
                :min="0.05"
                :max="1"
                :step="0.05"
                @change="updateOccOpacity"
            />
            <div class="visibility-overlay-control">
                <span>最大体素数</span>
                <a-input-number
                    v-model:value="maxVoxels"
                    size="small"
                    :min="100"
                    :max="200000"
                    :step="1000"
                    @change="reloadOcc"
                />
            </div>
            <div v-if="occStatusText" class="visibility-overlay-occ-status">
                {{ occStatusText }}
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
    import * as THREE from 'three';
    import { Box, GroundPolyline, IrregularWall } from 'pc-render';
    import { BSError, Event } from 'pc-editor';

    import {
        getOccVisualization,
        createVisibilityTask,
        getVisibilityFrame,
        getLatestVisibilityTask,
        getVisibilityRun,
        IOccVisualizationResult,
        IVisibilityFrameResult,
        IVisibilityPolylineResult,
        IVisibilityRun,
    } from '../../api';
    import { useInjectEditor } from '../../state';

    type StatusKind = 'pending' | 'ready' | 'empty' | 'error';

    const AUTO_BOX_FALLBACK_COLOR = 0xff3b30;
    const AUTO_VISIBLE_SEGMENT_COLOR = new THREE.Color(0x00e676);
    const AUTO_HIDDEN_SEGMENT_COLOR = new THREE.Color(0xff1744);
    const OCC_SEMANTIC_COLORS: Record<number, number> = {
        1: 0x8d99ae,
        2: 0xff595e,
        3: 0xffca3a,
        4: 0x9b5de5,
        5: 0xff70a6,
        6: 0x8d6e63,
        7: 0x00bbf9,
        8: 0x577590,
        9: 0x43aa8b,
        10: 0xf9c74f,
        11: 0x4361ee,
        12: 0xf3722c,
        13: 0xef476f,
        14: 0x06d6a0,
        15: 0x118ab2,
        16: 0xe63946,
        17: 0x6a994e,
        18: 0xf9844a,
        19: 0xadb5bd,
        20: 0x90be6d,
        21: 0xfee440,
    };

    const editor = useInjectEditor();
    const visibilityGroup = new THREE.Group();
    const occGroup = new THREE.Group();
    const hiddenOccludedBoxes = new Set<Box>();
    const statusText = ref('正在读取自动遮挡结果…');
    const statusKind = ref<StatusKind>('pending');
    const visibilitySummary = ref('');
    const occStatusText = ref('');
    const occEnabled = ref(true);
    const occOpacity = ref(1);
    const maxVoxels = ref(200000);
    const occLayer = ref<'semantic' | 'lidar-mask' | 'camera-mask'>('semantic');
    const taskRun = ref<IVisibilityRun>();
    const occRunId = ref('');
    const activeRunId = ref('');
    const isStartingVisibility = ref(false);
    let loadVersion = 0;
    let occLoadVersion = 0;
    let previousPointCloudVisibility: boolean | null = null;
    let taskPollTimer: ReturnType<typeof window.setTimeout> | undefined;

    visibilityGroup.name = 'visibility-transient-overlay';
    occGroup.name = 'visibility-occ-transient-overlay';

    const isVisibilityMode = computed(() => editor.state.modeConfig.name === 'visibility');
    const runId = computed(() => String(editor.bsState.query.visibilityRunId || '').trim());
    const canStartVisibility = computed(
        () =>
            Boolean(occRunId.value) &&
            !(
                taskRun.value?.taskType === 'VISIBILITY' &&
                ['QUEUED', 'RUNNING'].includes(taskRun.value.status)
            ) &&
            Boolean(editor.getCurrentFrame()?.id),
    );
    const taskStatusText = computed(() => {
        const labels: Record<IVisibilityRun['status'], string> = {
            QUEUED: '排队中',
            RUNNING: '计算中',
            SUCCEEDED: '已完成',
            FAILED: '失败',
        };
        return taskRun.value ? labels[taskRun.value.status] : '未知';
    });
    const taskStageText = computed(() => {
        const labels: Record<IVisibilityRun['stage'], string> = {
            QUEUED: '等待执行',
            PREPARING: '准备任务输入',
            OCC_GENERATION: '生成 OCC',
            LIDAR_VISIBILITY: '计算 LiDAR 可见区域',
            ANNOTATION_VISIBILITY: '计算标注可见性',
            WRITING: '写入结果',
            COMPLETED: '已完成',
            FAILED: '执行失败',
        };
        return taskRun.value ? labels[taskRun.value.stage] : '未知';
    });
    const taskProgressText = computed(() => `${Math.round((taskRun.value?.progress || 0) * 100)}%`);

    function exitVisibility(): void {
        window.history.back();
    }

    function objectKeys(object: THREE.Object3D): string[] {
        const userData = object.userData || {};
        return [userData.backId, userData.id]
            .filter((value) => value != null && value !== '')
            .map((value) => String(value));
    }

    function findResult<T>(
        results: Record<string, T>,
        object: THREE.Object3D,
        dataId: string,
    ): T | undefined {
        const key = objectKeys(object)
            .map((candidate) => `${dataId}:${candidate}`)
            .find((candidate) => results[candidate] != null);
        return key ? results[key] : undefined;
    }

    function disposeObject(object: THREE.Object3D): void {
        object.traverse((child) => {
            const renderObject = child as THREE.Mesh;
            renderObject.geometry?.dispose();
            const material = renderObject.material;
            if (Array.isArray(material)) material.forEach((item) => item.dispose());
            else material?.dispose();
        });
    }

    function clearGroup(group: THREE.Group): void {
        [...group.children].forEach((child) => {
            group.remove(child);
            disposeObject(child);
        });
    }

    function clearFrameOverlay(): void {
        occLoadVersion++;
        clearGroup(visibilityGroup);
        clearGroup(occGroup);
        hiddenOccludedBoxes.forEach((box) => {
            box.visible = true;
        });
        hiddenOccludedBoxes.clear();
        restorePointCloud();
        occStatusText.value = '';
        visibilitySummary.value = '';
        editor.pc.render();
    }

    function hidePointCloud(): void {
        if (previousPointCloudVisibility == null) {
            previousPointCloudVisibility = editor.pc.groupPoints.visible;
        }
        editor.pc.groupPoints.visible = false;
    }

    function restorePointCloud(): void {
        if (previousPointCloudVisibility == null) {
            return;
        }
        editor.pc.groupPoints.visible = previousPointCloudVisibility;
        previousPointCloudVisibility = null;
    }

    function updatePointCloudVisibility(): void {
        if (!isVisibilityMode.value) {
            restorePointCloud();
        }
        editor.pc.render();
    }

    function autoBoxColor(source: Box): THREE.ColorRepresentation {
        const classConfig = editor.getClassType(source.userData || {});
        return classConfig?.color || source.color?.getStyle() || AUTO_BOX_FALLBACK_COLOR;
    }

    function createBoxOverlay(source: Box): THREE.LineSegments {
        source.updateMatrixWorld(true);
        const geometry = source.geometry.clone();
        const overlay = new THREE.LineSegments(
            geometry,
            new THREE.LineDashedMaterial({
                color: autoBoxColor(source),
                dashSize: 0.16,
                gapSize: 0.10,
                transparent: true,
                opacity: 0.85,
                depthTest: false,
                depthWrite: false,
                toneMapped: false,
            }),
        );
        overlay.matrixAutoUpdate = false;
        overlay.matrix.copy(source.matrixWorld);
        overlay.computeLineDistances();
        overlay.renderOrder = 1200;
        return overlay;
    }

    function samplePolyline(points: readonly THREE.Vector3[], segmentCount: number): THREE.Vector3[] {
        if (points.length < 2 || segmentCount <= 0) return [];
        const retained = points.filter(
            (point, index) =>
                index === 0 ||
                new THREE.Vector2(point.x, point.y).distanceTo(
                    new THREE.Vector2(points[index - 1].x, points[index - 1].y),
                ) > 0,
        );
        if (retained.length < 2) return [];
        const cumulative = [0];
        for (let index = 1; index < retained.length; index++) {
            cumulative.push(
                cumulative[index - 1] +
                    new THREE.Vector2(retained[index].x, retained[index].y).distanceTo(
                        new THREE.Vector2(retained[index - 1].x, retained[index - 1].y),
                    ),
            );
        }
        const totalLength = cumulative[cumulative.length - 1];
        return Array.from({ length: segmentCount + 1 }, (_, sampleIndex) => {
            const distance = (totalLength * sampleIndex) / segmentCount;
            let edgeIndex = 0;
            while (
                edgeIndex < cumulative.length - 2 &&
                cumulative[edgeIndex + 1] < distance
            ) {
                edgeIndex++;
            }
            const edgeLength = cumulative[edgeIndex + 1] - cumulative[edgeIndex];
            const ratio = edgeLength > 0 ? (distance - cumulative[edgeIndex]) / edgeLength : 0;
            return retained[edgeIndex].clone().lerp(retained[edgeIndex + 1], ratio);
        });
    }

    function createPolylineOverlay(
        bottomPoints: readonly THREE.Vector3[],
        topPoints: readonly THREE.Vector3[],
        result: IVisibilityPolylineResult,
    ): THREE.Group | null {
        const entries = result.autoSegmentVisibilityByView?.bev || [];
        const segmentCount = Number(result.autoSegmentMeta?.numSegments) || entries.length;
        const sampledBottom = samplePolyline(bottomPoints, segmentCount);
        const sampledTop = samplePolyline(topPoints, segmentCount);
        if (
            sampledBottom.length !== segmentCount + 1
            || sampledTop.length !== segmentCount + 1
        ) return null;

        const visibility = new Map(entries.map((entry) => [entry.index, entry.visible]));
        const overlay = new THREE.Group();
        for (let index = 0; index < segmentCount; index++) {
            const color = visibility.get(index)
                ? AUTO_VISIBLE_SEGMENT_COLOR
                : AUTO_HIDDEN_SEGMENT_COLOR;
            const bottomStart = sampledBottom[index];
            const bottomEnd = sampledBottom[index + 1];
            const topStart = sampledTop[index];
            const topEnd = sampledTop[index + 1];
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                'position',
                new THREE.Float32BufferAttribute([
                    bottomStart.x, bottomStart.y, bottomStart.z,
                    bottomEnd.x, bottomEnd.y, bottomEnd.z,
                    topEnd.x, topEnd.y, topEnd.z,
                    bottomStart.x, bottomStart.y, bottomStart.z,
                    topEnd.x, topEnd.y, topEnd.z,
                    topStart.x, topStart.y, topStart.z,
                ], 3),
            );
            overlay.add(new THREE.Mesh(
                geometry,
                new THREE.MeshBasicMaterial({
                    color,
                    transparent: true,
                    opacity: 0.88,
                    side: THREE.DoubleSide,
                    depthTest: false,
                    depthWrite: false,
                    toneMapped: false,
                }),
            ));
        }
        overlay.renderOrder = 1201;
        return overlay;
    }

    function renderVisibility(result: IVisibilityFrameResult): void {
        const annotations = editor.pc.getAnnotate3D();
        const dataId = String(editor.getCurrentFrame()?.id || '');
        const boxResults = Object.values(result.objects || {});
        const occludedCount = boxResults.filter((item) => item.autoOccluded).length;
        const maxRatio = boxResults.reduce(
            (maximum, item) => Math.max(maximum, Number(item.autoVisibleRatio) || 0),
            0,
        );
        visibilitySummary.value =
            boxResults.length > 0
                ? `Box 可见比例最高 ${maxRatio.toFixed(2)}；遮挡结论 ${occludedCount}/${boxResults.length}`
                : '当前帧没有自动遮挡 Box 结论';
        annotations.forEach((object) => {
            if (object instanceof Box) {
                const objectResult = findResult(result.objects || {}, object, dataId);
                if (objectResult?.autoOccluded === true) {
                    object.visible = false;
                    hiddenOccludedBoxes.add(object);
                    visibilityGroup.add(createBoxOverlay(object));
                }
                return;
            }

            const polylineResult = findResult(result.polylines || {}, object, dataId);
            if (!polylineResult) return;
            const bottomPoints = object instanceof GroundPolyline
                ? object.points3D
                : object instanceof IrregularWall
                  ? object.bottomPoints
                  : [];
            const topPoints = object instanceof GroundPolyline
                ? bottomPoints.map((point) => point.clone().add(
                    new THREE.Vector3(0, 0, Math.max(object.wallHeight, 0.3)),
                ))
                : object instanceof IrregularWall && object.topPoints.length >= 2
                  ? object.topPoints
                  : bottomPoints.map((point) => point.clone().add(new THREE.Vector3(0, 0, 0.3)));
            const overlay = createPolylineOverlay(bottomPoints, topPoints, polylineResult);
            if (overlay) visibilityGroup.add(overlay);
        });
        editor.pc.render();
    }

    function semanticColor(semanticId: number): THREE.Color {
        return new THREE.Color(OCC_SEMANTIC_COLORS[semanticId] || 0xffffff);
    }

    function sourceClassColor(sourceClassId: number | undefined): THREE.Color | undefined {
        if (!Number.isSafeInteger(sourceClassId) || sourceClassId <= 0) return undefined;
        const classConfig = editor.getClassType(String(sourceClassId));
        return classConfig?.color ? new THREE.Color(classConfig.color) : undefined;
    }

    function occColor(voxel: IOccVoxel): THREE.Color {
        if (occLayer.value === 'lidar-mask') {
            if (voxel.semanticId === 0 || voxel.semanticId === 255) {
                return new THREE.Color(0x90caf9);
            }
            return sourceClassColor(voxel.sourceClassId) || semanticColor(voxel.semanticId);
        }
        if (occLayer.value === 'camera-mask') {
            return new THREE.Color(voxel.cameraObserved ? 0x40c4ff : 0x666666);
        }
        return sourceClassColor(voxel.sourceClassId) || semanticColor(voxel.semanticId);
    }

    function renderOcc(result: IOccVisualizationResult): void {
        clearGroup(occGroup);
        const voxelSize = Number(result.voxelSize);
        const range = result.pcRange;
        const voxels = Array.isArray(result.voxels) ? result.voxels : [];
        if (
            !Number.isFinite(voxelSize) ||
            voxelSize <= 0 ||
            !Array.isArray(range) ||
            range.length !== 6
        ) {
            throw new Error('Invalid OCC visualization response');
        }
        const positions = new Float32Array(voxels.length * 3);
        const colors = new Float32Array(voxels.length * 3);
        voxels.forEach((voxel, index) => {
            positions[index * 3] = Number(range[0]) + (voxel.x + 0.5) * voxelSize;
            positions[index * 3 + 1] = Number(range[1]) + (voxel.y + 0.5) * voxelSize;
            positions[index * 3 + 2] = Number(range[2]) + (voxel.z + 0.5) * voxelSize;
            const color = occColor(voxel);
            colors[index * 3] = color.r;
            colors[index * 3 + 1] = color.g;
            colors[index * 3 + 2] = color.b;
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const material = new THREE.PointsMaterial({
            size: voxelSize * 0.9,
            sizeAttenuation: true,
            transparent: true,
            opacity: occOpacity.value,
            depthWrite: false,
            vertexColors: true,
            depthTest: false,
        });
        const points = new THREE.Points(geometry, material);
        points.frustumCulled = false;
        points.renderOrder = 1100;
        occGroup.add(points);
        hidePointCloud();
        occStatusText.value = `已显示 ${voxels.length} 个体素（${occLayer.value}）`;
        editor.pc.render();
    }

    function errorStatus(error: unknown): { kind: StatusKind; text: string } {
        const typedError = error as BSError;
        const message = `${typedError?.message || ''} ${typedError?.oriError?.message || ''}`;
        if (typedError?.code === 'NOT_FOUND' || /not found|must be SUCCEEDED/i.test(message)) {
            return { kind: 'empty', text: '当前帧自动遮挡结果尚未生成' };
        }
        return { kind: 'error', text: '自动遮挡结果加载失败（只读模式）' };
    }

    async function loadOcc(frameId: string, version: number): Promise<void> {
        if (!occEnabled.value || !occRunId.value) return;
        const requestVersion = ++occLoadVersion;
        occStatusText.value = '正在加载 OCC 体素…';
        hidePointCloud();
        editor.pc.render();
        try {
            const result = await getOccVisualization(
                occRunId.value,
                frameId,
                maxVoxels.value,
                occLayer.value,
            );
            if (version !== loadVersion || requestVersion !== occLoadVersion) return;
            renderOcc(result);
        } catch (error) {
            if (version !== loadVersion || requestVersion !== occLoadVersion) return;
            clearGroup(occGroup);
            restorePointCloud();
            occStatusText.value = 'OCC 体素加载失败';
            editor.pc.render();
        }
    }

    function stopTaskPolling(): void {
        if (taskPollTimer) window.clearTimeout(taskPollTimer);
        taskPollTimer = undefined;
    }

    function scheduleTaskPolling(): void {
        stopTaskPolling();
        taskPollTimer = window.setTimeout(() => {
            void pollTaskRun();
        }, 1500);
    }

    async function pollTaskRun(): Promise<void> {
        if (!taskRun.value || ['SUCCEEDED', 'FAILED'].includes(taskRun.value.status)) return;
        try {
            taskRun.value = await getVisibilityRun(String(taskRun.value.id));
            if (taskRun.value.status === 'SUCCEEDED') {
                void loadCurrentFrame();
                return;
            }
            if (taskRun.value.status === 'FAILED') {
                statusKind.value = 'error';
                statusText.value = taskRun.value.error || '遮挡计算失败';
                return;
            }
            scheduleTaskPolling();
        } catch (error) {
            statusKind.value = 'error';
            statusText.value = errorStatus(error).text;
        }
    }

    function loadSucceededOcc(frameId: string, version: number): void {
        if (!taskRun.value) return;
        occRunId.value =
            taskRun.value.taskType === 'VISIBILITY' && taskRun.value.occRunId
                ? String(taskRun.value.occRunId)
                : String(taskRun.value.id);
        void loadOcc(frameId, version);
    }

    async function loadCurrentFrame(): Promise<void> {
        const version = ++loadVersion;
        clearFrameOverlay();
        stopTaskPolling();
        const targetRunId = activeRunId.value || runId.value;
        if (!targetRunId) {
            statusKind.value = 'empty';
            statusText.value = '未提供 visibilityRunId，仅显示人工标注';
            return;
        }
        const frameId = String(editor.getCurrentFrame()?.id || '');
        if (!frameId) {
            statusKind.value = 'empty';
            statusText.value = '当前帧不可用';
            return;
        }
        statusKind.value = 'pending';
        statusText.value = '正在读取 OCC 任务…';
        try {
            taskRun.value = await getVisibilityRun(targetRunId);
            if (version !== loadVersion) return;
            if (taskRun.value.status === 'FAILED') {
                statusKind.value = 'error';
                statusText.value = taskRun.value.error || 'OCC 或遮挡任务失败';
                return;
            }
            if (taskRun.value.status !== 'SUCCEEDED') {
                statusKind.value = 'pending';
                statusText.value =
                    taskRun.value.taskType === 'OCC' ? '正在生成 OCC…' : '正在计算遮挡…';
                scheduleTaskPolling();
                return;
            }
            loadSucceededOcc(frameId, version);
            if (taskRun.value.taskType === 'OCC') {
                const latestTask = await getLatestVisibilityTask(String(taskRun.value.id));
                if (version !== loadVersion) return;
                if (latestTask?.status === 'SUCCEEDED') {
                    try {
                        const result = await getVisibilityFrame(
                            String(latestTask.id), frameId,
                        );
                        if (version !== loadVersion) return;
                        renderVisibility(result);
                        statusKind.value = 'ready';
                        statusText.value = '已加载最近一次自动遮挡结果';
                        return;
                    } catch {
                        if (version !== loadVersion) return;
                    }
                }
                statusKind.value = 'ready';
                statusText.value = 'OCC 已加载；可手动开始计算遮挡';
                return;
            }
            const result = await getVisibilityFrame(String(taskRun.value.id), frameId);
            if (version !== loadVersion) return;
            renderVisibility(result);
            statusKind.value = 'ready';
            statusText.value = '自动遮挡结果（只读）';
        } catch (error) {
            if (version !== loadVersion) return;
            const status = errorStatus(error);
            statusKind.value = status.kind;
            statusText.value = status.text;
        }
    }

    async function startVisibilityTask(): Promise<void> {
        if (!taskRun.value || !canStartVisibility.value) return;
        const frameId = Number(editor.getCurrentFrame()?.id);
        if (!Number.isSafeInteger(frameId) || frameId <= 0) {
            statusKind.value = 'error';
            statusText.value = '当前帧不可用';
            return;
        }
        isStartingVisibility.value = true;
        try {
            taskRun.value = await createVisibilityTask({
                occRunId: Number(occRunId.value),
                selectedDataIds: [frameId],
            });
            activeRunId.value = String(taskRun.value.id);
            statusKind.value = 'pending';
            statusText.value = '已提交遮挡计算任务…';
            scheduleTaskPolling();
        } catch (error) {
            statusKind.value = 'error';
            statusText.value = errorStatus(error).text;
        } finally {
            isStartingVisibility.value = false;
        }
    }

    function onFrameChange(): void {
        activeRunId.value = '';
        void loadCurrentFrame();
    }

    watch(
        runId,
        () => {
            activeRunId.value = '';
            taskRun.value = undefined;
            occRunId.value = '';
        },
    );

    watch(
        () => editor.state.frameIndex,
        () => {
            loadVersion++;
            clearFrameOverlay();
            statusKind.value = runId.value ? 'pending' : 'empty';
            statusText.value = runId.value
                ? '正在切换帧并读取自动遮挡结果…'
                : '未提供 visibilityRunId，仅显示人工标注';
            void loadCurrentFrame();
        },
    );

    watch(isVisibilityMode, updatePointCloudVisibility, { immediate: true });

    function onOccEnabledChange(enabled: boolean): void {
        if (!enabled) {
            occLoadVersion++;
            clearGroup(occGroup);
            occStatusText.value = '';
            editor.pc.render();
            return;
        }
        const frameId = String(editor.getCurrentFrame()?.id || '');
        if (frameId) void loadOcc(frameId, loadVersion);
    }

    function updateOccOpacity(): void {
        occGroup.traverse((object) => {
            const material = (object as THREE.Mesh).material;
            if (material instanceof THREE.MeshBasicMaterial) material.opacity = occOpacity.value;
            if (material instanceof THREE.PointsMaterial) material.opacity = occOpacity.value;
        });
        editor.pc.render();
    }

    function reloadOcc(): void {
        if (!occEnabled.value) return;
        clearGroup(occGroup);
        const frameId = String(editor.getCurrentFrame()?.id || '');
        if (frameId) void loadOcc(frameId, loadVersion);
    }

    onMounted(() => {
        editor.pc.scene.add(visibilityGroup, occGroup);
        editor.addEventListener(Event.FRAME_CHANGE, onFrameChange);
        if (editor.getCurrentFrame()) void loadCurrentFrame();
    });

    onBeforeUnmount(() => {
        loadVersion++;
        stopTaskPolling();
        editor.removeEventListener(Event.FRAME_CHANGE, onFrameChange);
        clearFrameOverlay();
        if (previousPointCloudVisibility != null) {
            editor.pc.groupPoints.visible = previousPointCloudVisibility;
            previousPointCloudVisibility = null;
            editor.pc.render();
        }
        editor.pc.scene.remove(visibilityGroup, occGroup);
    });
</script>

<style lang="less" scoped>
    .visibility-overlay-panel {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 3;
        width: 230px;
        padding: 9px 11px;
        color: #d9d9d9;
        font-size: 12px;
        background: rgba(30, 31, 35, 0.9);
        border: 1px solid #545454;
        border-radius: 4px;
        pointer-events: auto;
    }

    .visibility-overlay-status {
        margin-bottom: 7px;
        color: #91caff;

        &.ready {
            color: #73d13d;
        }

        &.empty {
            color: #ffc53d;
        }

        &.error {
            color: #ff7875;
        }
    }

    .visibility-overlay-task-status {
        margin-bottom: 7px;
        color: #d9d9d9;
        line-height: 18px;
    }

    .visibility-overlay-summary {
        padding-bottom: 7px;
        color: #d9d9d9;
        line-height: 18px;
    }

    .visibility-overlay-legend {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding-bottom: 7px;
        border-bottom: 1px solid #545454;

        i {
            display: inline-block;
            width: 9px;
            height: 9px;
            margin-right: 6px;
            border-radius: 2px;
        }

        .box-color {
            background: transparent;
            border: 2px dashed #d9d9d9;
        }

        .visible-color {
            background: #00e676;
        }

        .hidden-color {
            background: #ffc107;
        }
    }

    .visibility-overlay-control {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 8px;
    }

    .visibility-overlay-label {
        margin-top: 8px;
    }

    .visibility-overlay-panel :deep(.ant-slider) {
        margin: 5px 4px 2px;
    }

    .visibility-overlay-panel :deep(.ant-input-number) {
        width: 105px;
    }

    .visibility-overlay-occ-status {
        margin-top: 6px;
        color: #91caff;
    }
</style>
