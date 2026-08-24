import * as THREE from 'three';

import { Event } from '../config';
import GroundPolyline from '../objects/GroundPolyline';
import MainRenderView from '../renderView/MainRenderView';
import Action from './Action';

const SNAP_THRESHOLD_METERS = 0.5;

export default class EditGroundPolylineAction extends Action {
    static actionName: string = 'edit-ground-polyline';
    renderView: MainRenderView;
    onGroundPolylinePointsChange?: (
        object: GroundPolyline,
        points: THREE.Vector3[],
    ) => void;

    private readonly layer: HTMLDivElement;
    private readonly handles: HTMLDivElement[] = [];
    private readonly raycaster: THREE.Raycaster = new THREE.Raycaster();
    private readonly pointer: THREE.Vector2 = new THREE.Vector2();
    private dragMove?: (event: PointerEvent) => void;
    private dragUp?: () => void;
    private readonly updateHandles = (): void => {
        const object = this.getObject();
        if (!this.isEnable() || !object || !object.visible) {
            this.layer.style.display = 'none';
            return;
        }

        this.ensureHandles(object.points3D.length);
        this.layer.style.display = 'block';
        object.updateMatrixWorld();
        object.points3D.forEach((point, index) => {
            const projected = point
                .clone()
                .applyMatrix4(object.matrixWorld)
                .project(this.renderView.camera);
            const handle = this.handles[index];
            const visible =
                projected.z >= -1 &&
                projected.z <= 1 &&
                Math.abs(projected.x) <= 1 &&
                Math.abs(projected.y) <= 1;
            handle.style.display = visible ? 'block' : 'none';
            handle.style.left = `${((projected.x + 1) / 2) * this.renderView.width}px`;
            handle.style.top = `${(1 - (projected.y + 1) / 2) * this.renderView.height}px`;
        });
        this.handles.slice(object.points3D.length).forEach((handle) => {
            handle.style.display = 'none';
        });
    };

    constructor(renderView: MainRenderView) {
        super();
        this.renderView = renderView;
        this.layer = document.createElement('div');
        this.layer.style.cssText =
            'position:absolute;inset:0;pointer-events:none;z-index:4;display:none;';
        this.renderView.container.appendChild(this.layer);
        this.raycaster.params.Points = { threshold: SNAP_THRESHOLD_METERS };
    }

    init(): void {
        this.renderView.addEventListener(Event.RENDER_AFTER, this.updateHandles);
    }

    destroy(): void {
        this.clearDrag();
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.updateHandles);
        this.layer.remove();
        this.handles.splice(0);
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
                this.startDrag(event, Number(handle.dataset.index));
            });
            this.layer.appendChild(handle);
            this.handles.push(handle);
        }
        this.handles.forEach((handle, index) => {
            handle.dataset.index = String(index);
        });
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
            this.handles[index].style.background = '#10252a';
            this.clearDrag();
        };
        document.addEventListener('pointermove', this.dragMove);
        document.addEventListener('pointerup', this.dragUp);
    }

    private pickPointCloud(event: PointerEvent): THREE.Vector3 | null {
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
