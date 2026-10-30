import * as THREE from 'three';
import type { AnnotateObject } from 'pc-render';
import * as api from '../../../api';
import Editor from '../Editor';
import Event from '../config/event';
import {
    ObjectType,
    type GroundCorrectionMask,
    type GroundCorrectionMaskHeightRange,
    type GroundCorrectionMaskOperation,
} from '../type';
import OrbitControlsAction from '../../pc-render/action/OrbitControlsAction';
import { isAutomaticNonGround, isForceGround } from '../../pc-render/points/forceGround';
import { convertObject2Annotate } from '../utils/result';
import {
    appendGroundCorrectionMaskOperation,
    formatGroundCorrectionMaskPropagationStatus,
    isGroundCorrectionMaskBevActive,
    planGroundCorrectionMaskPropagation,
    transformGroundCorrectionMaskOperation,
} from '../utils/groundCorrectionMaskEditing';

export type GroundCorrectionMaskMode = 'polygon' | 'brush' | 'eraser' | 'cluster';
const MAX_CLUSTER_POINTS = 10_000;
const CLUSTER_PICK_TOLERANCE = 1;
const BELOW_GROUND_MARGIN = 0.1;
// Mask height ranges must be finite; this is far below any real ghost reflection.
const BELOW_GROUND_MIN_Z = -1000;
// Large enough to cover a whole frame even after cross-frame pose transforms.
const BELOW_GROUND_POLYGON_HALF_EXTENT = 1000;
// Region growing stops on surfaces steeper than this (car sides, curbs).
const CLUSTER_MAX_SLOPE_TAN = Math.tan((15 * Math.PI) / 180);
// Allows sensor noise when neighbors are almost vertically stacked.
const CLUSTER_SLOPE_Z_NOISE = 0.05;
type PointCloudPosition = { x: number; y: number; z: number };
type ClusterPointSource = { points: THREE.Points; index: number };

export default class GroundCorrectionMaskManager {
    private readonly overlay = new THREE.Group();
    private clusterIndex?: ClusterSpatialIndex;
    private clusterIndexKey?: string;
    private clusterCandidate?: PointCloudPosition;
    private mode?: GroundCorrectionMaskMode;
    private points: THREE.Vector2[] = [];
    private brushRadius = 0.5;
    private readonly raycaster = new THREE.Raycaster();
    private dragging = false;
    private planeRotationAttached = false;
    private polygonPreviewActive = false;
    private rotateEnabledBeforeEditing?: boolean;
    private complete?: () => void;
    private heightRange?: GroundCorrectionMaskHeightRange;

    constructor(private readonly editor: Editor) {
        this.overlay.name = 'ground-correction-mask-editor-overlay';
        this.editor.pc.scene.add(this.overlay);
        this.editor.addEventListener?.(Event.FRAME_CHANGE, this.refreshCurrentFramePointCloud);
        this.editor.cmdManager.addEventListener?.(Event.UNDO, this.refreshCurrentFramePointCloud);
        this.editor.cmdManager.addEventListener?.(Event.REDO, this.refreshCurrentFramePointCloud);
    }

    destroy(): void {
        this.deactivate();
        this.editor.removeEventListener?.(Event.FRAME_CHANGE, this.refreshCurrentFramePointCloud);
        this.editor.cmdManager.removeEventListener?.(Event.UNDO, this.refreshCurrentFramePointCloud);
        this.editor.cmdManager.removeEventListener?.(Event.REDO, this.refreshCurrentFramePointCloud);
        this.editor.pc.scene.remove(this.overlay);
    }

    refreshCurrentFramePointCloud = (): void => {
        const frame = this.editor.getCurrentFrame();
        const mask = frame ? this.getMaskObject(frame.id)?.userData.groundCorrectionMask : undefined;
        this.editor.pc.setGroundCorrectionMask?.(mask?.operations || []);
    };

