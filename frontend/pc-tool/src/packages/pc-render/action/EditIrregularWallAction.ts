import * as THREE from 'three';
import { Event } from '../config';
import IrregularWall from '../objects/IrregularWall';
import MainRenderView from '../renderView/MainRenderView';
import Action from './Action';

/** Main-view editing controls for the two independent IrregularWall boundaries. */
export default class EditIrregularWallAction extends Action {
    static actionName = 'edit-irregular-wall';
    renderView: MainRenderView;
    onPointsChange?: (object: IrregularWall, side: 'bottom' | 'top', points: THREE.Vector3[], beforePoints: THREE.Vector3[]) => void;
    onSegmentInsert?: (object: IrregularWall, side: 'bottom' | 'top', index: number, point: THREE.Vector3) => void;
    onVertexSelect?: (object: IrregularWall, side: 'bottom' | 'top', index: number) => void;
    getSelectedVertex?: () => { object: IrregularWall; side: 'bottom' | 'top'; index: number } | undefined;
    onExtendHint?: (message: string) => void;
    private readonly layer: HTMLDivElement;
    private readonly vertexHandles: HTMLDivElement[] = [];
    private readonly segmentHandles: HTMLDivElement[] = [];
    private readonly endpointHandles: HTMLDivElement[] = [];
    private readonly raycaster = new THREE.Raycaster();
    private readonly extendCanvas: HTMLCanvasElement;
    private readonly extendContext: CanvasRenderingContext2D;
    private dragMove?: (event: PointerEvent) => void;
    private dragUp?: () => void;
    private shiftMove?: (event: PointerEvent) => void;
    private shiftUp?: () => void;
    private extending?: { side: 'bottom' | 'top'; atStart: boolean };

    constructor(renderView: MainRenderView) {
        super();
        this.renderView = renderView;
        this.layer = document.createElement('div');
        this.layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:4;display:none;';
        renderView.container.appendChild(this.layer);
        this.extendCanvas = document.createElement('canvas');
        this.extendCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;z-index:5;cursor:crosshair;';
        this.extendContext = this.extendCanvas.getContext('2d') as CanvasRenderingContext2D;
        renderView.container.appendChild(this.extendCanvas);
        this.extendCanvas.addEventListener('click', this.extendPoint);
        this.extendCanvas.addEventListener('dblclick', this.endExtend);
        this.extendCanvas.addEventListener('mousemove', this.drawExtendPreview);
        this.raycaster.params.Points = { threshold: 0.5 };
    }
    init(): void { this.renderView.addEventListener(Event.RENDER_AFTER, this.update); this.renderView.renderer.domElement.addEventListener('pointerdown', this.shiftDragStart, true); document.addEventListener('keydown', this.escape); }
    destroy(): void { this.renderView.removeEventListener(Event.RENDER_AFTER, this.update); this.renderView.renderer.domElement.removeEventListener('pointerdown', this.shiftDragStart, true); document.removeEventListener('keydown', this.escape); this.clearDrag(); this.clearShiftDrag(); this.layer.remove(); this.extendCanvas.remove(); }

