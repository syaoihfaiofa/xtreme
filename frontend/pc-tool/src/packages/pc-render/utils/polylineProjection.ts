import * as THREE from 'three';

import Image2DRenderView from '../renderView/Image2DRenderView';

export const CAMERA_VIEW_KEYS = ['0', '1', '2', '3'] as const;
const SEGMENT_PROJECTION_SAMPLES = 33;
const MAX_RELEVANT_VIEWS = 2;
const RELATIVE_SCORE_RATIO = 0.5;

export function getCameraViewKey(view: Image2DRenderView): string {
    if (view.visibilityViewKey) {
        return view.visibilityViewKey;
    }
    const viewId = view.renderId || view.id;
    const match = viewId.match(/[0-9]{1,5}$/);
    return match ? match[0] : viewId;
}

function isPointInsideImage(point: THREE.Vector2, imgSize: THREE.Vector2): boolean {
    return (
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x >= 0 &&
        point.x <= imgSize.x &&
        point.y >= 0 &&
        point.y <= imgSize.y
    );
}

export function uniqueCameraViews(views: Image2DRenderView[]): Image2DRenderView[] {
    const byKey = new Map<string, Image2DRenderView>();
    views.forEach((view) => {
        const key = getCameraViewKey(view);
        if (!CAMERA_VIEW_KEYS.includes(key as (typeof CAMERA_VIEW_KEYS)[number])) {
            return;
        }
        if (!byKey.has(key)) {
            byKey.set(key, view);
        }
    });
    return CAMERA_VIEW_KEYS.map((key) => byKey.get(key)).filter(
        (view): view is Image2DRenderView => Boolean(view),
    );
}

export function getSegmentProjectionScore(
    points3D: THREE.Vector3[],
    segmentIndex: number,
    view: Image2DRenderView,
): number {
    if (segmentIndex < 0 || segmentIndex >= points3D.length - 1) {
        return 0;
    }
    const start = points3D[segmentIndex];
    const end = points3D[segmentIndex + 1];
    let insideCount = 0;
    for (let sampleIndex = 0; sampleIndex < SEGMENT_PROJECTION_SAMPLES; sampleIndex++) {
        const t = sampleIndex / (SEGMENT_PROJECTION_SAMPLES - 1);
        const projected = view.worldToImg(start.clone().lerp(end, t));
        if (isPointInsideImage(new THREE.Vector2(projected.x, projected.y), view.imgSize)) {
            insideCount += 1;
        }
    }
    return insideCount / SEGMENT_PROJECTION_SAMPLES;
}

export function getRelevantViewKeysForSegment(
    points3D: THREE.Vector3[],
    segmentIndex: number,
    views: Image2DRenderView[],
): string[] {
    const scored = uniqueCameraViews(views)
        .map((view) => ({
            key: getCameraViewKey(view),
            score: getSegmentProjectionScore(points3D, segmentIndex, view),
        }))
        .filter((entry) => entry.score > 0);
    if (scored.length === 0) {
        return [];
    }
    const bestScore = Math.max(...scored.map((entry) => entry.score));
    return scored
        .filter((entry) => entry.score >= bestScore * RELATIVE_SCORE_RATIO)
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_RELEVANT_VIEWS)
        .map((entry) => entry.key);
}

export function getRelevantViewKeysForPolyline(
    points3D: THREE.Vector3[],
    views: Image2DRenderView[],
): string[] {
    const scored = uniqueCameraViews(views)
        .map((view) => {
            let score = 0;
            for (let index = 0; index < points3D.length - 1; index++) {
                score += getSegmentProjectionScore(points3D, index, view);
            }
            return { key: getCameraViewKey(view), score };
        })
        .filter((entry) => entry.score > 0);
    if (scored.length === 0) {
        return [];
    }
    const bestScore = Math.max(...scored.map((entry) => entry.score));
    return scored
        .filter((entry) => entry.score >= bestScore * RELATIVE_SCORE_RATIO)
        .sort((left, right) => right.score - left.score)
        .slice(0, MAX_RELEVANT_VIEWS)
        .map((entry) => entry.key);
}

export function isSegmentProjectedInView(
    points3D: THREE.Vector3[],
    segmentIndex: number,
    view: Image2DRenderView,
    allViews: Image2DRenderView[],
): boolean {
    return getRelevantViewKeysForSegment(points3D, segmentIndex, allViews).includes(
        getCameraViewKey(view),
    );
}
