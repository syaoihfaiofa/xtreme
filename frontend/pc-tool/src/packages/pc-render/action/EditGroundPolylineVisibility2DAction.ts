import * as THREE from 'three';

import Image2DRenderView from '../renderView/Image2DRenderView';
import Action from './Action';
import GroundPolyline from '../objects/GroundPolyline';
import ProjectedPolyline from '../objects/projectedPolyline';

const SEGMENT_HIT_THRESHOLD_PX = 18;
const FISHEYE_SEGMENT_SAMPLES = 8;

export interface IPickedPolylinePoint {
    polyline: GroundPolyline;
    segmentIndex: number;
    t: number;
    imagePoint: THREE.Vector2;
}

interface IProjectedPolylineSegment {
    segmentIndex: number;
    points: THREE.Vector2[];
}

function closestHitOnPolylineSegments(
    segments: IProjectedPolylineSegment[],
    imagePoint: THREE.Vector2,
    thresholdPx: number,
): { segmentIndex: number; t: number; distance: number; projection: THREE.Vector2 } | null {
    let best: {
        segmentIndex: number;
        t: number;
        distance: number;
        projection: THREE.Vector2;
    } | null = null;
    segments.forEach(({ segmentIndex, points }) => {
        for (let index = 0; index < points.length - 1; index++) {
            const start = points[index];
            const end = points[index + 1];
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const lengthSquared = dx * dx + dy * dy;
            const sampleT =
                lengthSquared <= 1e-8
                    ? 0
                    : Math.max(
                          0,
                          Math.min(
                              1,
                              ((imagePoint.x - start.x) * dx +
                                  (imagePoint.y - start.y) * dy) /
                                  lengthSquared,
                          ),
                      );
            const projection = new THREE.Vector2(
                start.x + sampleT * dx,
                start.y + sampleT * dy,
            );
            const distance = imagePoint.distanceTo(projection);
            if (distance <= thresholdPx && (!best || distance < best.distance)) {
                best = {
                    segmentIndex,
                    t: (index + sampleT) / (points.length - 1),
                    distance,
                    projection,
                };
            }
        }
    });
    return best;
}

function projectPolylineToImageSegments(
    points3D: THREE.Vector3[],
    view: Image2DRenderView,
    endpointOverrides?: THREE.Vector2[],
): IProjectedPolylineSegment[] {
    return points3D.slice(0, -1).map((start, segmentIndex) => {
        const end = points3D[segmentIndex + 1];
        const sampleCount = view.isFisheye() ? FISHEYE_SEGMENT_SAMPLES : 1;
        const points = Array.from({ length: sampleCount + 1 }, (_, sampleIndex) => {
            const projected = view.worldToImg(
                start.clone().lerp(end, sampleIndex / sampleCount),
            );
            return new THREE.Vector2(projected.x, projected.y);
        });
        if (endpointOverrides?.[segmentIndex] && endpointOverrides[segmentIndex + 1]) {
            points[0] = endpointOverrides[segmentIndex].clone();
            points[points.length - 1] = endpointOverrides[segmentIndex + 1].clone();
        }
        return { segmentIndex, points };
    });
}

export default class EditGroundPolylineVisibility2DAction extends Action {
    static actionName: string = 'edit-ground-polyline-visibility-2d';
    renderView: Image2DRenderView;
    pendingImagePoint: THREE.Vector2 | null = null;
    isEditEnabled?: () => boolean;
    onFirstPoint?: (picked: IPickedPolylinePoint) => void;
    onRangePicked?: (first: IPickedPolylinePoint, second: IPickedPolylinePoint) => void;
    onMiss?: () => void;
    private pending: IPickedPolylinePoint | null = null;
    private marker: HTMLDivElement | null = null;
    private eventTarget: HTMLElement | null = null;

    readonly handlePointerDown = (event: PointerEvent): void => {
        const isPickButton = event.button === 0 || event.button === 2;
        if (
            !this.isEventInsideView(event) ||
            !this.isEditEnabled?.() ||
            !isPickButton ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
        ) {
            return;
        }
        if (event.button === 2) {
            event.stopPropagation();
            event.preventDefault();
        }
        const picked = this.pickPointOnPolyline(event);
        if (!picked) {
            this.onMiss?.();
            return;
        }
        event.stopPropagation();
        event.preventDefault();
        if (!this.pending || this.pending.polyline !== picked.polyline) {
            this.pending = picked;
            this.pendingImagePoint = picked.imagePoint.clone();
            this.showMarker(picked.imagePoint);
            this.renderView.render();
            this.onFirstPoint?.(picked);
            return;
        }
        const first = this.pending;
        this.clearPending();
        this.renderView.render();
        this.onRangePicked?.(first, picked);
    };