    start(mode: GroundCorrectionMaskMode): Promise<void> {
        if (this.mode) this.cancel();
        if (!this.isBevActive()) {
            this.editor.showMsg('warning', '地面纠正仅支持在 BEV 主视图中编辑');
            return Promise.resolve();
        }
        if (!this.editor.state.config.groundCorrectionMode) {
            this.editor.showMsg('warning', '请先开启地面纠正模式并设置有效的 Z 范围');
            return Promise.resolve();
        }
        const [min, max] = this.editor.state.config.groundCorrectionHeightRange;
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
            this.editor.showMsg('warning', 'Z 最小值和最大值必须为有效数字，且最小值不能大于最大值');
            return Promise.resolve();
        }
        if (
            mode === 'cluster' &&
            (!Number.isFinite(this.getClusterRadius()) || this.getClusterRadius() <= 0)
        ) {
            this.editor.showMsg('warning', '聚类半径必须为大于 0 的有效数字');
            return Promise.resolve();
        }
        this.heightRange = this.getHeightRange();
        const view = this.editor.viewManager.getMainView()!;
        this.mode = mode;
        const orbit = view.getAction('orbit-control') as OrbitControlsAction | undefined;
        if (orbit) {
            this.rotateEnabledBeforeEditing = orbit.control.enableRotate;
            orbit.control.enableRotate = false;
        }
        this.points = [];
        this.renderOverlay();
        view.renderer.domElement.addEventListener('dblclick', this.onDoubleClick);
        window.addEventListener('keydown', this.onKeyDown, true);
        this.editor.showMsg(
            'info',
            mode === 'polygon'
                ? '地面纠正区域：点击顶点，双击或 Enter 提交，Esc 取消'
                : mode === 'brush'
                  ? '地面纠正笔刷：拖动采样，松开鼠标提交'
                  : mode === 'eraser'
                    ? '橡皮擦：拖动擦除已纠正为地面的点，恢复原分类，Esc 退出'
                    : `聚类选中：点击点云，一键选中半径 ${this.getClusterRadius()}m 的连通点集`,
            5,
        );
        return new Promise((resolve) => {
            this.complete = resolve;
        });
    }

    cancel(): void {
        const complete = this.complete;
        this.complete = undefined;
        this.detachEvents();
        this.mode = undefined;
        this.points = [];
        this.clusterCandidate = undefined;
        this.dragging = false;
        this.clearOverlay();
        if (this.polygonPreviewActive) {
            this.refreshCurrentFramePointCloud();
            this.polygonPreviewActive = false;
        }
        const orbit = this.editor.viewManager.getMainView()
            ?.getAction('orbit-control') as OrbitControlsAction | undefined;
        if (this.rotateEnabledBeforeEditing !== undefined && orbit) {
            orbit.control.enableRotate = this.rotateEnabledBeforeEditing;
        }
        this.rotateEnabledBeforeEditing = undefined;
        complete?.();
    }

    activate(): void {
        const [min, max] = this.editor.state.config.groundCorrectionHeightRange;
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
            this.editor.showMsg('warning', 'Z 最小值和最大值必须为有效数字，且最小值不能大于最大值');
            return;
        }
        this.heightRange = this.getHeightRange();
        this.editor.state.config.groundCorrectionMode = true;
        this.attachPlaneRotationEvent();
        this.editor.pc.material.setUniforms({ groundCorrectionPreview: 1 });
        this.editor.pc.render();
        this.editor.showMsg('info', '已开启地面纠正模式：已纠正的非地面点显示为灰色', 4);
    }

    deactivate(): void {
        this.cancel();
        this.detachPlaneRotationEvent();
        this.heightRange = undefined;
        this.editor.state.config.groundCorrectionMode = false;
        this.editor.pc.material.setUniforms({ groundCorrectionPreview: -1 });
        this.editor.pc.render();
    }

    deleteLastOperation(): void {
        if (!this.isBevActive()) {
            this.editor.showMsg('warning', '地面纠正仅支持在 BEV 主视图中编辑');
            return;
        }
        const frame = this.editor.getCurrentFrame();
        const maskObject = this.getMaskObject(frame.id);
        const mask = maskObject?.userData.groundCorrectionMask;
        if (!mask || mask.operations.length === 0) {
            this.editor.showMsg('warning', '当前帧没有可删除的地面纠正操作');
            return;
        }
        if (mask.operations.length === 1) {
            this.editor.cmdManager.execute('delete-object', [{ objects: maskObject, frame }]);
        } else {
            this.editor.cmdManager.execute('update-ground-correction-mask', {
                object: maskObject,
                frame,
                mask: {
                    version: 1,
                    operations: mask.operations.slice(0, -1),
                },
            });
        }
        this.refreshCurrentFramePointCloud();
        this.editor.showMsg('success', '已删除最后一条地面纠正操作');
    }

    /** Forces every point lower than the pick plane minus a margin to ground, for the whole frame. */
    applyBelowGround(): void {
        if (!this.isBevActive()) {
            this.editor.showMsg('warning', '地面纠正仅支持在 BEV 主视图中编辑');
            return;
        }
        if (!this.editor.state.config.groundCorrectionMode) {
            this.editor.showMsg('warning', '请先开启地面纠正模式');
            return;
        }
        const maxZ = this.getPickZ() - BELOW_GROUND_MARGIN;
        const extent = BELOW_GROUND_POLYGON_HALF_EXTENT;
        this.commit({
            type: 'polygon',
            vertices: [
                { x: -extent, y: -extent },
                { x: extent, y: -extent },
                { x: extent, y: extent },
                { x: -extent, y: extent },
            ],
            heightRange: { min: BELOW_GROUND_MIN_Z, max: maxZ },
        });
        this.editor.showMsg('success', `已将 Z < ${maxZ.toFixed(2)}m 的点归为地面`);
    }

    async propagate(distance: number): Promise<void> {
        if (!this.isBevActive()) {
            this.editor.showMsg('warning', '地面纠正仅支持在 BEV 主视图中编辑');
            return;
        }
        const sourceFrame = this.editor.getCurrentFrame();
        const sourceMask = this.getMaskObject(sourceFrame.id)?.userData.groundCorrectionMask;
        if (!sourceMask?.operations.length) {
            this.editor.showMsg('warning', '当前帧没有可应用的地面纠正掩码');
            return;
        }
        if (!Number.isInteger(distance) || distance < 1) {
            this.editor.showMsg('warning', '应用帧数必须是大于 0 的整数');
            return;
        }
        if (!sourceFrame.sceneId) {
            this.editor.showMsg('warning', '当前帧不属于场景，未应用地面纠正掩码');
            return;
        }
        const frames = this.editor.state.frames;
        const sourceIndex = this.editor.state.frameIndex;
        try {
            const frameIds = frames
                .filter((frame) => frame.sceneId === sourceFrame.sceneId)
                .map((frame) => frame.id);
            const [poses, segments] = await Promise.all([
                api.getScenePoses(frameIds),
                api.getSceneLocationSegments(sourceFrame.sceneId, frameIds),
            ]);
            const sourcePose = poses[String(sourceFrame.id)];
            if (!sourcePose) {
                this.editor.showMsg('warning', '当前帧缺少 location 位姿，未应用地面纠正掩码');
                return;
            }
            if (!segments[String(sourceFrame.id)]) {
                this.editor.showMsg('warning', '当前帧缺少 location segment，未应用地面纠正掩码');
                return;
            }
            const selection = planGroundCorrectionMaskPropagation(
                frames,
                sourceIndex,
                distance,
                poses,
                segments,
            );
            if (selection.frameIds.length === 0) {
                this.editor.showMsg(
                    'warning',
                    formatGroundCorrectionMaskPropagationStatus(0, selection, 0),
                );
                return;
            }
            const targetResults = await Promise.allSettled(
                selection.frameIds.map(async (frameId) => ({
                    frame: this.editor.getFrame(frameId),
                    objects: await this.getOrLoadFrameObjects(frameId),
                    pose: poses[frameId],
                })),
            );
            const targets = targetResults
                .filter(
                    (
                        result,
                    ): result is PromiseFulfilledResult<{
                        frame: ReturnType<Editor['getFrame']>;
                        objects: AnnotateObject[];
                        pose: api.IScenePose;
                    }> => result.status === 'fulfilled',
                )
                .map((result) => result.value);
            const failed = targetResults.length - targets.length;
            let applied = 0;
            this.editor.cmdManager.withGroup(() => {
                targets.forEach(({ frame, objects, pose }) => {
                    if (!frame || !pose) return;
                    const transformed = sourceMask.operations.map((operation) =>
                        transformGroundCorrectionMaskOperation(operation, sourcePose, pose),
                    );
                    const targetMask = objects.find((object) => this.isMaskObject(object));
                    if (targetMask) {
                        const existing = targetMask.userData.groundCorrectionMask || {
                            version: 1,
                            operations: [],
                        };
                        this.editor.cmdManager.execute('update-ground-correction-mask', {
                            object: targetMask,
                            frame,
                            mask: transformed.reduce(
                                appendGroundCorrectionMaskOperation,
                                existing,
                            ),
                        });
                    } else {
                        this.editor.cmdManager.execute('add-object', [{
                            objects: this.createMaskObject({ version: 1, operations: transformed }),
                            frame,
                        }]);
                    }
                    applied++;
                });
            });
            this.editor.showMsg(
                selection.missingPoseFrameIds.length ||
                    selection.differentSegmentFrameIds.length ||
                    failed
                    ? 'warning'
                    : 'success',
                formatGroundCorrectionMaskPropagationStatus(applied, selection, failed),
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.editor.showMsg('error', `地面纠正掩码应用失败：${message}`);
        }
    }

    private readonly onPointerDown = (event: PointerEvent): void => {
        if (event.button === 0 && event.ctrlKey) return;
        if (!this.mode) return;
        if (this.mode === 'polygon') {
            if (event.button !== 0) return;
            const point = this.canvasPoint(event);
            if (!point) return;
            this.points.push(point);
            this.previewPolygon();
            this.renderOverlay();
            return;
        }
        if (this.mode === 'cluster') {
            if (event.button !== 0) return;
            event.preventDefault();
            const cluster = this.pickCluster(event);
            if (!cluster.length) {
                this.editor.showMsg('warning', '未拾取到可用点云点');
                return;
            }
            if (cluster.length === MAX_CLUSTER_POINTS) {
                this.editor.showMsg('warning', `聚类点集已限制为 ${MAX_CLUSTER_POINTS} 点`);
            }
            this.commit({
                type: 'cluster',
                points: cluster,
                radius: this.getClusterRadius(),
            });
            return;
        }
        if (event.button !== 0) return;
        event.preventDefault();
        this.dragging = true;
        const point = this.canvasPoint(event);
        if (point) this.points = [point];
        window.addEventListener('pointermove', this.onPointerMove, true);
        window.addEventListener('pointerup', this.onPointerUp, true);
        this.renderOverlay();
    };

    private readonly onPointerMove = (event: PointerEvent): void => {
        if (!this.dragging) return;
        const point = this.canvasPoint(event);
        const previous = this.points[this.points.length - 1];
        if (point && (!previous || previous.distanceToSquared(point) >= 0.01)) {
            this.points.push(point);
            this.renderOverlay();
        }
    };

    private readonly onPointerUp = (): void => {
        if (!this.dragging) return;
        this.dragging = false;
        window.removeEventListener('pointermove', this.onPointerMove, true);
        window.removeEventListener('pointerup', this.onPointerUp, true);
        if (this.points.length > 0) {
            this.commit({
                type: 'brush',
                samples: this.points.map((point) => ({ x: point.x, y: point.y })),
                radius: this.brushRadius,
                heightRange: { ...this.heightRange! },
                ...(this.mode === 'eraser' ? { erase: true as const } : {}),
            });
        } else if (this.mode !== 'eraser') {
            this.cancel();
        }
    };

    private readonly onDoubleClick = (event: MouseEvent): void => {
        if (this.mode !== 'polygon') return;
        event.preventDefault();
        this.commitPolygon();
    };

    private readonly onKeyDown = (event: KeyboardEvent): void => {
        // Editing modes stay active, and ActionManager blocks hotkey actions while an
        // action is running, so undo/redo must be handled here.
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            event.stopPropagation();
            if (this.dragging) return;
            if (event.shiftKey) {
                this.editor.cmdManager.redo();
                return;
            }
            if (this.mode === 'polygon' && this.points.length > 0) {
                this.points.pop();
                this.previewPolygon();
                this.renderOverlay();
                return;
            }
            this.editor.cmdManager.undo();
            return;
        }
        if (event.key === 'Escape' && this.mode === 'polygon' && this.points.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            this.points = [];
            this.refreshCurrentFramePointCloud();
            this.polygonPreviewActive = false;
            this.renderOverlay();
            return;
        }
        // The global hotkeys-js Esc handler ignores keys while a panel input keeps focus,
        // and pointerdown preventDefault stops the canvas from taking focus, so exit here.
        if (event.key === 'Escape' && this.mode) {
            event.preventDefault();
            event.stopPropagation();
            this.editor.actionManager.stopCurrentAction();
            if (this.mode) this.cancel();
            return;
        }
        if (event.key !== 'Enter' || this.mode !== 'polygon') return;
        event.preventDefault();
        this.commitPolygon();
    };

    private commitPolygon(): void {
        const vertices = this.removeDuplicateTrailingPoint(this.points);
        if (vertices.length < 3) {
            this.editor.showMsg('warning', '区域模式至少需要 3 个顶点');
            return;
        }
        this.commit({
            type: 'polygon',
            vertices: vertices.map((point) => ({ x: point.x, y: point.y })),
            heightRange: { ...this.heightRange! },
        });
    }

    private commit(operation: GroundCorrectionMaskOperation): void {
        const frame = this.editor.getCurrentFrame();
        const existing = this.getMaskObject(frame.id);
        if (existing) {
            const mask = existing.userData.groundCorrectionMask || { version: 1, operations: [] };
            this.editor.cmdManager.execute('update-ground-correction-mask', {
                object: existing,
                frame,
                mask: appendGroundCorrectionMaskOperation(mask, operation),
            });
        } else {
            this.editor.cmdManager.execute('add-object', [{
                objects: this.createMaskObject({ version: 1, operations: [operation] }),
                frame,
            }]);
        }
        this.refreshCurrentFramePointCloud();
        this.polygonPreviewActive = false;
        this.editor.showMsg('success', '已保存地面纠正操作');
        if (this.mode === 'polygon' || this.mode === 'cluster' || this.mode === 'eraser') {
            this.points = [];
            this.renderOverlay();
            return;
        }
        this.cancel();
    }

    private previewPolygon(): void {
        if (this.mode !== 'polygon' || this.points.length < 3) {
            this.polygonPreviewActive = false;
            this.refreshCurrentFramePointCloud();
            return;
        }
        const frame = this.editor.getCurrentFrame();
        const mask = this.getMaskObject(frame.id)?.userData.groundCorrectionMask;
        const vertices = this.removeDuplicateTrailingPoint(this.points);
        if (vertices.length < 3) {
            this.polygonPreviewActive = false;
            this.refreshCurrentFramePointCloud();
            return;
        }
        this.editor.pc.setGroundCorrectionMask?.([
            ...(mask?.operations || []),
            {
                type: 'polygon',
                vertices: vertices.map((point) => ({ x: point.x, y: point.y })),
                heightRange: { ...this.heightRange! },
            },
        ]);
        this.polygonPreviewActive = true;
    }

    private getMaskObject(frameId: string): AnnotateObject | undefined {
        return this.editor.dataManager
            .getFrameObject(frameId)
            ?.find((object) => this.isMaskObject(object));
    }

    private async getOrLoadFrameObjects(frameId: string): Promise<AnnotateObject[]> {
        const cached = this.editor.dataManager.getFrameObject(frameId);
        if (cached) return cached;
        const result = await api.getDataObject(frameId);
        const objects = convertObject2Annotate(result.objectsMap[frameId] || [], this.editor);
        this.editor.dataManager.setFrameObject(frameId, objects);
        return objects;
    }

    private createMaskObject(mask: GroundCorrectionMask): AnnotateObject {
        const object = new THREE.Object3D() as THREE.Object3D & AnnotateObject;
        object.visible = false;
        object.userData = { groundCorrectionMask: mask };
        object.uuid = THREE.MathUtils.generateUUID();
        (object as any).objectType = ObjectType.TYPE_GROUND_CORRECTION_MASK;
        return object;
    }

    private isMaskObject(object: AnnotateObject): boolean {
        return (object as any).objectType === ObjectType.TYPE_GROUND_CORRECTION_MASK;
    }

    private isBevActive(): boolean {
        return isGroundCorrectionMaskBevActive(this.editor);
    }

    private getClusterRadius(): number {
        return this.editor.state.config.groundCorrectionClusterRadius;
    }

    private pickCluster(event: PointerEvent): { x: number; y: number; z: number }[] {
        const view = this.editor.viewManager.getMainView();
        if (!view) return [];
        const radius = this.getClusterRadius();
        const rect = view.renderer.domElement.getBoundingClientRect();
        this.raycaster.setFromCamera({
            x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
            y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
        }, view.camera);
        const pickZ = this.getPickZ();
        const planePoint = this.raycaster.ray.intersectPlane(
            new THREE.Plane(new THREE.Vector3(0, 0, 1), -pickZ),
            new THREE.Vector3(),
        );
        if (!planePoint) return [];
        const heightRange = this.getClusterHeightRange(pickZ);
        if (heightRange.min > heightRange.max) return [];
        const index = this.getPointCloudIndex(radius);
        const isSelectable = this.createNotForcedGroundFilter(index);
        const seedIndex = index.findSeedNearPlanePoint(
            planePoint,
            Math.max(radius, CLUSTER_PICK_TOLERANCE),
            heightRange,
            isSelectable,
        );
        if (seedIndex === undefined) return [];
        const seed = index.getPoint(seedIndex);
        this.clusterCandidate = seed;
        this.heightRange = heightRange;
        this.editor.showMsg(
            'info',
            `候选点 Z=${seed.z.toFixed(2)}m（拾取平面 Z=${pickZ.toFixed(2)}m，聚类高度 ${heightRange.min.toFixed(2)}~${heightRange.max.toFixed(2)}m）`,
            3,
        );
        this.renderOverlay();
        return index.collectConnected(seedIndex, radius, heightRange, isSelectable);
    }

    /**
     * Indexes only points the correction can change: points the automatic classifier
     * already marks as ground are skipped, otherwise clusters flood across flat ground
     * up to MAX_CLUSTER_POINTS. Clouds without RGB+intensity have no automatic
     * classification, so all their points are indexed.
     */
    private getPointCloudIndex(radius: number): ClusterSpatialIndex {
        const key = this.getPointCloudIndexKey(radius);
        if (this.clusterIndex && this.clusterIndexKey === key) return this.clusterIndex;
        const positions: PointCloudPosition[] = [];
        const sources: ClusterPointSource[] = [];
        this.editor.pc.groupPoints.updateMatrixWorld(true);
        this.editor.pc.groupPoints.children.forEach((child) => {
            const points = child as THREE.Points;
            const geometry = points.geometry;
            const position = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
            if (!position) return;
            const color = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
            const intensity = geometry.getAttribute('intensity') as THREE.BufferAttribute | undefined;
            const hasColor = !!color && color.count >= position.count;
            const hasIntensity = !!intensity && intensity.count >= position.count;
            points.updateMatrixWorld(true);
            const worldPoint = new THREE.Vector3();
            for (let index = 0; index < position.count; index++) {
                if (
                    hasColor &&
                    hasIntensity &&
                    !isAutomaticNonGround({
                        hasColor,
                        hasIntensity,
                        color: [color!.getX(index), color!.getY(index), color!.getZ(index)],
                        intensity: intensity!.getX(index),
                    })
                ) {
                    continue;
                }
                worldPoint.fromBufferAttribute(position, index).applyMatrix4(points.matrixWorld);
                positions.push({ x: worldPoint.x, y: worldPoint.y, z: worldPoint.z });
                sources.push({ points, index });
            }
        });
        this.clusterIndex = new ClusterSpatialIndex(positions, sources, radius);
        this.clusterIndexKey = key;
        return this.clusterIndex;
    }

    /** Points already corrected to ground cannot change, so clusters do not grow through them. */
    private createNotForcedGroundFilter(index: ClusterSpatialIndex): (pointIndex: number) => boolean {
        return (pointIndex) => {
            const source = index.getSource(pointIndex);
            const forceGround = source.points.geometry
                ?.getAttribute('forceGround') as THREE.BufferAttribute | undefined;
            return !forceGround || !isForceGround(forceGround.getX(source.index));
        };
    }

    private getPointCloudIndexKey(radius: number): string {
        return [
            radius,
            ...this.editor.pc.groupPoints.children.map((child) => {
                const geometry = (child as THREE.Points).geometry;
                const position = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
                return [
                    child.uuid,
                    child.userData.chunkId || '',
                    geometry?.uuid || '',
                    position?.count || 0,
                    position?.version || 0,
                ].join(':');
            }),
        ].join('|');
    }

    private getHeightRange(): GroundCorrectionMaskHeightRange {
        const [min, max] = this.editor.state.config.groundCorrectionHeightRange;
        return { min, max };
    }

    private getClusterHeightRange(pickZ: number): GroundCorrectionMaskHeightRange {
        const { min, max } = this.getHeightRange();
        const tolerance = this.editor.state.config.groundCorrectionClusterHeightTolerance;
        return {
            min: Math.max(min, pickZ - tolerance),
            max: Math.min(max, pickZ + tolerance),
        };
    }

    private getPickZ(): number {
        return this.editor.state.config.groundCorrectionPickZ;
    }

    private attachPlaneRotationEvent(): void {
        if (this.planeRotationAttached) return;
        const view = this.editor.viewManager.getMainView();
        if (!view) return;
        this.planeRotationAttached = true;
        view.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    }

    private detachPlaneRotationEvent(): void {
        if (!this.planeRotationAttached) return;
        this.planeRotationAttached = false;
        const view = this.editor.viewManager.getMainView();
        view?.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    }

    private canvasPoint(event: PointerEvent): THREE.Vector2 | undefined {
        const view = this.editor.viewManager.getMainView();
        if (!view) return undefined;
        const rect = view.renderer.domElement.getBoundingClientRect();
        const point = view.canvasToWorld(new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top));
        return point ? new THREE.Vector2(point.x, point.y) : undefined;
    }

    private removeDuplicateTrailingPoint(points: THREE.Vector2[]): THREE.Vector2[] {
        const result = points.map((point) => point.clone());
        while (result.length > 1 && result.at(-1)!.distanceToSquared(result.at(-2)!) < 1e-8) {
            result.pop();
        }
        return result;
    }

    private renderOverlay(): void {
        this.clearOverlay();
        if (this.points.length > 0) {
            const points = this.points.map(
                (point) => new THREE.Vector3(point.x, point.y, this.getPickZ() + 0.03),
            );
            const geometry = new THREE.BufferGeometry().setFromPoints(
                this.mode === 'polygon' && points.length > 2 ? [...points, points[0]] : points,
            );
            const line = new THREE.Line(
                geometry,
                new THREE.LineBasicMaterial({
                    color: this.mode === 'eraser' ? 0x40a9ff : 0xffd700,
                    depthTest: false,
                }),
            );
            const vertices = new THREE.Points(
                new THREE.BufferGeometry().setFromPoints(points),
                new THREE.PointsMaterial({
                    color: 0xffd700,
                    size: 3,
                    sizeAttenuation: false,
                    depthTest: false,
                    depthWrite: false,
                }),
            );
            this.overlay.add(line, vertices);
        }
        if (this.clusterCandidate) {
            const marker = new THREE.Points(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(
                        this.clusterCandidate.x,
                        this.clusterCandidate.y,
                        this.clusterCandidate.z,
                    ),
                ]),
                new THREE.PointsMaterial({
                    color: 0xff4d4f,
                    size: 8,
                    sizeAttenuation: false,
                    depthTest: false,
                    depthWrite: false,
                }),
            );
            marker.name = 'cluster-candidate-marker';
            this.overlay.add(marker);
        }
        this.editor.pc.render();
    }

    private clearOverlay(): void {
        while (this.overlay.children.length) {
            const child = this.overlay.children.pop() as THREE.Line;
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
        }
        this.editor.pc.render();
    }

    private detachEvents(): void {
        const view = this.editor.viewManager.getMainView();
        view?.renderer.domElement.removeEventListener('dblclick', this.onDoubleClick);
        window.removeEventListener('keydown', this.onKeyDown, true);
        window.removeEventListener('pointermove', this.onPointerMove, true);
        window.removeEventListener('pointerup', this.onPointerUp, true);
    }
}