    private getObject(): IrregularWall | null {
        const object = this.renderView.pointCloud.selection.find((item) => item instanceof IrregularWall && item.parent === this.renderView.pointCloud.annotate3D);
        return object instanceof IrregularWall ? object : null;
    }
    private readonly update = (): void => {
        const object = this.getObject();
        if (!this.isEnable() || !object?.visible) { this.layer.style.display = 'none'; return; }
        this.layer.style.display = 'block';
        const entries = (['bottom', 'top'] as const).flatMap((side) => (side === 'bottom' ? object.bottomPoints : object.topPoints).map((point, index) => ({ side, index, point })));
        const segments = (['bottom', 'top'] as const).flatMap((side) => {
            const points = side === 'bottom' ? object.bottomPoints : object.topPoints;
            return points.slice(0, -1).map((point, index) => ({ side, index, start: point, end: points[index + 1] }));
        });
        this.ensure(this.vertexHandles, entries.length, false);
        this.ensure(this.segmentHandles, segments.length, true);
        this.ensureEndpointHandles();
        const selected = this.getSelectedVertex?.();
        entries.forEach((entry, handleIndex) => {
            const screen = this.project(entry.point);
            const handle = this.vertexHandles[handleIndex];
            handle.dataset.side = entry.side; handle.dataset.index = String(entry.index);
            handle.style.display = screen.visible ? 'block' : 'none';
            handle.style.left = `${screen.x}px`; handle.style.top = `${screen.y}px`;
            const isSelected = selected?.object === object && selected.side === entry.side && selected.index === entry.index;
            handle.style.background = isSelected ? '#ffff00' : '#10252a';
            handle.style.borderColor = isSelected ? '#ffffff' : entry.side === 'bottom' ? '#00e5ff' : '#ff9f1c';
            handle.style.boxShadow = isSelected ? '0 0 0 3px rgba(255, 255, 0, 0.55)' : '';
        });
        segments.forEach((segment, handleIndex) => {
            const a = this.project(segment.start), b = this.project(segment.end), handle = this.segmentHandles[handleIndex];
            handle.dataset.side = segment.side; handle.dataset.index = String(segment.index);
            handle.style.display = a.visible && b.visible && Math.hypot(a.x - b.x, a.y - b.y) >= 36 ? 'block' : 'none';
            handle.style.left = `${(a.x + b.x) / 2}px`; handle.style.top = `${(a.y + b.y) / 2}px`;
        });
        this.vertexHandles.slice(entries.length).forEach((handle) => handle.style.display = 'none');
        this.segmentHandles.slice(segments.length).forEach((handle) => handle.style.display = 'none');
        (['bottom', 'top'] as const).forEach((side, sideIndex) => {
            const points = side === 'bottom' ? object.bottomPoints : object.topPoints;
            if (points.length < 2) {
                this.endpointHandles[sideIndex * 2].style.display = 'none';
                this.endpointHandles[sideIndex * 2 + 1].style.display = 'none';
                return;
            }
            [true, false].forEach((atStart, endIndex) => {
                const pointIndex = atStart ? 0 : points.length - 1;
                const neighborIndex = atStart ? 1 : points.length - 2;
                const point = this.project(points[pointIndex]); const neighbor = this.project(points[neighborIndex]);
                const handle = this.endpointHandles[sideIndex * 2 + endIndex];
                const direction = new THREE.Vector2(point.x - neighbor.x, point.y - neighbor.y).normalize();
                handle.dataset.side = side; handle.dataset.atStart = atStart ? '1' : '0';
                handle.style.display = point.visible && neighbor.visible && !this.extending ? 'block' : 'none';
                handle.style.left = `${point.x + direction.x * 15}px`; handle.style.top = `${point.y + direction.y * 15}px`;
            });
        });
    };
    private ensure(handles: HTMLDivElement[], count: number, segment: boolean): void {
        while (handles.length < count) {
            const handle = document.createElement('div');
            handle.style.cssText = segment
                ? 'position:absolute;width:14px;height:14px;border:2px solid #7cff7c;border-radius:50%;background:#16301a;color:#7cff7c;font-size:12px;line-height:10px;text-align:center;box-sizing:border-box;transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;font-weight:bold;'
                : 'position:absolute;width:11px;height:11px;border:2px solid #00e5ff;border-radius:50%;background:#10252a;box-sizing:border-box;transform:translate(-50%,-50%);pointer-events:auto;cursor:grab;';
            if (segment) { handle.textContent = '+'; handle.addEventListener('pointerdown', (event) => this.insert(event, handle)); }
            else handle.addEventListener('pointerdown', (event) => this.drag(event, handle));
            this.layer.appendChild(handle); handles.push(handle);
        }
    }
    private ensureEndpointHandles(): void {
        while (this.endpointHandles.length < 4) {
            const handle = document.createElement('div');
            handle.textContent = '+'; handle.title = 'Extend from this endpoint';
            handle.style.cssText = 'position:absolute;width:16px;height:16px;border:2px solid #7cff7c;border-radius:50%;background:#16301a;color:#7cff7c;font-size:13px;line-height:12px;text-align:center;box-sizing:border-box;transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;font-weight:bold;';
            handle.addEventListener('pointerdown', (event) => { event.preventDefault(); event.stopPropagation(); this.extending = { side: handle.dataset.side as 'bottom' | 'top', atStart: handle.dataset.atStart === '1' }; this.extendCanvas.style.display = 'block'; this.onExtendHint?.('端点续画：左键连续添加点，双击或 Esc 结束'); this.renderView.pointCloud.render(); });
            this.layer.appendChild(handle); this.endpointHandles.push(handle);
        }
    }
    private readonly extendPoint = (event: MouseEvent): void => {
        if (!this.extending) return;
        const object = this.getObject(); if (!object) return;
        event.preventDefault(); event.stopPropagation();
        const { side, atStart } = this.extending; const before = (side === 'bottom' ? object.bottomPoints : object.topPoints).map((point) => point.clone());
        const point = this.pick(event, (atStart ? before[0] : before.at(-1)!).z); if (!point) return;
        const next = before.map((item) => item.clone()); if (atStart) next.unshift(point); else next.push(point);
        object.setSidePoints(side, next); this.notifyPointsChanged(object); this.onPointsChange?.(object, side, next, before); this.renderView.pointCloud.render();
    };
    private readonly endExtend = (event?: MouseEvent): void => { event?.preventDefault(); this.extending = undefined; this.extendCanvas.style.display = 'none'; this.extendContext.clearRect(0, 0, this.extendCanvas.width, this.extendCanvas.height); this.renderView.pointCloud.render(); };
    private readonly escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') this.endExtend(); };
    private readonly shiftDragStart = (event: PointerEvent): void => {
        if (!event.shiftKey || this.extending) return;
        const object = this.getObject();
        if (!object) return;
        const rect = this.renderView.renderer.domElement.getBoundingClientRect();
        const pointer = new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
        const nearBottom = object.bottomPoints.slice(0, -1).some((point, index) => {
            const a = this.project(point), b = this.project(object.bottomPoints[index + 1]);
            return this.distanceToSegment(pointer, new THREE.Vector2(a.x, a.y), new THREE.Vector2(b.x, b.y)) < 12;
        });
        if (!nearBottom) return;
        event.preventDefault(); event.stopPropagation(); this.clearShiftDrag();
        const bottom = object.bottomPoints.map((point) => point.clone());
        const beforeTop = object.topPoints.map((point) => point.clone());
        const baseHeight = beforeTop.length > 0 ? beforeTop[0].z - bottom[0].z : 0;
        let changed = false;
        this.shiftMove = (moveEvent: PointerEvent) => {
            const height = Math.max(0, baseHeight + (event.clientY - moveEvent.clientY) * 0.02);
            object.setSidePoints('top', bottom.map((point) => point.clone().add(new THREE.Vector3(0, 0, height))));
            changed = true;
            this.notifyPointsChanged(object);
            this.renderView.pointCloud.render();
        };
        this.shiftUp = () => {
            if (changed) this.onPointsChange?.(object, 'top', object.topPoints.map((point) => point.clone()), beforeTop);
            this.clearShiftDrag();
        };
        document.addEventListener('pointermove', this.shiftMove); document.addEventListener('pointerup', this.shiftUp);
    };
    private readonly drawExtendPreview = (event: MouseEvent): void => {
        const object = this.getObject(); if (!object || !this.extending) return;
        if (this.extendCanvas.width !== this.extendCanvas.clientWidth || this.extendCanvas.height !== this.extendCanvas.clientHeight) { this.extendCanvas.width = this.extendCanvas.clientWidth; this.extendCanvas.height = this.extendCanvas.clientHeight; }
        const points = this.extending.side === 'bottom' ? object.bottomPoints : object.topPoints;
        const anchor = this.project(this.extending.atStart ? points[0] : points.at(-1)!);
        const rect = this.extendCanvas.getBoundingClientRect(); const x = event.clientX - rect.left, y = event.clientY - rect.top;
        this.extendContext.clearRect(0, 0, this.extendCanvas.width, this.extendCanvas.height); this.extendContext.strokeStyle = '#fcff4b'; this.extendContext.lineWidth = 1; this.extendContext.beginPath(); this.extendContext.moveTo(anchor.x, anchor.y); this.extendContext.lineTo(x, y); this.extendContext.stroke();
    };
    private drag(event: PointerEvent, handle: HTMLDivElement): void {
        const object = this.getObject(), side = handle.dataset.side as 'bottom' | 'top', index = Number(handle.dataset.index);
        if (!object || !side || !Number.isInteger(index)) return;
        event.preventDefault(); event.stopPropagation();
        this.onVertexSelect?.(object, side, index);
        this.clearDrag();
        const before = (side === 'bottom' ? object.bottomPoints : object.topPoints).map((point) => point.clone());
        let latest = before.map((point) => point.clone());
        let changed = false;
        this.dragMove = (moveEvent) => {
            // Existing wall vertices are moved in XY from the main cloud. Their
            // height is adjusted in a side view, avoiding accidental Z snapping.
            const point = this.pick(moveEvent, before[index].z, true); if (!point) return;
            latest = before.map((item) => item.clone()); latest[index].copy(point); changed = true;
            object.setSidePoints(side, latest); this.notifyPointsChanged(object); this.renderView.pointCloud.render();
        };
        this.dragUp = () => { if (changed) this.onPointsChange?.(object, side, latest, before); this.clearDrag(); };
        document.addEventListener('pointermove', this.dragMove); document.addEventListener('pointerup', this.dragUp);
    }

