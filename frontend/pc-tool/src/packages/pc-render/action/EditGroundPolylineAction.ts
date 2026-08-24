import * as THREE from 'three';

import { Event } from '../config';
import GroundPolyline from '../objects/GroundPolyline';
import MainRenderView from '../renderView/MainRenderView';
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
    onExtendHint?: (message: string) => void;

    private readonly layer: HTMLDivElement;
    private readonly handles: HTMLDivElement[] = [];
    private readonly extendStartHandle: HTMLDivElement;
    private readonly extendEndHandle: HTMLDivElement;
    private readonly extendCanvas: HTMLCanvasElement;
    private readonly extendContext: CanvasRenderingContext2D;
    private readonly raycaster: THREE.Raycaster = new THREE.Raycaster();
    private readonly pointer: THREE.Vector2 = new THREE.Vector2();
    private extendEnd: ExtendEnd | null = null;
    private extendPreview: THREE.Vector2 | null = null;
    private pendingExtendClick?: { event: MouseEvent; timer: number };
    private dragMove?: (event: PointerEvent) => void;
    private dragUp?: () => void;
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
            handle.style.background =
                this.extendEnd === 'start' && index === 0
                    ? '#00e5ff'
                    : this.extendEnd === 'end' && index === object.points3D.length - 1
                      ? '#00e5ff'
                      : '#10252a';
        });
        this.handles.slice(object.points3D.length).forEach((handle) => {
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
    }

    destroy(): void {
        this.endExtend();
        this.clearDrag();
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.updateHandles);
        this.renderView.pointCloud.removeEventListener(Event.SELECT, this.onSelect);
        document.removeEventListener('keydown', this.onKeyDown);
        this.extendCanvas.removeEventListener('click', this.onExtendClick);
        this.extendCanvas.removeEventListener('dblclick', this.onExtendDoubleClick);
        this.extendCanvas.removeEventListener('mousemove', this.onExtendMouseMove);
        this.layer.remove();
        this.extendCanvas.remove();
        this.handles.splice(0);
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

    private onVertexPointerDown(event: PointerEvent, index: number): void {
        const object = this.getObject();
        if (!object || index < 0 || index >= object.points3D.length) return;
        const isEndpoint = index === 0 || index === object.points3D.length - 1;
        if (isEndpoint && (event.altKey || event.detail >= 2)) {
            event.preventDefault();
            event.stopPropagation();
            this.startExtend(index === 0 ? 'start' : 'end');
            return;
        }
        this.startDrag(event, index);
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
        const worldPoint = this.pickPointCloud(event);
        if (!object || !this.extendEnd || !worldPoint) return;
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
        this.dragMove = (moveEvent: PointerEvent): void => {
            const point = this.pickPointCloud(moveEvent);
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

    private pickPointCloud(event: MouseEvent | PointerEvent): THREE.Vector3 | null {
        const rect = this.renderView.renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        this.pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.pointer, this.renderView.camera);
        const hit = this.raycaster.intersectObject(
            this.renderView.pointCloud.groupPoints,
            true,
        )[0];
        return hit?.point ? hit.point.clone() : null;
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
}
