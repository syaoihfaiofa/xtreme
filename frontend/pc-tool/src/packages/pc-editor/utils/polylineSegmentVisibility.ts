import * as THREE from 'three';

import type Image2DRenderView from '../../pc-render/renderView/Image2DRenderView';
import {
    getRelevantViewKeysForSegment,
    isSegmentProjectedInView as isSegmentRelevantInCameraViews,
} from '../../pc-render/utils/polylineProjection';

export interface ISegmentVisibilityEntry {
    index: number;
    visible: boolean;
}

export type SegmentVisibilityByView = Record<string, ISegmentVisibilityEntry[]>;

export const CAMERA_VIEW_KEYS: readonly string[] = ['0', '1', '2', '3'];

const SEGMENT_VISIBILITY_SAMPLES = 33;

export function isCameraViewKey(viewKey: string): boolean {
    return CAMERA_VIEW_KEYS.includes(viewKey);
}

export function getViewKeyFromImageView(view: Image2DRenderView): string {
    if (view.visibilityViewKey) {
        return view.visibilityViewKey;
    }
    const viewId = view.renderId || view.id;
    const match = viewId.match(/[0-9]{1,5}$/);
    return match ? match[0] : viewId;
}

export function createDefaultSegmentVisible(pointCount: number): boolean[] {
    const segmentCount = Math.max(0, pointCount - 1);
    return Array.from({ length: segmentCount }, () => true);
}

export function normalizeSegmentVisible(flags: boolean[] | undefined, pointCount: number): boolean[] {
    const segmentCount = Math.max(0, pointCount - 1);
    const normalized = createDefaultSegmentVisible(pointCount);
    if (!flags) {
        return normalized;
    }
    for (let index = 0; index < segmentCount; index++) {
        if (typeof flags[index] === 'boolean') {
            normalized[index] = flags[index];
        }
    }
    return normalized;
}

export function segmentVisibleToExport(flags: boolean[]): ISegmentVisibilityEntry[] {
    return flags.map((visible, index) => ({ index, visible }));
}

export function segmentVisibleFromImport(
    items: ISegmentVisibilityEntry[] | undefined,
    pointCount: number,
): boolean[] {
    const flags = createDefaultSegmentVisible(pointCount);
    if (!Array.isArray(items)) {
        return flags;
    }
    items.forEach((item) => {
        if (!Number.isInteger(item.index) || item.index < 0 || item.index >= flags.length) {
            return;
        }
        flags[item.index] = item.visible !== false;
    });
    return flags;
}

export function segmentVisibilityByViewFromImport(
    raw: SegmentVisibilityByView | undefined,
    pointCount: number,
): Record<string, boolean[]> {
    const byView: Record<string, boolean[]> = {};
    if (!raw || typeof raw !== 'object') {
        return byView;
    }
    Object.entries(raw).forEach(([viewKey, entries]) => {
        if (viewKey === 'bev' || !isCameraViewKey(viewKey)) {
            return;
        }
        byView[viewKey] = segmentVisibleFromImport(entries, pointCount);
    });
    return byView;
}

export function segmentVisibilityByViewToExport(
    byView: Record<string, boolean[]>,
): SegmentVisibilityByView {
    const exported: SegmentVisibilityByView = {};
    Object.entries(byView).forEach(([viewKey, flags]) => {
        if (!isCameraViewKey(viewKey)) {
            return;
        }
        exported[viewKey] = segmentVisibleToExport(flags);
    });
    return exported;
}

export function remapAfterInsert(flags: boolean[], insertIndex: number): boolean[] {
    if (insertIndex <= 0) {
        const inherited = flags[0] ?? true;
        return [inherited, ...flags];
    }
    if (insertIndex >= flags.length) {
        const inherited = flags[flags.length - 1] ?? true;
        return [...flags, inherited];
    }
    const inherited = flags[insertIndex - 1] ?? true;
    const next = [...flags];
    next.splice(insertIndex, 0, inherited);
    return next;
}

export function remapAfterRemove(flags: boolean[], removeIndex: number): boolean[] {
    if (flags.length === 0) {
        return flags;
    }
    if (removeIndex <= 0) {
        return flags.slice(1);
    }
    if (removeIndex >= flags.length) {
        return flags.slice(0, -1);
    }
    const mergedVisible = (flags[removeIndex - 1] ?? true) && (flags[removeIndex] ?? true);
    const next = [...flags];
    next.splice(removeIndex - 1, 2, mergedVisible);
    return next;
}

export function padNewSegments(
    flags: boolean[],
    oldPointCount: number,
    newPointCount: number,
    defaultVisible: boolean,
): boolean[] {
    const next = normalizeSegmentVisible(flags, oldPointCount);
    const targetCount = Math.max(0, newPointCount - 1);
    while (next.length < targetCount) {
        next.push(defaultVisible);
    }
    return next;
}

