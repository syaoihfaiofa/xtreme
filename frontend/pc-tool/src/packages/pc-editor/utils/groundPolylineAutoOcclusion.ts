import * as THREE from 'three';
import { Box, Image2DRenderView } from 'pc-render';

import { CAMERA_VIEW_KEYS } from './polylineSegmentVisibility';

const SAMPLE_SPACING_M = 0.4;
const MIN_OCCLUDED_SAMPLES = 2;
const MAX_VISIBLE_GAP_SAMPLES = 2;
const DEPTH_CELL_PX = 6;
const DEPTH_MARGIN_M = 0.35;
const FOOTPRINT_MARGIN_M = 0.3;
/** Persisted only until a newly synced curbwall is opened in its target frame. */
export const AUTO_OCCLUSION_PENDING_KEY = 'autoCurbOcclusionPending';
/** Set after the immediate Box pass; cleared after the target-frame point-cloud pass. */
export const AUTO_OCCLUSION_POINT_CLOUD_PENDING_KEY = 'autoCurbOcclusionPointCloudPending';

// Dataset image suffixes are _1/_2/_3/_4 = front/left/rear/right.  The editor stores
// them zero-based, so visibility keys 0/1/2/3 use that same order.
export const CAMERA_VIEW_DIRECTION_BY_KEY: Readonly<Record<string, string>> = {
    '0': 'front',
    '1': 'left',
    '2': 'rear',
    '3': 'right',
};

export interface IAutoOcclusionResult {
    points: THREE.Vector3[];
    segmentVisibleByView: Record<string, boolean[]>;
    changed: boolean;
}

type DepthBins = Map<string, number>;
type BoxOccluder = { footprint: THREE.Vector2[] };

function getViewKey(view: Image2DRenderView): string {
    if (view.visibilityViewKey) return view.visibilityViewKey;
    const viewId = view.renderId || view.id || view.name;
    const match = String(viewId).match(/[0-9]{1,5}$/);
    return match ? match[0] : '';
}

function cameraOrigin(view: Image2DRenderView): THREE.Vector3 {
    return new THREE.Vector3().setFromMatrixPosition(view.camera.matrixWorld);
}

function isInImage(view: Image2DRenderView, point: THREE.Vector3): boolean {
    return Number.isFinite(point.x) && Number.isFinite(point.y) &&
        point.x >= 0 && point.x <= view.imgSize.x && point.y >= 0 && point.y <= view.imgSize.y;
}

