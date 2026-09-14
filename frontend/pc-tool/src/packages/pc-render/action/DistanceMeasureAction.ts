import * as THREE from 'three';

import { Event } from '../config';
import MainRenderView from '../renderView/MainRenderView';
import SideRenderView from '../renderView/SideRenderView';
import Action from './Action';

const PICK_THRESHOLD_METERS = 0.5;
const CLICK_TOLERANCE_PX = 8;

/**
 * A frame-local, non-annotation two-point distance measurement in the main point-cloud view.
 */
export default class DistanceMeasureAction extends Action {
    static actionName = 'distance-measure';
    onMiss?: () => void;
    private readonly raycaster = new THREE.Raycaster();
    private readonly label: HTMLDivElement;
    private firstPoint?: THREE.Vector3;
    private pointerDown?: THREE.Vector2;

    constructor(private readonly renderView: MainRenderView | SideRenderView) {
        super();
        this.enabled = false;
        this.raycaster.params.Points = { threshold: PICK_THRESHOLD_METERS };
        this.label = document.createElement('div');
        this.label.style.cssText =
            'position:absolute;z-index:9;display:none;pointer-events:none;' +
            'padding:3px 6px;border:1px solid #00e5ff;border-radius:3px;' +
            'background:rgba(0,0,0,.72);color:#00e5ff;font-size:12px;' +
            'font-variant-numeric:tabular-nums;transform:translate(-50%,-50%);';
        this.renderView.container.appendChild(this.label);
    }

    init(): void {
        const container = this.renderView.container;
        container.addEventListener('pointerdown', this.handlePointerDown, true);
        container.addEventListener('pointerup', this.handlePointerUp, true);
        container.addEventListener('click', this.blockClick, true);
        this.renderView.addEventListener(Event.RENDER_AFTER, this.updateLabelPosition);
        this.renderView.pointCloud.addEventListener(
            Event.DISTANCE_MEASURE_CLEAR,
            this.resetState,
        );
    }

    destroy(): void {
        const container = this.renderView.container;
        container.removeEventListener('pointerdown', this.handlePointerDown, true);
        container.removeEventListener('pointerup', this.handlePointerUp, true);
        container.removeEventListener('click', this.blockClick, true);
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.updateLabelPosition);
        this.renderView.pointCloud.removeEventListener(
            Event.DISTANCE_MEASURE_CLEAR,
            this.resetState,
        );
        this.label.remove();
    }

    toggle(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) this.clear();
    }

    clear(): void {
        this.firstPoint = undefined;
        this.pointerDown = undefined;
        this.renderView.pointCloud.clearDistanceMeasure();
    }

    private readonly handlePointerDown = (event: PointerEvent): void => {
        if (!this.enabled || event.button !== 0) return;
        this.pointerDown = new THREE.Vector2(event.clientX, event.clientY);
    };

    private readonly handlePointerUp = (event: PointerEvent): void => {
        if (!this.enabled || event.button !== 0) return;
        const pointerDown = this.pointerDown;
        this.pointerDown = undefined;
        if (!pointerDown || pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > CLICK_TOLERANCE_PX) {
            return;
        }
        const point = this.pickPoint(event);
        if (!point) {
            this.onMiss?.();
            return;
        }
        if (!this.firstPoint) {
            this.firstPoint = point;
            this.drawStart(point);
            return;
        }
        const start = this.firstPoint;
        // A completed measurement is replaced by the next completed pair.
        this.firstPoint = undefined;
        this.drawMeasurement(start, point);
    };

    private readonly blockClick = (event: MouseEvent): void => {
        if (!this.enabled) return;
        event.preventDefault();
        event.stopPropagation();
    };

    private pickPoint(event: PointerEvent): THREE.Vector3 | undefined {
        const rect = this.renderView.container.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera({ x, y }, this.renderView.camera);

        // A side view is an orthographic projection: a ray contains many point-cloud
        // samples at different depths.  Keep the second click on the first point's
        // view-aligned plane so the two endpoints cannot jump between those depths
        // and appear to float when inspected from another view.
        if (this.renderView instanceof SideRenderView && this.firstPoint) {
            const normal = this.renderView.camera.getWorldDirection(new THREE.Vector3());
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
                normal,
                this.firstPoint,
            );
            return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3()) || undefined;
        }
        const hit = this.raycaster.intersectObject(this.renderView.pointCloud.groupPoints, true)[0];
        return hit?.point?.clone();
    }

    private drawStart(point: THREE.Vector3): void {
        const group = this.renderView.pointCloud.groupMeasure;
        this.renderView.pointCloud.clearDistanceMeasure(false);
        delete group.userData.distanceMidpoint;
        delete group.userData.distanceLabel;
        group.add(this.createMarker(point));
        this.label.style.display = 'none';
        this.renderView.pointCloud.render();
    }

    private drawMeasurement(start: THREE.Vector3, end: THREE.Vector3): void {
        const group = this.renderView.pointCloud.groupMeasure;
        this.renderView.pointCloud.clearDistanceMeasure(false);
        group.add(this.createMarker(start), this.createMarker(end));
        const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
        group.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false })));
        group.userData.distanceMidpoint = start.clone().add(end).multiplyScalar(0.5);
        group.userData.distanceLabel = `${start.distanceTo(end).toFixed(2)} m`;
        this.label.textContent = group.userData.distanceLabel;
        this.label.style.display = 'block';
        this.renderView.pointCloud.render();
    }

    private createMarker(point: THREE.Vector3): THREE.Mesh {
        const marker = new THREE.Mesh(
            new THREE.SphereGeometry(0.06, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false }),
        );
        marker.position.copy(point);
        return marker;
    }

    private readonly updateLabelPosition = (): void => {
        const midpoint = this.renderView.pointCloud.groupMeasure.userData.distanceMidpoint as THREE.Vector3 | undefined;
        if (!midpoint) {
            this.label.style.display = 'none';
            return;
        }
        const projected = midpoint.clone().project(this.renderView.camera);
        if (Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || Math.abs(projected.z) > 1) {
            this.label.style.display = 'none';
            return;
        }
        this.label.textContent = String(this.renderView.pointCloud.groupMeasure.userData.distanceLabel || '');
        this.label.style.display = 'block';
        this.label.style.left = `${((projected.x + 1) / 2) * this.renderView.width}px`;
        this.label.style.top = `${((-projected.y + 1) / 2) * this.renderView.height}px`;
    };

    private readonly resetState = (): void => {
        this.firstPoint = undefined;
        this.pointerDown = undefined;
        this.label.style.display = 'none';
        delete this.renderView.pointCloud.groupMeasure.userData.distanceMidpoint;
        delete this.renderView.pointCloud.groupMeasure.userData.distanceLabel;
    };
}
