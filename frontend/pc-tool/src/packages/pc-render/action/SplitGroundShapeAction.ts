import * as THREE from 'three';

import { Event } from '../config';
import GroundPolyline from '../objects/GroundPolyline';
import IrregularWall, { WallSide } from '../objects/IrregularWall';
import MainRenderView from '../renderView/MainRenderView';
import Action from './Action';

export interface IGroundShapeSplitPick {
    object: GroundPolyline | IrregularWall;
    objectType: 'GROUND_POLYLINE' | 'IRREGULAR_WALL';
    side?: WallSide;
    segmentIndex: number;
    t: number;
}

interface IHit extends IGroundShapeSplitPick {
    x: number;
    y: number;
    distance: number;
}

const HIT_THRESHOLD_PX = 12;
const MIN_PART_LENGTH_M = 0.01;

/** Picks an arbitrary split position on the selected ground shape in the main view. */
export default class SplitGroundShapeAction extends Action {
    static actionName = 'split-ground-shape';
    renderView: MainRenderView;
    onPick?: (pick: IGroundShapeSplitPick) => void;
    onMiss?: () => void;
    onCancel?: () => void;

    private readonly marker: HTMLDivElement;
    private currentHit?: IHit;

    constructor(renderView: MainRenderView) {
        super();
        this.renderView = renderView;
        this.enabled = false;
        this.marker = document.createElement('div');
        this.marker.style.cssText =
            'position:absolute;width:15px;height:15px;border:2px solid #ff4d4f;' +
            'border-radius:50%;background:rgba(255,77,79,.25);box-sizing:border-box;' +
            'transform:translate(-50%,-50%);pointer-events:none;z-index:8;display:none;';
        this.renderView.container.appendChild(this.marker);
    }

    init(): void {
        this.renderView.container.addEventListener('pointermove', this.handleMove, true);
        this.renderView.container.addEventListener('pointerdown', this.blockPointerDown, true);
        this.renderView.container.addEventListener('click', this.handleClick, true);
        document.addEventListener('keydown', this.handleKeyDown);
        this.renderView.pointCloud.addEventListener(Event.SELECT, this.handleSelectionChange);
    }

    destroy(): void {
        this.renderView.container.removeEventListener('pointermove', this.handleMove, true);
        this.renderView.container.removeEventListener('pointerdown', this.blockPointerDown, true);
        this.renderView.container.removeEventListener('click', this.handleClick, true);
        document.removeEventListener('keydown', this.handleKeyDown);
        this.renderView.pointCloud.removeEventListener(Event.SELECT, this.handleSelectionChange);
        this.marker.remove();
    }

    toggle(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) this.clearHit();
    }

    private getObject(): GroundPolyline | IrregularWall | undefined {
        return this.renderView.pointCloud.selection.find(
            (object) => object instanceof GroundPolyline || object instanceof IrregularWall,
        ) as GroundPolyline | IrregularWall | undefined;
    }

    private readonly blockPointerDown = (event: PointerEvent): void => {
        if (!this.enabled) return;
        event.preventDefault();
        event.stopPropagation();
    };

    private readonly handleMove = (event: PointerEvent): void => {
        if (!this.enabled) return;
        const hit = this.pick(event);
        this.currentHit = hit || undefined;
        if (!hit) {
            this.marker.style.display = 'none';
            return;
        }
        this.marker.style.display = 'block';
        this.marker.style.left = `${hit.x}px`;
        this.marker.style.top = `${hit.y}px`;
    };

    private readonly handleClick = (event: MouseEvent): void => {
        if (!this.enabled) return;
        event.preventDefault();
        event.stopPropagation();
        const hit = this.pick(event) || this.currentHit;
        if (!hit) {
            this.onMiss?.();
            return;
        }
        this.onPick?.({
            object: hit.object,
            objectType: hit.objectType,
            side: hit.side,
            segmentIndex: hit.segmentIndex,
            t: hit.t,
        });
    };

    private readonly handleKeyDown = (event: KeyboardEvent): void => {
        if (!this.enabled || event.key !== 'Escape') return;
        event.preventDefault();
        this.toggle(false);
        this.onCancel?.();
    };

    private readonly handleSelectionChange = (): void => {
        if (!this.enabled) return;
        this.toggle(false);
        this.onCancel?.();
    };

    private pick(event: MouseEvent | PointerEvent): IHit | null {
        const object = this.getObject();
        if (!object) return null;
        const rect = this.renderView.container.getBoundingClientRect();
        const pointer = new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
        object.updateMatrixWorld();
        let best: IHit | null = null;
        const consider = (points: THREE.Vector3[], side?: WallSide): void => {
            const segmentLengths = points.slice(0, -1).map((point, index) =>
                point.distanceTo(points[index + 1]),
            );
            const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0);
            let passedLength = 0;
            for (let index = 0; index < points.length - 1; index++) {
                const start = this.project(points[index], object);
                const end = this.project(points[index + 1], object);
                if (!start.visible || !end.visible) {
                    passedLength += segmentLengths[index];
                    continue;
                }
                const result = closestPoint(pointer, start.point, end.point);
                const splitLength = passedLength + segmentLengths[index] * result.t;
                passedLength += segmentLengths[index];
                if (
                    splitLength < MIN_PART_LENGTH_M ||
                    totalLength - splitLength < MIN_PART_LENGTH_M
                ) {
                    continue;
                }
                if (result.distance > HIT_THRESHOLD_PX || (best && result.distance >= best.distance)) {
                    continue;
                }
                best = {
                    object,
                    objectType:
                        object instanceof GroundPolyline ? 'GROUND_POLYLINE' : 'IRREGULAR_WALL',
                    side,
                    segmentIndex: index,
                    t: result.t,
                    x: result.point.x,
                    y: result.point.y,
                    distance: result.distance,
                };
            }
        };
        if (object instanceof GroundPolyline) {
            consider(object.points3D);
        } else {
            consider(object.bottomPoints, 'bottom');
            consider(object.topPoints, 'top');
        }
        return best;
    }

    private project(
        point: THREE.Vector3,
        object: THREE.Object3D,
    ): { point: THREE.Vector2; visible: boolean } {
        const projected = point.clone().applyMatrix4(object.matrixWorld).project(this.renderView.camera);
        return {
            point: new THREE.Vector2(
                ((projected.x + 1) / 2) * this.renderView.width,
                (1 - (projected.y + 1) / 2) * this.renderView.height,
            ),
            visible:
                projected.z >= -1 &&
                projected.z <= 1 &&
                Math.abs(projected.x) <= 1 &&
                Math.abs(projected.y) <= 1,
        };
    }

    private clearHit(): void {
        this.currentHit = undefined;
        this.marker.style.display = 'none';
    }
}

function closestPoint(
    point: THREE.Vector2,
    start: THREE.Vector2,
    end: THREE.Vector2,
): { point: THREE.Vector2; t: number; distance: number } {
    const segment = end.clone().sub(start);
    const lengthSquared = segment.lengthSq();
    const t =
        lengthSquared <= 1e-8
            ? 0
            : THREE.MathUtils.clamp(point.clone().sub(start).dot(segment) / lengthSquared, 0, 1);
    const projected = start.clone().addScaledVector(segment, t);
    return { point: projected, t, distance: point.distanceTo(projected) };
}
