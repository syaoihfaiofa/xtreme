import * as THREE from 'three';
import { Event } from '../config';
import GroundPolygon from '../objects/GroundPolygon';
import MainRenderView from '../renderView/MainRenderView';
import Action from './Action';

/** Vertex handles for P (parking-slot) annotations in the main point-cloud view. */
export default class EditGroundPolygonAction extends Action {
    static actionName = 'edit-ground-polygon';
    renderView: MainRenderView;
    onGroundPolygonPointsChange?: (object: GroundPolygon, points: THREE.Vector3[]) => void;
    onGroundPolygonVertexSelect?: (object: GroundPolygon, index: number) => void;
    getSelectedGroundPolygonVertex?: () => { object: GroundPolygon; index: number } | undefined;
    private readonly layer: HTMLDivElement;
    private readonly handles: HTMLDivElement[] = [];
    private readonly raycaster = new THREE.Raycaster();
    private dragMove?: (event: PointerEvent) => void;
    private dragUp?: () => void;

    constructor(renderView: MainRenderView) {
        super();
        this.renderView = renderView;
        this.layer = document.createElement('div');
        this.layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:4;display:none;';
        renderView.container.appendChild(this.layer);
        this.raycaster.params.Points = { threshold: 0.5 };
    }

    init(): void {
        this.renderView.addEventListener(Event.RENDER_AFTER, this.updateHandles);
    }

    destroy(): void {
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.updateHandles);
        this.clearDrag();
        this.layer.remove();
    }

    private getObject(): GroundPolygon | null {
        const object = this.renderView.pointCloud.selection.find(
            (candidate) =>
                candidate instanceof GroundPolygon &&
                candidate.parent === this.renderView.pointCloud.annotate3D,
        );
        return object instanceof GroundPolygon ? object : null;
    }

    private readonly updateHandles = (): void => {
        const object = this.getObject();
        if (!this.isEnable() || !object?.visible) {
            this.layer.style.display = 'none';
            return;
        }
        this.layer.style.display = 'block';
        object.updateMatrixWorld();
        const selectedVertex = this.getSelectedGroundPolygonVertex?.();
        object.points3D.forEach((point, index) => {
            const handle = this.getHandle(index);
            const projected = point.clone().applyMatrix4(object.matrixWorld).project(this.renderView.camera);
            const visible =
                projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
            handle.style.display = visible ? 'block' : 'none';
            handle.style.left = `${((projected.x + 1) / 2) * this.renderView.width}px`;
            handle.style.top = `${(1 - (projected.y + 1) / 2) * this.renderView.height}px`;
            const selected = selectedVertex?.object === object && selectedVertex.index === index;
            handle.style.background = selected ? '#ffff00' : '#10252a';
            handle.style.borderColor = selected ? '#ffffff' : '#00e5ff';
            handle.style.boxShadow = selected ? '0 0 0 3px rgba(255, 255, 0, 0.55)' : '';
        });
    };

    private getHandle(index: number): HTMLDivElement {
        while (this.handles.length <= index) {
            const handle = document.createElement('div');
            handle.style.cssText =
                'position:absolute;width:11px;height:11px;border:2px solid #00e5ff;border-radius:50%;' +
                'background:#10252a;box-sizing:border-box;transform:translate(-50%,-50%);' +
                'pointer-events:auto;cursor:grab;';
            handle.addEventListener('pointerdown', (event) => this.startDrag(event, Number(handle.dataset.index)));
            this.layer.appendChild(handle);
            this.handles.push(handle);
        }
        const handle = this.handles[index];
        handle.dataset.index = String(index);
        return handle;
    }

    private startDrag(event: PointerEvent, index: number): void {
        const object = this.getObject();
        if (!object || index < 0 || index >= object.points3D.length) return;
        event.preventDefault();
        event.stopPropagation();
        this.onGroundPolygonVertexSelect?.(object, index);
        this.clearDrag();
        const startPoints = object.points3D.map((point) => point.clone());
        const fallbackZ = startPoints[index].clone().applyMatrix4(object.matrixWorld).z;
        this.dragMove = (moveEvent: PointerEvent): void => {
            const worldPoint = this.pickPoint(moveEvent, fallbackZ);
            if (!worldPoint || object.parent !== this.renderView.pointCloud.annotate3D) return;
            object.updateMatrixWorld();
            const points = startPoints.map((point) => point.clone());
            points[index].copy(object.worldToLocal(worldPoint));
            if (GroundPolygon.isValidPoints(points)) {
                this.onGroundPolygonPointsChange?.(object, points);
            }
        };
        this.dragUp = () => this.clearDrag();
        document.addEventListener('pointermove', this.dragMove);
        document.addEventListener('pointerup', this.dragUp);
    }

    private pickPoint(event: PointerEvent, fallbackZ: number): THREE.Vector3 | null {
        const rect = this.renderView.renderer.domElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        this.raycaster.setFromCamera(
            {
                x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
                y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
            },
            this.renderView.camera,
        );
        // P is a ground footprint. In the perspective main cloud a ray can hit a
        // car, wall, or another elevated point before reaching the ground, which
        // makes the vertex Z jump unexpectedly. Keep its initial Z here; height
        // remains deliberately editable from the side views.
        return this.raycaster.ray.intersectPlane(
            new THREE.Plane(new THREE.Vector3(0, 0, 1), -fallbackZ),
            new THREE.Vector3(),
        );
    }

    private clearDrag(): void {
        if (this.dragMove) document.removeEventListener('pointermove', this.dragMove);
        if (this.dragUp) document.removeEventListener('pointerup', this.dragUp);
        this.dragMove = undefined;
        this.dragUp = undefined;
    }
}