class ClusterSpatialIndex {
    private readonly cells = new Map<string, number[]>();
    private minZ = Infinity;
    private maxZ = -Infinity;

    constructor(
        private readonly points: readonly PointCloudPosition[],
        private readonly sources: readonly ClusterPointSource[],
        private readonly cellSize: number,
    ) {
        points.forEach((point, index) => {
            this.minZ = Math.min(this.minZ, point.z);
            this.maxZ = Math.max(this.maxZ, point.z);
            const key = clusterCellKey(point.x, point.y, point.z, cellSize);
            const cell = this.cells.get(key) || [];
            cell.push(index);
            this.cells.set(key, cell);
        });
    }

    getPoint(index: number): PointCloudPosition {
        return { ...this.points[index] };
    }

    getSource(index: number): ClusterPointSource {
        return this.sources[index];
    }

    /**
     * Picks the point closest in 3D to the click on the pick plane, limited to
     * points within `xyTolerance` horizontally and inside `heightRange`, so
     * points near the configured ground height win over points above/below.
     */
    findSeedNearPlanePoint(
        planePoint: PointCloudPosition,
        xyTolerance: number,
        heightRange: GroundCorrectionMaskHeightRange,
        isSelectable: (index: number) => boolean,
    ): number | undefined {
        const xyToleranceSquared = xyTolerance * xyTolerance;
        let nearestIndex: number | undefined;
        let nearestDistance = Infinity;
        const minZ = Math.max(heightRange.min, this.minZ);
        const maxZ = Math.min(heightRange.max, this.maxZ);
        if (minZ > maxZ) return undefined;
        const cell = (value: number): number => Math.floor(value / this.cellSize);
        for (let cellX = cell(planePoint.x - xyTolerance); cellX <= cell(planePoint.x + xyTolerance); cellX++) {
            for (let cellY = cell(planePoint.y - xyTolerance); cellY <= cell(planePoint.y + xyTolerance); cellY++) {
                for (let cellZ = cell(minZ); cellZ <= cell(maxZ); cellZ++) {
                    this.cells.get(`${cellX},${cellY},${cellZ}`)?.forEach((index) => {
                        const point = this.points[index];
                        if (!isWithinHeightRange(point, heightRange)) return;
                        const dx = point.x - planePoint.x;
                        const dy = point.y - planePoint.y;
                        const xyDistance = dx * dx + dy * dy;
                        if (xyDistance > xyToleranceSquared) return;
                        const dz = point.z - planePoint.z;
                        const distance = xyDistance + dz * dz;
                        if (distance < nearestDistance && isSelectable(index)) {
                            nearestDistance = distance;
                            nearestIndex = index;
                        }
                    });
                }
            }
        }
        return nearestIndex;
    }