    private readonly handleContextMenu = (event: MouseEvent): void => {
        if (!this.isEditEnabled?.() || !this.isEventInsideView(event)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    };

    constructor(renderView: Image2DRenderView) {
        super();
        this.renderView = renderView;
        this.enabled = true;
    }

    init(): void {
        this.marker = document.createElement('div');
        this.marker.style.cssText =
            'position:absolute;width:14px;height:14px;border-radius:50%;' +
            'background:#ffcc00;border:2px solid #10252a;box-sizing:border-box;' +
            'transform:translate(-50%,-50%);pointer-events:none;z-index:20;display:none;';
        this.renderView.container.appendChild(this.marker);
        this.eventTarget = this.renderView.container.parentElement || this.renderView.container;
        this.eventTarget.addEventListener('pointerdown', this.handlePointerDown, true);
        window.addEventListener('contextmenu', this.handleContextMenu, true);
    }

    destroy(): void {
        this.eventTarget?.removeEventListener('pointerdown', this.handlePointerDown, true);
        this.eventTarget = null;
        window.removeEventListener('contextmenu', this.handleContextMenu, true);
        this.marker?.remove();
        this.marker = null;
        this.clearPending();
    }

    clearPending(): void {
        this.pending = null;
        this.pendingImagePoint = null;
        if (this.marker) {
            this.marker.style.display = 'none';
        }
    }

    private showMarker(imagePoint: THREE.Vector2): void {
        if (!this.marker) {
            return;
        }
        const domPoint = imagePoint.clone();
        this.renderView.imgToDom(domPoint);
        this.marker.style.left = `${domPoint.x}px`;
        this.marker.style.top = `${domPoint.y}px`;
        this.marker.style.display = 'block';
    }

    private isEventInsideView(event: MouseEvent | PointerEvent): boolean {
        const rect = this.renderView.container.getBoundingClientRect();
        return (
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom
        );
    }

    private pickPointOnPolyline(event: PointerEvent): IPickedPolylinePoint | null {
        const candidates = this.renderView.pointCloud
            .getAnnotate3D()
            .filter((object) => object instanceof GroundPolyline) as GroundPolyline[];
        if (candidates.length === 0) {
            return null;
        }
        const imagePoint = this.getImagePoint(event);
        const threshold = SEGMENT_HIT_THRESHOLD_PX / Math.max(this.renderView.getScale(), 0.0001);
        const projectedBySource = this.getProjectedPolylineBySource(candidates);
        let best: (IPickedPolylinePoint & { distance: number }) | null = null;
        candidates.forEach((polyline) => {
            const projected = projectedBySource.get(polyline);
            const segments =
                this.renderView.isFisheye() || !projected
                    ? projectPolylineToImageSegments(
                          polyline.points3D,
                          this.renderView,
                          projected,
                      )
                    : projected.slice(0, -1).map((point, segmentIndex) => ({
                          segmentIndex,
                          points: [point, projected[segmentIndex + 1]],
                      }));
            const hit = closestHitOnPolylineSegments(segments, imagePoint, threshold);
            if (!hit) {
                return;
            }
            if (!best || hit.distance < best.distance) {
                best = {
                    polyline,
                    segmentIndex: hit.segmentIndex,
                    t: hit.t,
                    imagePoint: hit.projection,
                    distance: hit.distance,
                };
            }
        });
        return best;
    }

    private getImagePoint(event: PointerEvent): THREE.Vector2 {
        const rect = this.renderView.container.getBoundingClientRect();
        return this.renderView.domToImg(
            new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top),
        );
    }

    private getProjectedPolylineBySource(
        sources: GroundPolyline[],
    ): Map<GroundPolyline, THREE.Vector2[]> {
        const result = new Map<GroundPolyline, THREE.Vector2[]>();
        const projections = this.renderView
            .get2DObject()
            .filter(
                (object): object is ProjectedPolyline =>
                    object instanceof ProjectedPolyline && this.renderView.isRenderable(object),
            );
        projections.forEach((projection) => {
            const sourceId = projection.userData?.projectedFromId;
            const trackId = projection.userData?.trackId;
            const source = sources.find(
                (candidate) =>
                    candidate.uuid === sourceId ||
                    (trackId && candidate.userData?.trackId === trackId),
            );
            if (source) {
                result.set(source, projection.points);
            }
        });
        return result;
    }
}
