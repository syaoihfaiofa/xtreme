import * as THREE from 'three';
import type { AnnotateObject } from 'pc-render';
import * as api from '../../../api';
import Editor from '../Editor';
import Event from '../config/event';
import { ObjectType, type GroundCorrectionMask, type GroundCorrectionMaskOperation } from '../type';
import { convertObject2Annotate } from '../utils/result';
import {
    appendGroundCorrectionMaskOperation,
    formatGroundCorrectionMaskPropagationStatus,
    isGroundCorrectionMaskBevActive,
    planGroundCorrectionMaskPropagation,
    transformGroundCorrectionMaskOperation,
} from '../utils/groundCorrectionMaskEditing';

export type GroundCorrectionMaskMode = 'polygon' | 'brush';

export default class GroundCorrectionMaskManager {
    private readonly overlay = new THREE.Group();
    private mode?: GroundCorrectionMaskMode;
    private points: THREE.Vector2[] = [];
    private brushRadius = 0.5;
    private dragging = false;
    private complete?: () => void;

    constructor(private readonly editor: Editor) {
        this.overlay.name = 'ground-correction-mask-editor-overlay';
        this.editor.pc.scene.add(this.overlay);
        this.editor.addEventListener?.(Event.FRAME_CHANGE, this.refreshCurrentFramePointCloud);
        this.editor.cmdManager.addEventListener?.(Event.UNDO, this.refreshCurrentFramePointCloud);
        this.editor.cmdManager.addEventListener?.(Event.REDO, this.refreshCurrentFramePointCloud);
    }

    destroy(): void {
        this.cancel();
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
        const view = this.editor.viewManager.getMainView()!;
        this.mode = mode;
        this.points = [];
        this.renderOverlay();
        view.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
        view.renderer.domElement.addEventListener('dblclick', this.onDoubleClick);
        window.addEventListener('keydown', this.onKeyDown, true);
        this.editor.showMsg(
            'info',
            mode === 'polygon'
                ? '地面纠正区域：点击顶点，双击或 Enter 提交，Esc 取消'
                : '地面纠正笔刷：拖动采样，松开鼠标提交',
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
        this.dragging = false;
        this.clearOverlay();
        complete?.();
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
        if (!this.mode) return;
        if (this.mode === 'polygon') {
            if (event.button !== 0) return;
            const point = this.canvasPoint(event);
            if (!point) return;
            this.points.push(point);
            this.renderOverlay();
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
            });
        } else {
            this.cancel();
        }
    };

    private readonly onDoubleClick = (event: MouseEvent): void => {
        if (this.mode !== 'polygon') return;
        event.preventDefault();
        this.commitPolygon();
    };

    private readonly onKeyDown = (event: KeyboardEvent): void => {
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
        this.editor.showMsg('success', '已保存地面纠正操作');
        this.cancel();
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
        if (this.points.length === 0) return;
        const points = this.points.map((point) => new THREE.Vector3(point.x, point.y, 0.03));
        const geometry = new THREE.BufferGeometry().setFromPoints(
            this.mode === 'polygon' && points.length > 2 ? [...points, points[0]] : points,
        );
        const line = new THREE.Line(
            geometry,
            new THREE.LineBasicMaterial({ color: 0xffd700, depthTest: false }),
        );
        this.overlay.add(line);
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
        view?.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
        view?.renderer.domElement.removeEventListener('dblclick', this.onDoubleClick);
        window.removeEventListener('keydown', this.onKeyDown, true);
        window.removeEventListener('pointermove', this.onPointerMove, true);
        window.removeEventListener('pointerup', this.onPointerUp, true);
    }
}