function pointInPolygon(point: THREE.Vector2, polygon: readonly THREE.Vector2[]): boolean {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
        const a = polygon[index];
        const b = polygon[previous];
        const crosses = (a.y > point.y) !== (b.y > point.y) &&
            point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

function cross2D(a: THREE.Vector2, b: THREE.Vector2): number {
    return a.x * b.y - a.y * b.x;
}

function segmentIntersectsSegment2D(
    start: THREE.Vector2,
    end: THREE.Vector2,
    edgeStart: THREE.Vector2,
    edgeEnd: THREE.Vector2,
): boolean {
    const direction = end.clone().sub(start);
    const edgeDirection = edgeEnd.clone().sub(edgeStart);
    const denominator = cross2D(direction, edgeDirection);
    if (Math.abs(denominator) < 0.000001) return false;
    const offset = edgeStart.clone().sub(start);
    const t = cross2D(offset, edgeDirection) / denominator;
    const u = cross2D(offset, direction) / denominator;
    // Do not treat touching the curbwall endpoint as an occluder: the target must be behind it.
    return t >= 0 && t < 0.999 && u >= 0 && u <= 1;
}

function boxGroundFootprint(box: Box): THREE.Vector2[] | null {
    if (!box.visible || !box.geometry.boundingBox) return null;
    box.updateMatrixWorld(true);
    const bounds = box.geometry.boundingBox;
    const minX = bounds.min.x - FOOTPRINT_MARGIN_M;
    const maxX = bounds.max.x + FOOTPRINT_MARGIN_M;
    const minY = bounds.min.y - FOOTPRINT_MARGIN_M;
    const maxY = bounds.max.y + FOOTPRINT_MARGIN_M;
    const groundZ = bounds.min.z;
    return [
        new THREE.Vector3(minX, minY, groundZ),
        new THREE.Vector3(maxX, minY, groundZ),
        new THREE.Vector3(maxX, maxY, groundZ),
        new THREE.Vector3(minX, maxY, groundZ),
    ].map((corner) => {
        corner.applyMatrix4(box.matrixWorld);
        return new THREE.Vector2(corner.x, corner.y);
    });
}

function groundLineHitsBoxBeforeTarget(
    camera: THREE.Vector3,
    target: THREE.Vector3,
    footprint: readonly THREE.Vector2[],
): boolean {
    const start = new THREE.Vector2(camera.x, camera.y);
    const end = new THREE.Vector2(target.x, target.y);
    if (start.distanceToSquared(end) < 0.000001 || pointInPolygon(start, footprint)) return false;
    if (pointInPolygon(end, footprint)) return true;
    return footprint.some((corner, index) =>
        segmentIntersectsSegment2D(start, end, corner, footprint[(index + 1) % footprint.length]),
    );
}

function getPointPositions(group: THREE.Group): Array<{ point: THREE.Vector3; matrixWorld: THREE.Matrix4 }> {
    const result: Array<{ point: THREE.Vector3; matrixWorld: THREE.Matrix4 }> = [];
    group.traverse((object) => {
        if (!(object instanceof THREE.Points)) return;
        const positions = object.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!positions) return;
        // Sampling the full cloud is unnecessary for this conservative fallback and can make
        // finishing a long curb noticeably slow on dense scenes.
        const stride = Math.max(1, Math.ceil(positions.count / 120000));
        for (let index = 0; index < positions.count; index += stride) {
            result.push({
                point: new THREE.Vector3().fromBufferAttribute(positions, index),
                matrixWorld: object.matrixWorld,
            });
        }
    });
    return result;
}

function buildDepthBins(
    views: Image2DRenderView[],
    pointGroup?: THREE.Group,
): Map<string, DepthBins> {
    const binsByView = new Map<string, DepthBins>();
    views.forEach((view) => binsByView.set(getViewKey(view), new Map()));
    if (!pointGroup) return binsByView;
    pointGroup.updateMatrixWorld(true);
    const points = getPointPositions(pointGroup);
    points.forEach(({ point, matrixWorld }) => {
        const world = point.clone().applyMatrix4(matrixWorld);
        views.forEach((view) => {
            const projected = view.worldToImg(world.clone());
            if (!isInImage(view, projected)) return;
            const key = `${Math.floor(projected.x / DEPTH_CELL_PX)}:${Math.floor(projected.y / DEPTH_CELL_PX)}`;
            const depth = world.distanceTo(cameraOrigin(view));
            const bins = binsByView.get(getViewKey(view)) as DepthBins;
            const previous = bins.get(key);
            if (previous === undefined || depth < previous) bins.set(key, depth);
        });
    });
    return binsByView;
}

function isPointCloudBeforeTarget(
    view: Image2DRenderView,
    target: THREE.Vector3,
    bins: DepthBins | undefined,
): boolean {
    if (!bins) return false;
    const projected = view.worldToImg(target.clone());
    if (!isInImage(view, projected)) return false;
    const x = Math.floor(projected.x / DEPTH_CELL_PX);
    const y = Math.floor(projected.y / DEPTH_CELL_PX);
    const targetDepth = target.distanceTo(cameraOrigin(view));
    const depth = bins.get(`${x}:${y}`);
    return depth !== undefined && depth + DEPTH_MARGIN_M < targetDepth;
}

function suppressShortOcclusionRuns(flags: boolean[]): boolean[] {
    const result = flags.slice();
    let start = 0;
    while (start < flags.length) {
        if (!flags[start]) {
            start++;
            continue;
        }
        let end = start + 1;
        while (end < flags.length && flags[end]) end++;
        if (end - start < MIN_OCCLUDED_SAMPLES) result.fill(false, start, end);
        start = end;
    }
    return result;
}