    private notifyPointsChanged(object: IrregularWall): void {
        // Side views only refit when the selected object's geometry changes.
        // Point edits happen in-place, so announce them through the same event
        // used by the other editable 3D annotation controls.
        this.renderView.pointCloud.dispatchEvent({
            type: Event.OBJECT_TRANSFORM,
            data: { object, option: { pointsChanged: true } },
        });
    }

    private insert(event: PointerEvent, handle: HTMLDivElement): void {
        const object = this.getObject(), side = handle.dataset.side as 'bottom' | 'top', index = Number(handle.dataset.index);
        const points = side === 'bottom' ? object?.bottomPoints : object?.topPoints;
        if (!object || !points || !Number.isInteger(index) || index < 0 || index >= points.length - 1) return;
        event.preventDefault(); event.stopPropagation();
        this.onSegmentInsert?.(object, side, index, points[index].clone().lerp(points[index + 1], 0.5));
    }
    private pick(event: MouseEvent | PointerEvent, fallbackZ: number, lockHeight = false): THREE.Vector3 | null {
        const rect = this.renderView.renderer.domElement.getBoundingClientRect();
        this.raycaster.setFromCamera({ x: ((event.clientX - rect.left) / rect.width) * 2 - 1, y: -((event.clientY - rect.top) / rect.height) * 2 + 1 }, this.renderView.camera);
        if (!lockHeight) {
            const hit = this.raycaster.intersectObject(this.renderView.pointCloud.groupPoints, true)[0];
            if (hit?.point) return hit.point.clone();
        }
        return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -fallbackZ), new THREE.Vector3()) || null;
    }
    private project(point: THREE.Vector3) { const p = point.clone().project(this.renderView.camera); return { x: ((p.x + 1) / 2) * this.renderView.width, y: (1 - (p.y + 1) / 2) * this.renderView.height, visible: p.z >= -1 && p.z <= 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 }; }
    private distanceToSegment(point: THREE.Vector2, start: THREE.Vector2, end: THREE.Vector2): number { const delta = end.clone().sub(start); const length = delta.lengthSq(); const ratio = length <= 1e-8 ? 0 : THREE.MathUtils.clamp(point.clone().sub(start).dot(delta) / length, 0, 1); return point.distanceTo(start.addScaledVector(delta, ratio)); }
    private clearDrag() { if (this.dragMove) document.removeEventListener('pointermove', this.dragMove); if (this.dragUp) document.removeEventListener('pointerup', this.dragUp); this.dragMove = undefined; this.dragUp = undefined; }
    private clearShiftDrag() { if (this.shiftMove) document.removeEventListener('pointermove', this.shiftMove); if (this.shiftUp) document.removeEventListener('pointerup', this.shiftUp); this.shiftMove = undefined; this.shiftUp = undefined; }
}
