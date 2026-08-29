import * as THREE from 'three';

import { Event } from '../config';
import GroundPolyline from '../objects/GroundPolyline';
import MainRenderView from '../renderView/MainRenderView';
import {
    ISnapHeightReference,
    selectHeightContinuousHit,
} from '../utils/groundPolylineSnap';
import Action from './Action';
import OrbitControlsAction from './OrbitControlsAction';

const SNAP_THRESHOLD_METERS = 0.5;
const EXTEND_HANDLE_OFFSET_PX = 14;

type ExtendEnd = 'start' | 'end';

export default class EditGroundPolylineAction extends Action {
    static actionName: string = 'edit-ground-polyline';
    renderView: MainRenderView;
    onGroundPolylinePointsChange?: (
        object: GroundPolyline,
        points: THREE.Vector3[],
    ) => void;
    onGroundPolylineVertexSelect?: (object: GroundPolyline, index: number) => void;
    onGroundPolylineSegmentInsert?: (
        object: GroundPolyline,
        segmentIndex: number,
        point: THREE.Vector3,
    ) => void;
    onGroundPolylineHeightChange?: (object: GroundPolyline, wallHeight: number) => void;
    getSelectedGroundPolylineVertex?: () => { object: GroundPolyline; index: number } | undefined;
    onExtendHint?: (message: string) => void;