export function padAllViewsForPointCountChange(
    byView: Record<string, boolean[]>,
    oldPointCount: number,
    newPointCount: number,
    defaultVisible: boolean,
): Record<string, boolean[]> {
    const next: Record<string, boolean[]> = { ...byView };
    CAMERA_VIEW_KEYS.forEach((viewKey) => {
        next[viewKey] = padNewSegments(
            next[viewKey] || [],
            oldPointCount,
            newPointCount,
            defaultVisible,
        );
    });
    return next;
}

export function isPointInsideImage(point: THREE.Vector2, imgSize: THREE.Vector2): boolean {
    return (
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= imgSize.x &&
        point.y >= 0 &&
        point.y <= imgSize.y
    );
}

export function isSegmentProjectedInView(
    points3D: THREE.Vector3[],
    segmentIndex: number,
    view: Image2DRenderView,
    allViews: Image2DRenderView[] = [view],
): boolean {
    return isSegmentRelevantInCameraViews(points3D, segmentIndex, view, allViews);
}

function isSegmentAutoVisibleInView(
    points3D: THREE.Vector3[],
    segmentIndex: number,
    view: Image2DRenderView,
): boolean {
    if (!isSegmentProjectedInView(points3D, segmentIndex, view, [view])) {
        return false;
    }
    if (!view.hasOcclusionMask()) {
        return true;
    }
    const start = points3D[segmentIndex];
    const end = points3D[segmentIndex + 1];
    for (let sampleIndex = 0; sampleIndex < SEGMENT_VISIBILITY_SAMPLES; sampleIndex++) {
        const t = sampleIndex / (SEGMENT_VISIBILITY_SAMPLES - 1);
        const projected = view.worldToImg(start.clone().lerp(end, t));
        if (
            view.isImagePointAutoVisible(
                new THREE.Vector2(projected.x, projected.y),
            )
        ) {
            return true;
        }
    }
    return false;
}

export function resolveEffectiveVisibleForView(
    manualFlags: boolean[] | undefined,
    points3D: THREE.Vector3[],
    view: Image2DRenderView,
): boolean[] {
    const normalized = normalizeSegmentVisible(manualFlags, points3D.length);
    return normalized.map((manualVisible, index) => {
        return manualVisible && isSegmentAutoVisibleInView(points3D, index, view);
    });
}

export function deriveBevVisibility(
    byView: Record<string, boolean[]>,
    points3D: THREE.Vector3[],
    views: Image2DRenderView[],
): boolean[] {
    const segmentCount = Math.max(0, points3D.length - 1);
    if (segmentCount === 0) {
        return [];
    }
    const projectedViews = views.map((view) => ({
        flags: normalizeSegmentVisible(
            byView[getViewKeyFromImageView(view)],
            points3D.length,
        ),
        projected: Array.from({ length: segmentCount }, (_, index) =>
            getRelevantViewKeysForSegment(points3D, index, views).includes(
                getViewKeyFromImageView(view),
            ),
        ),
        autoVisible: Array.from({ length: segmentCount }, (_, index) =>
            isSegmentAutoVisibleInView(points3D, index, view),
        ),
    }));
    return Array.from({ length: segmentCount }, (_, index) => {
        const relevantViews = projectedViews.filter((entry) => entry.projected[index]);
        if (relevantViews.length === 0) {
            return false;
        }
        const allInvisible = relevantViews.every(
            (entry) => entry.flags[index] === false || !entry.autoVisible[index],
        );
        return !allInvisible;
    });
}

export function toBevExportSegmentVisibility(flags: boolean[]): ISegmentVisibilityEntry[] {
    return segmentVisibleToExport(flags);
}

export function distancePointToSegment(
    point: THREE.Vector2,
    start: THREE.Vector2,
    end: THREE.Vector2,
): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared <= 1e-8) {
        return point.distanceTo(start);
    }
    const t = Math.max(
        0,
        Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
    );
    const projection = new THREE.Vector2(start.x + t * dx, start.y + t * dy);
    return point.distanceTo(projection);
}