    collectConnected(
        seedIndex: number,
        radius: number,
        heightRange: GroundCorrectionMaskHeightRange,
        isSelectable: (index: number) => boolean,
    ): PointCloudPosition[] {
        if (!isWithinHeightRange(this.points[seedIndex], heightRange)) return [];
        const radiusSquared = radius * radius;
        const selected = new Set<number>([seedIndex]);
        const queue = [seedIndex];
        for (let queueIndex = 0; queueIndex < queue.length && selected.size < MAX_CLUSTER_POINTS; queueIndex++) {
            const current = this.points[queue[queueIndex]];
            this.forEachNeighbor(current, (candidateIndex) => {
                if (selected.size >= MAX_CLUSTER_POINTS || selected.has(candidateIndex)) return;
                const candidate = this.points[candidateIndex];
                if (!isWithinHeightRange(candidate, heightRange)) return;
                const dx = current.x - candidate.x;
                const dy = current.y - candidate.y;
                const dz = current.z - candidate.z;
                const xyDistanceSquared = dx * dx + dy * dy;
                const maxDz = Math.sqrt(xyDistanceSquared) * CLUSTER_MAX_SLOPE_TAN + CLUSTER_SLOPE_Z_NOISE;
                if (Math.abs(dz) > maxDz) return;
                if (xyDistanceSquared + dz * dz <= radiusSquared && isSelectable(candidateIndex)) {
                    selected.add(candidateIndex);
                    queue.push(candidateIndex);
                }
            });
        }
        return [...selected].map((index) => ({ ...this.points[index] }));
    }

    private forEachNeighbor(
        point: PointCloudPosition,
        callback: (index: number) => void,
    ): void {
        const cellX = Math.floor(point.x / this.cellSize);
        const cellY = Math.floor(point.y / this.cellSize);
        const cellZ = Math.floor(point.z / this.cellSize);
        for (let offsetX = -1; offsetX <= 1; offsetX++) {
            for (let offsetY = -1; offsetY <= 1; offsetY++) {
                for (let offsetZ = -1; offsetZ <= 1; offsetZ++) {
                    this.cells.get(
                        `${cellX + offsetX},${cellY + offsetY},${cellZ + offsetZ}`,
                    )?.forEach(callback);
                }
            }
        }
    }
}

function isWithinHeightRange(
    point: PointCloudPosition,
    heightRange: GroundCorrectionMaskHeightRange,
): boolean {
    return point.z >= heightRange.min && point.z <= heightRange.max;
}

function clusterCellKey(x: number, y: number, z: number, size: number): string {
    return `${Math.floor(x / size)},${Math.floor(y / size)},${Math.floor(z / size)}`;
}