function fillShortVisibleGaps(flags: boolean[]): boolean[] {
    const result = flags.slice();
    let start = 0;
    while (start < flags.length) {
        if (flags[start]) {
            start++;
            continue;
        }
        let end = start + 1;
        while (end < flags.length && !flags[end]) end++;
        if (
            start > 0 &&
            end < flags.length &&
            flags[start - 1] &&
            flags[end] &&
            end - start <= MAX_VISIBLE_GAP_SAMPLES
        ) {
            result.fill(true, start, end);
        }
        start = end;
    }
    return result;
}

/**
 * Produces frame-local visibility flags.  Boxes are the primary evidence; the point-cloud
 * depth grid is deliberately conservative and only fills longer, coherent occlusion runs.
 */
export function computeGroundPolylineAutoOcclusion(
    points: readonly THREE.Vector3[],
    views: readonly Image2DRenderView[],
    boxes: readonly Box[],
    pointGroup?: THREE.Group,
): IAutoOcclusionResult {
    if (points.length < 2 || views.length === 0) {
        return { points: points.map((point) => point.clone()), segmentVisibleByView: {}, changed: false };
    }
    const activeViews = views.filter((view) => CAMERA_VIEW_KEYS.includes(getViewKey(view)));
    activeViews.forEach((view) => view.camera.updateMatrixWorld(true));
    const depthBins = buildDepthBins(activeViews, pointGroup);
    const occluders = boxes.reduce<BoxOccluder[]>((result, box) => {
        const footprint = boxGroundFootprint(box);
        if (footprint) result.push({ footprint });
        return result;
    }, []);
    const byView: Record<string, boolean[]> = Object.fromEntries(
        CAMERA_VIEW_KEYS.map((key) => [key, []]),
    );
    let changed = false;

    for (let segmentIndex = 0; segmentIndex < points.length - 1; segmentIndex++) {
        const start = points[segmentIndex];
        const end = points[segmentIndex + 1];
        const count = Math.max(1, Math.ceil(start.distanceTo(end) / SAMPLE_SPACING_M));
        const states = new Map<string, boolean[]>();
        activeViews.forEach((view) => {
            const origin = cameraOrigin(view);
            const occluded = Array.from({ length: count }, (_, sampleIndex) => {
                const target = start.clone().lerp(end, (sampleIndex + 0.5) / count);
                const projected = view.worldToImg(target.clone());
                if (!isInImage(view, projected)) return false;
                // Occlusion is a ground-plane sight-line test: once the ray from this camera to
                // the curb sample crosses a Box footprint, the sample is behind that Box.  Do
                // not additionally clip it to the 2D Box hull; that made the valid shadow wedge
                // much too short for long curbwall segments.
                return occluders.some(({ footprint }) =>
                    groundLineHitsBoxBeforeTarget(origin, target, footprint),
                ) ||
                    isPointCloudBeforeTarget(view, target, depthBins.get(getViewKey(view)));
            });
            states.set(
                getViewKey(view),
                fillShortVisibleGaps(suppressShortOcclusionRuns(occluded)),
            );
        });
        // Automatic occlusion must never add annotation vertices. A source segment keeps its two
        // user-created endpoints; if any stable sample on it is occluded in a camera, that
        // original segment is marked hidden for that camera.
        CAMERA_VIEW_KEYS.forEach((viewKey) => {
            const occluded = states.get(viewKey)?.some(Boolean) === true;
            byView[viewKey].push(!occluded);
            changed = changed || occluded;
        });
    }
    // A curb corner belongs to two source segments.  Smooth the final, combined flags as well
    // so a one/two-sample visible seam cannot reappear exactly at that shared vertex.
    CAMERA_VIEW_KEYS.forEach((viewKey) => {
        const occluded = byView[viewKey].map((visible) => !visible);
        byView[viewKey] = fillShortVisibleGaps(occluded).map((hidden) => !hidden);
    });
    return {
        points: points.map((point) => point.clone()),
        segmentVisibleByView: byView,
        changed,
    };
}