export function pickPolylineSegmentIndex(
    points: THREE.Vector2[],
    imagePoint: THREE.Vector2,
    thresholdPx: number,
): number | null {
    if (points.length < 2) {
        return null;
    }
    let bestIndex: number | null = null;
    let bestDistance = thresholdPx;
    for (let index = 0; index < points.length - 1; index++) {
        const distance = distancePointToSegment(imagePoint, points[index], points[index + 1]);
        if (distance <= bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    }
    return bestIndex;
}

export function projectPolylineToImagePoints(
    points3D: THREE.Vector3[],
    view: Image2DRenderView,
): THREE.Vector2[] {
    return points3D.map((point) => {
        const projected = view.worldToImg(point.clone());
        return new THREE.Vector2(projected.x, projected.y);
    });
}

export interface IPolylineHit {
    segmentIndex: number;
    t: number;
}

const VERTEX_SNAP_T = 0.000001;

function cloneByView(byView: Record<string, boolean[]>): Record<string, boolean[]> {
    const next: Record<string, boolean[]> = {};
    Object.entries(byView).forEach(([viewKey, flags]) => {
        next[viewKey] = flags.slice();
    });
    return next;
}

export function closestHitOnPolyline(
    points: THREE.Vector2[],
    imagePoint: THREE.Vector2,
    thresholdPx: number,
): { segmentIndex: number; t: number; distance: number; projection: THREE.Vector2 } | null {
    if (points.length < 2) {
        return null;
    }
    let best: {
        segmentIndex: number;
        t: number;
        distance: number;
        projection: THREE.Vector2;
    } | null = null;
    for (let index = 0; index < points.length - 1; index++) {
        const start = points[index];
        const end = points[index + 1];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSquared = dx * dx + dy * dy;
        const t =
            lengthSquared <= 1e-8
                ? 0
                : Math.max(
                      0,
                      Math.min(1, ((imagePoint.x - start.x) * dx + (imagePoint.y - start.y) * dy) / lengthSquared),
                  );
        const projection = new THREE.Vector2(start.x + t * dx, start.y + t * dy);
        const distance = imagePoint.distanceTo(projection);
        if (distance <= thresholdPx && (!best || distance < best.distance)) {
            best = { segmentIndex: index, t, distance, projection };
        }
    }
    return best;
}

function hitToWorldPoint(points: THREE.Vector3[], hit: IPolylineHit): THREE.Vector3 {
    return points[hit.segmentIndex].clone().lerp(points[hit.segmentIndex + 1], hit.t);
}

function closestHitOnPolyline3D(
    points: THREE.Vector3[],
    worldPoint: THREE.Vector3,
): IPolylineHit {
    let best: { segmentIndex: number; t: number; distance: number } = {
        segmentIndex: 0,
        t: 0,
        distance: Number.POSITIVE_INFINITY,
    };
    for (let index = 0; index < points.length - 1; index++) {
        const start = points[index];
        const end = points[index + 1];
        const segment = end.clone().sub(start);
        const lengthSquared = segment.lengthSq();
        const t =
            lengthSquared <= 1e-12
                ? 0
                : Math.max(0, Math.min(1, worldPoint.clone().sub(start).dot(segment) / lengthSquared));
        const projection = start.clone().addScaledVector(segment, t);
        const distance = worldPoint.distanceTo(projection);
        if (distance < best.distance) {
            best = { segmentIndex: index, t, distance };
        }
    }
    return { segmentIndex: best.segmentIndex, t: best.t };
}

function insertWorldPoint(
    points: THREE.Vector3[],
    byView: Record<string, boolean[]>,
    worldPoint: THREE.Vector3,
): { points: THREE.Vector3[]; byView: Record<string, boolean[]>; vertexIndex: number } {
    const hit = closestHitOnPolyline3D(points, worldPoint);
    if (hit.t <= VERTEX_SNAP_T) {
        return { points, byView, vertexIndex: hit.segmentIndex };
    }
    if (hit.t >= 1 - VERTEX_SNAP_T) {
        return { points, byView, vertexIndex: hit.segmentIndex + 1 };
    }
    const insertIndex = hit.segmentIndex + 1;
    const nextPoints = points.map((point) => point.clone());
    nextPoints.splice(insertIndex, 0, worldPoint.clone());
    const nextByView = cloneByView(byView);
    CAMERA_VIEW_KEYS.forEach((key) => {
        nextByView[key] = remapAfterInsert(
            normalizeSegmentVisible(nextByView[key], points.length),
            insertIndex,
        );
    });
    return { points: nextPoints, byView: nextByView, vertexIndex: insertIndex };
}

export function toggleRangeBetweenHits(
    points3D: THREE.Vector3[],
    byView: Record<string, boolean[]>,
    viewKey: string,
    hitA: IPolylineHit,
    hitB: IPolylineHit,
): {
    points: THREE.Vector3[];
    byView: Record<string, boolean[]>;
    visible: boolean;
} | null {
    const worldA = hitToWorldPoint(points3D, hitA);
    const worldB = hitToWorldPoint(points3D, hitB);
    let points = points3D.map((point) => point.clone());
    let nextByView = cloneByView(byView);
    const first = insertWorldPoint(points, nextByView, worldA);
    const second = insertWorldPoint(first.points, first.byView, worldB);
    points = second.points;
    nextByView = second.byView;
    let firstIndex = first.vertexIndex;
    if (second.points.length > first.points.length && second.vertexIndex <= firstIndex) {
        firstIndex += 1;
    }
    const start = Math.min(firstIndex, second.vertexIndex);
    const end = Math.max(firstIndex, second.vertexIndex);
    if (end - start < 1) {
        return null;
    }
    const flags = normalizeSegmentVisible(nextByView[viewKey], points.length);
    const visible = flags.slice(start, end).every((value) => value === false);
    for (let index = start; index < end; index++) {
        flags[index] = visible;
    }
    nextByView[viewKey] = flags;
    return { points, byView: nextByView, visible };
}