    private readonly layer: HTMLDivElement;
    private readonly handles: HTMLDivElement[] = [];
    private readonly segmentHandles: HTMLDivElement[] = [];
    private readonly extendStartHandle: HTMLDivElement;
    private readonly extendEndHandle: HTMLDivElement;
    private readonly extendCanvas: HTMLCanvasElement;
    private readonly extendContext: CanvasRenderingContext2D;
    private readonly raycaster: THREE.Raycaster = new THREE.Raycaster();
    private readonly pointer: THREE.Vector2 = new THREE.Vector2();
    private readonly estimatePlane: THREE.Plane = new THREE.Plane();
    private readonly estimatedPoint: THREE.Vector3 = new THREE.Vector3();
    private extendEnd: ExtendEnd | null = null;
    private extendPreview: THREE.Vector2 | null = null;
    private pendingExtendClick?: { event: MouseEvent; timer: number };
    private dragMove?: (event: PointerEvent) => void;
    private dragUp?: () => void;
    private heightDragMove?: (event: PointerEvent) => void;
    private heightDragUp?: () => void;
    private readonly onSelect = (): void => {
        this.endExtend();
    };
    private readonly onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') this.endExtend();
    };
    private readonly updateHandles = (): void => {
        const object = this.getObject();
        if (!this.isEnable() || !object || !object.visible) {
            this.layer.style.display = 'none';
            this.extendStartHandle.style.display = 'none';
            this.extendEndHandle.style.display = 'none';
            if (!this.extendEnd) {
                this.extendCanvas.style.display = 'none';
            }
            return;
        }

        this.ensureHandles(object.points3D.length);
        this.ensureSegmentHandles(object.points3D.length - 1);
        this.layer.style.display = 'block';
        object.updateMatrixWorld();
        const screenPoints: Array<{ x: number; y: number; visible: boolean }> = [];
        object.points3D.forEach((point, index) => {
            const projected = point
                .clone()
                .applyMatrix4(object.matrixWorld)
                .project(this.renderView.camera);
            const visible =
                projected.z >= -1 &&
                projected.z <= 1 &&
                Math.abs(projected.x) <= 1 &&
                Math.abs(projected.y) <= 1;
            const screenX = ((projected.x + 1) / 2) * this.renderView.width;
            const screenY = (1 - (projected.y + 1) / 2) * this.renderView.height;
            screenPoints.push({ x: screenX, y: screenY, visible });
            const handle = this.handles[index];
            handle.style.display =
                visible && !object.isVisibilityBoundaryPoint(index) ? 'block' : 'none';
            handle.style.left = `${screenX}px`;
            handle.style.top = `${screenY}px`;
            const selectedVertex = this.getSelectedGroundPolylineVertex?.();
            handle.style.background =
                this.extendEnd === 'start' && index === 0
                    ? '#00e5ff'
                    : this.extendEnd === 'end' && index === object.points3D.length - 1
                      ? '#00e5ff'
                      : selectedVertex?.object === object && selectedVertex.index === index
                        ? '#00e5ff'
                      : '#10252a';
        });
        this.handles.slice(object.points3D.length).forEach((handle) => {
            handle.style.display = 'none';
        });
        const bevVisible = object.getBevSegmentVisible();
        for (let index = 0; index < object.points3D.length - 1; index++) {
            const start = screenPoints[index];
            const end = screenPoints[index + 1];
            const handle = this.segmentHandles[index];
            const canInsert =
                !this.extendEnd &&
                start.visible &&
                end.visible &&
                bevVisible[index] !== false &&
                !object.isVisibilityBoundaryPoint(index) &&
                !object.isVisibilityBoundaryPoint(index + 1);
            handle.style.display = canInsert ? 'block' : 'none';
            handle.style.left = `${(start.x + end.x) / 2}px`;
            handle.style.top = `${(start.y + end.y) / 2}px`;
        }
        this.segmentHandles.slice(object.points3D.length - 1).forEach((handle) => {
            handle.style.display = 'none';
        });
        this.positionExtendHandle(this.extendStartHandle, screenPoints, 0);
        this.positionExtendHandle(this.extendEndHandle, screenPoints, screenPoints.length - 1);
        if (this.extendEnd) {
            this.drawExtendPreview(object, screenPoints);
        }
    };

    constructor(renderView: MainRenderView) {
        super();
        this.renderView = renderView;
        this.layer = document.createElement('div');
        this.layer.style.cssText =
            'position:absolute;inset:0;pointer-events:none;z-index:4;display:none;';
        this.renderView.container.appendChild(this.layer);

        this.extendStartHandle = this.createExtendHandle('start');
        this.extendEndHandle = this.createExtendHandle('end');
        this.layer.appendChild(this.extendStartHandle);
        this.layer.appendChild(this.extendEndHandle);

        this.extendCanvas = document.createElement('canvas');
        this.extendCanvas.className = 'extend-ground-polyline';
        this.extendCanvas.style.cssText =
            'position:absolute;left:0;top:0;width:100%;height:100%;display:none;' +
            'cursor:crosshair;z-index:5;';
        this.extendContext = this.extendCanvas.getContext('2d') as CanvasRenderingContext2D;
        this.renderView.container.appendChild(this.extendCanvas);

        this.extendCanvas.addEventListener('click', this.onExtendClick);
        this.extendCanvas.addEventListener('dblclick', this.onExtendDoubleClick);
        this.extendCanvas.addEventListener('mousemove', this.onExtendMouseMove);

        this.raycaster.params.Points = { threshold: SNAP_THRESHOLD_METERS };
    }

    init(): void {
        this.renderView.addEventListener(Event.RENDER_AFTER, this.updateHandles);
        this.renderView.pointCloud.addEventListener(Event.SELECT, this.onSelect);
        document.addEventListener('keydown', this.onKeyDown);
        this.renderView.container.addEventListener('pointerdown', this.onHeightPointerDown, true);
    }

    destroy(): void {
        this.endExtend();
        this.clearDrag();
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.updateHandles);
        this.renderView.pointCloud.removeEventListener(Event.SELECT, this.onSelect);
        document.removeEventListener('keydown', this.onKeyDown);
        this.renderView.container.removeEventListener('pointerdown', this.onHeightPointerDown, true);
        this.clearHeightDrag();
        this.extendCanvas.removeEventListener('click', this.onExtendClick);
        this.extendCanvas.removeEventListener('dblclick', this.onExtendDoubleClick);
        this.extendCanvas.removeEventListener('mousemove', this.onExtendMouseMove);
        this.layer.remove();
        this.extendCanvas.remove();
        this.handles.splice(0);
        this.segmentHandles.splice(0);
    }

    private createExtendHandle(end: ExtendEnd): HTMLDivElement {
        const handle = document.createElement('div');
        handle.style.cssText =
            'position:absolute;width:16px;height:16px;border:2px solid #7cff7c;' +
            'border-radius:50%;background:#16301a;color:#7cff7c;font-size:12px;' +
            'line-height:12px;text-align:center;box-sizing:border-box;' +
            'transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;' +
            'font-weight:bold;user-select:none;';
        handle.textContent = '+';
        handle.title = 'Extend polyline from this end';
        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.startExtend(end);
        });
        return handle;
    }

    private positionExtendHandle(
        handle: HTMLDivElement,
        screenPoints: Array<{ x: number; y: number; visible: boolean }>,
        index: number,
    ): void {
        const point = screenPoints[index];
        const neighbor = screenPoints[index === 0 ? 1 : index - 1];
        if (!point?.visible || !neighbor) {
            handle.style.display = 'none';
            return;
        }
        const direction = new THREE.Vector2(point.x - neighbor.x, point.y - neighbor.y);
        if (direction.lengthSq() <= 0.0001) {
            direction.set(index === 0 ? -1 : 1, 0);
        } else {
            direction.normalize();
        }
        handle.style.display = this.extendEnd ? 'none' : 'block';
        handle.style.left = `${point.x + direction.x * EXTEND_HANDLE_OFFSET_PX}px`;
        handle.style.top = `${point.y + direction.y * EXTEND_HANDLE_OFFSET_PX}px`;
    }

    private getObject(): GroundPolyline | null {
        const object = this.renderView.pointCloud.selection.find(
            (candidate) =>
                candidate instanceof GroundPolyline &&
                candidate.parent === this.renderView.pointCloud.annotate3D,
        );
        return object instanceof GroundPolyline ? object : null;
    }

    private ensureHandles(count: number): void {
        while (this.handles.length < count) {
            const handle = document.createElement('div');
            handle.style.cssText =
                'position:absolute;width:10px;height:10px;border:2px solid #00e5ff;' +
                'border-radius:50%;background:#10252a;box-sizing:border-box;' +
                'transform:translate(-50%,-50%);pointer-events:auto;cursor:grab;';
            handle.addEventListener('pointerdown', (event) => {
                this.onVertexPointerDown(event, Number(handle.dataset.index));
            });
            this.layer.appendChild(handle);
            this.handles.push(handle);
        }
        this.handles.forEach((handle, index) => {
            handle.dataset.index = String(index);
        });
    }

    private ensureSegmentHandles(count: number): void {
        while (this.segmentHandles.length < count) {
            const handle = document.createElement('div');
            handle.style.cssText =
                'position:absolute;width:14px;height:14px;border:2px solid #7cff7c;' +
                'border-radius:50%;background:#16301a;color:#7cff7c;font-size:12px;' +
                'line-height:10px;text-align:center;box-sizing:border-box;' +
                'transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;' +
                'font-weight:bold;user-select:none;';
            handle.textContent = '+';
            handle.title = 'Insert point into this segment';
            handle.addEventListener('pointerdown', (event) => {
                this.onSegmentPointerDown(event, Number(handle.dataset.index));
            });
            this.layer.appendChild(handle);
            this.segmentHandles.push(handle);
        }
        this.segmentHandles.forEach((handle, index) => {
            handle.dataset.index = String(index);
        });
    }

    private onVertexPointerDown(event: PointerEvent, index: number): void {
        const object = this.getObject();
        if (!object || index < 0 || index >= object.points3D.length) return;
        if (!object.isVisibilityBoundaryPoint(index)) {
            this.onGroundPolylineVertexSelect?.(object, index);
        }
        const isEndpoint = index === 0 || index === object.points3D.length - 1;
        if (isEndpoint && (event.altKey || event.detail >= 2)) {
            event.preventDefault();
            event.stopPropagation();
            this.startExtend(index === 0 ? 'start' : 'end');
            return;
        }
        this.startDrag(event, index);
    }

    private onSegmentPointerDown(event: PointerEvent, segmentIndex: number): void {
        const object = this.getObject();
        if (
            !object ||
            segmentIndex < 0 ||
            segmentIndex >= object.points3D.length - 1 ||
            object.isVisibilityBoundaryPoint(segmentIndex) ||
            object.isVisibilityBoundaryPoint(segmentIndex + 1)
        ) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const point = object.points3D[segmentIndex]
            .clone()
            .lerp(object.points3D[segmentIndex + 1], 0.5);
        this.onGroundPolylineSegmentInsert?.(object, segmentIndex, point);
    }

    private readonly onHeightPointerDown = (event: PointerEvent): void => {
        if (!event.shiftKey || event.target !== this.renderView.renderer.domElement || this.extendEnd) return;
        const object = this.getObject();
        if (!object) return;
        object.updateMatrixWorld();
        const rect = this.renderView.renderer.domElement.getBoundingClientRect();
        const pointer = new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
        let selected: { index: number; midpoint: THREE.Vector3; screen: THREE.Vector2 } | null = null;
        let nearestDistance = 10;
        for (let index = 0; index < object.points3D.length - 1; index++) {
            if (object.isVisibilityBoundaryPoint(index) || object.isVisibilityBoundaryPoint(index + 1)) continue;
            const start = this.projectWorldPoint(object.points3D[index].clone().applyMatrix4(object.matrixWorld));
            const end = this.projectWorldPoint(object.points3D[index + 1].clone().applyMatrix4(object.matrixWorld));
            const distance = distanceToScreenSegment(pointer, start, end);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                selected = {
                    index,
                    midpoint: object.points3D[index]
                        .clone()
                        .lerp(object.points3D[index + 1], 0.5)
                        .applyMatrix4(object.matrixWorld),
                    screen: start.add(end).multiplyScalar(0.5),
                };
            }
        }
        if (!selected) return;
        const up = this.projectWorldPoint(selected.midpoint.clone().add(new THREE.Vector3(0, 0, 1)))
            .sub(selected.screen);
        if (up.lengthSq() < 1) return;
        event.preventDefault();
        event.stopPropagation();
        this.clearHeightDrag();
        const startHeight = object.wallHeight;
        const startPointer = new THREE.Vector2(event.clientX, event.clientY);
        this.heightDragMove = (moveEvent: PointerEvent): void => {
            const delta = new THREE.Vector2(moveEvent.clientX, moveEvent.clientY).sub(startPointer);
            const heightDelta = delta.dot(up) / up.lengthSq();
            this.onGroundPolylineHeightChange?.(object, Math.max(0, startHeight + heightDelta));
        };
        this.heightDragUp = (): void => this.clearHeightDrag();
        document.addEventListener('pointermove', this.heightDragMove);
        document.addEventListener('pointerup', this.heightDragUp);
    };

    private projectWorldPoint(point: THREE.Vector3): THREE.Vector2 {
        const projected = point.project(this.renderView.camera);
        return new THREE.Vector2(
            ((projected.x + 1) / 2) * this.renderView.width,
            (1 - (projected.y + 1) / 2) * this.renderView.height,
        );
    }

    private startExtend(end: ExtendEnd): void {
        if (!this.getObject()) return;
        this.endExtend();
        this.extendEnd = end;
        this.extendPreview = null;
        this.extendCanvas.style.display = 'block';
        this.extendCanvas.width = this.extendCanvas.clientWidth;
        this.extendCanvas.height = this.extendCanvas.clientHeight;
        const orbit = this.renderView.getAction('orbit-control') as OrbitControlsAction;
        orbit.useDrawingElement(this.extendCanvas);
        this.onExtendHint?.('端点续画：左键添加点，双击或 Esc 结束');
    }

    private endExtend(): void {
        this.clearPendingExtendClick();
        if (!this.extendEnd && this.extendCanvas.style.display === 'none') return;
        this.extendEnd = null;
        this.extendPreview = null;
        this.extendCanvas.style.display = 'none';
        this.clearExtendCanvas();
        const orbit = this.renderView.getAction('orbit-control') as OrbitControlsAction;
        if (orbit) {
            orbit.restoreRenderElement();
        }
    }

    private readonly onExtendClick = (event: MouseEvent): void => {
        if (!this.extendEnd) return;
        event.stopPropagation();
        if (event.detail > 1) return;
        this.clearPendingExtendClick();
        const timer = window.setTimeout(() => {
            if (this.pendingExtendClick?.event === event) {
                this.addExtendPoint(event);
                this.pendingExtendClick = undefined;
            }
        }, 250);
        this.pendingExtendClick = { event, timer };
    };

    private readonly onExtendDoubleClick = (event: MouseEvent): void => {
        if (!this.extendEnd) return;
        event.preventDefault();
        event.stopPropagation();
        this.clearPendingExtendClick();
        this.endExtend();
    };

    private readonly onExtendMouseMove = (event: MouseEvent): void => {
        if (!this.extendEnd) return;
        this.extendPreview = this.canvasEventPoint(event);
        const object = this.getObject();
        if (!object) return;
        const screenPoints = object.points3D.map((point) => {
            const projected = point
                .clone()
                .applyMatrix4(object.matrixWorld)
                .project(this.renderView.camera);
            return {
                x: ((projected.x + 1) / 2) * this.renderView.width,
                y: (1 - (projected.y + 1) / 2) * this.renderView.height,
                visible: true,
            };
        });
        this.drawExtendPreview(object, screenPoints);
    };

    private addExtendPoint(event: MouseEvent): void {
        const object = this.getObject();
        if (!object || !this.extendEnd) return;
        const endpointIndex = this.extendEnd === 'start' ? 0 : object.points3D.length - 1;
        const reference = this.createHeightReference(object, endpointIndex);
        const worldPoint = this.pickPointCloud(event, reference);
        if (!worldPoint) return;
        if (object.parent !== this.renderView.pointCloud.annotate3D) return;
        object.updateMatrixWorld();
        const localPoint = object.worldToLocal(worldPoint);
        const points = object.points3D.map((item) => item.clone());
        if (this.extendEnd === 'start') {
            points.unshift(localPoint);
        } else {
            points.push(localPoint);
        }
        this.onGroundPolylinePointsChange?.(object, points);
    }

    private drawExtendPreview(
        object: GroundPolyline,
        screenPoints: Array<{ x: number; y: number; visible: boolean }>,
    ): void {
        const context = this.extendContext;
        const canvas = this.extendCanvas;
        if (
            canvas.width !== canvas.clientWidth ||
            canvas.height !== canvas.clientHeight
        ) {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        if (!this.extendEnd || !this.extendPreview || screenPoints.length < 2) return;

        const anchor =
            this.extendEnd === 'start' ? screenPoints[0] : screenPoints[screenPoints.length - 1];
        context.beginPath();
        context.strokeStyle = '#fcff4b';
        context.lineWidth = 1;
        context.moveTo(anchor.x, anchor.y);
        context.lineTo(this.extendPreview.x, this.extendPreview.y);
        context.stroke();
        context.fillStyle = '#fcff4b';
        context.fillRect(this.extendPreview.x - 3, this.extendPreview.y - 3, 6, 6);
    }

    private clearExtendCanvas(): void {
        this.extendContext.clearRect(0, 0, this.extendCanvas.width, this.extendCanvas.height);
    }

    private clearPendingExtendClick(): void {
        if (!this.pendingExtendClick) return;
        window.clearTimeout(this.pendingExtendClick.timer);
        this.pendingExtendClick = undefined;
    }

    private canvasEventPoint(event: MouseEvent): THREE.Vector2 {
        const rect = this.extendCanvas.getBoundingClientRect();
        return new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
    }

    private startDrag(event: PointerEvent, index: number): void {
        const object = this.getObject();
        if (!object || index < 0 || index >= object.points3D.length) return;

        event.preventDefault();
        event.stopPropagation();
        this.clearDrag();
        this.handles[index].style.background = '#00e5ff';
        const reference = this.createHeightReference(object, index);
        this.dragMove = (moveEvent: PointerEvent): void => {
            const point = this.pickPointCloud(moveEvent, reference);
            if (!point || object.parent !== this.renderView.pointCloud.annotate3D) return;
            object.updateMatrixWorld();
            const points = object.points3D.map((item) => item.clone());
            points[index].copy(object.worldToLocal(point));
            this.onGroundPolylinePointsChange?.(object, points);
        };
        this.dragUp = (): void => {
            const activeObject = this.getObject();
            if (activeObject && this.handles[index]) {
                this.handles[index].style.background = '#10252a';
            }
            this.clearDrag();
        };
        document.addEventListener('pointermove', this.dragMove);
        document.addEventListener('pointerup', this.dragUp);
    }

    private createHeightReference(
        object: GroundPolyline,
        index: number,
    ): ISnapHeightReference {
        object.updateMatrixWorld();
        const worldZ = (point: THREE.Vector3): number =>
            point.clone().applyMatrix4(object.matrixWorld).z;
        const neighborZs: number[] = [];
        if (index > 0) {
            neighborZs.push(worldZ(object.points3D[index - 1]));
        }
        if (index + 1 < object.points3D.length) {
            neighborZs.push(worldZ(object.points3D[index + 1]));
        }
        return {
            anchorZ: worldZ(object.points3D[index]),
            neighborZs,
        };
    }

    private pickPointCloud(
        event: MouseEvent | PointerEvent,
        reference: ISnapHeightReference,
    ): THREE.Vector3 | null {
        const rect = this.renderView.renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        this.pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.pointer, this.renderView.camera);
        const hits = this.raycaster.intersectObject(
            this.renderView.pointCloud.groupPoints,
            true,
        );
        const hit = selectHeightContinuousHit(hits, reference);
        if (hit?.point) return hit.point.clone();

        // Keep editing possible where the point cloud is sparse or absent: estimate the
        // clicked location on the vertex's current horizontal plane. Point-cloud hits
        // still take priority so normal edits remain snapped to the measured surface.
        this.estimatePlane.set(new THREE.Vector3(0, 0, 1), -reference.anchorZ);
        return this.raycaster.ray.intersectPlane(this.estimatePlane, this.estimatedPoint)?.clone() || null;
    }

    private clearDrag(): void {
        if (this.dragMove) {
            document.removeEventListener('pointermove', this.dragMove);
            this.dragMove = undefined;
        }
        if (this.dragUp) {
            document.removeEventListener('pointerup', this.dragUp);
            this.dragUp = undefined;
        }
    }

    private clearHeightDrag(): void {
        if (this.heightDragMove) {
            document.removeEventListener('pointermove', this.heightDragMove);
            this.heightDragMove = undefined;
        }
        if (this.heightDragUp) {
            document.removeEventListener('pointerup', this.heightDragUp);
            this.heightDragUp = undefined;
        }
    }
}

function distanceToScreenSegment(point: THREE.Vector2, start: THREE.Vector2, end: THREE.Vector2): number {
    const segment = end.clone().sub(start);
    const lengthSquared = segment.lengthSq();
    if (lengthSquared === 0) return point.distanceTo(start);
    const t = Math.max(0, Math.min(1, point.clone().sub(start).dot(segment) / lengthSquared));
    return point.distanceTo(start.addScaledVector(segment, t));
}
