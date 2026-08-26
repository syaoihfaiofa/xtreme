import * as THREE from 'three';
import { GroundPolyline, Image2DRenderView } from 'pc-render';

import type Editor from '../Editor';
import {
    CAMERA_VIEW_KEYS,
    deriveBevVisibility,
    getViewKeyFromImageView,
    normalizeSegmentForceVisible,
    normalizeSegmentVisible,
    segmentVisibleFromImport,
    toBevExportSegmentVisibility,
    segmentVisibilityByViewFromImport,
    segmentVisibilityByViewToExport,
    type SegmentVisibilityByView,
} from './polylineSegmentVisibility';
import { computeImageBoundaryOcclusion } from './polylineImageBoundaryOcclusion';

const BEV_RENDER_SAMPLES_PER_SEGMENT = 32;

export function getImageViews(editor: Editor): Image2DRenderView[] {
    const prefix = editor.state.config.imgViewPrefix;
    return editor.pc.renderViews.filter(
        (view): view is Image2DRenderView =>
            view instanceof Image2DRenderView && view.name.startsWith(prefix),
    );
}

export function refreshGroundPolylineBevDisplay(
    editor: Editor,
    object: GroundPolyline | GroundPolyline[],
): void {
    const objects = Array.isArray(object) ? object : [object];
    const views = getImageViews(editor);
    objects.forEach((polyline) => {
        const bevVisible = deriveBevVisibility(
            polyline.segmentVisibleByView,
            polyline.points3D,
            views,
            polyline.segmentForceVisibleByView,
        );
        polyline.setBevSegmentVisible(bevVisible);
        const viewsByKey = new Map(
            views.map((view) => [getViewKeyFromImageView(view), view] as const),
        );
        const hasAllCameraViews = CAMERA_VIEW_KEYS.every((viewKey) =>
            viewsByKey.has(viewKey),
        );
        const manualByView = Object.fromEntries(
            CAMERA_VIEW_KEYS.map((viewKey) => [
                viewKey,
                normalizeSegmentVisible(
                    polyline.segmentVisibleByView[viewKey],
                    polyline.points3D.length,
                ),
            ]),
        );
        const forceVisibleByView = Object.fromEntries(
            CAMERA_VIEW_KEYS.map((viewKey) => [
                viewKey,
                normalizeSegmentForceVisible(
                    polyline.segmentForceVisibleByView[viewKey],
                    polyline.points3D.length,
                ),
            ]),
        );
        const renderSegments: Array<{
            start: THREE.Vector3;
            end: THREE.Vector3;
            visible: boolean;
        }> = [];
        for (
            let segmentIndex = 0;
            segmentIndex < polyline.points3D.length - 1;
            segmentIndex++
        ) {
            const start = polyline.points3D[segmentIndex];
            const end = polyline.points3D[segmentIndex + 1];
            for (
                let sampleIndex = 0;
                sampleIndex < BEV_RENDER_SAMPLES_PER_SEGMENT;
                sampleIndex++
            ) {
                const from = sampleIndex / BEV_RENDER_SAMPLES_PER_SEGMENT;
                const to = (sampleIndex + 1) / BEV_RENDER_SAMPLES_PER_SEGMENT;
                const midpoint = start.clone().lerp(end, (from + to) / 2);
                const visible =
                    !hasAllCameraViews ||
                    CAMERA_VIEW_KEYS.some((viewKey) => {
                        if (forceVisibleByView[viewKey][segmentIndex]) {
                            return true;
                        }
                        if (!manualByView[viewKey][segmentIndex]) {
                            return false;
                        }
                        const view = viewsByKey.get(viewKey) as Image2DRenderView;
                        const projected = view.worldToImg(midpoint.clone());
                        return view.isImagePointAutoVisible(
                            new THREE.Vector2(projected.x, projected.y),
                        );
                    });
                renderSegments.push({
                    start: start.clone().lerp(end, from),
                    end: start.clone().lerp(end, to),
                    visible,
                });
            }
        }
        polyline.setBevRenderSegments(renderSegments);
    });
    editor.pc.render();
}

export function applyGroundPolylineImageBoundaryOcclusion(
    editor: Editor,
    polyline: GroundPolyline,
): boolean {
    const uniqueViews = new Map<string, Image2DRenderView>();
    getImageViews(editor).forEach((view) => {
        const key = getViewKeyFromImageView(view);
        if (!uniqueViews.has(key)) {
            uniqueViews.set(key, view);
        }
    });
    const projectionViews = Array.from(uniqueViews.entries()).map(([key, view]) => ({
        key,
        width: view.imgSize.x,
        height: view.imgSize.y,
        project: (point: THREE.Vector3) => {
            const projected = view.worldToImg(point);
            return { x: projected.x, y: projected.y };
        },
        isVisible: (point: { x: number; y: number }) =>
            view.isImagePointAutoVisible(new THREE.Vector2(point.x, point.y)),
    }));
    const result = computeImageBoundaryOcclusion(
        polyline.points3D,
        polyline.segmentVisibleByView,
        projectionViews,
    );
    const forceVisibleResult = computeImageBoundaryOcclusion(
        polyline.points3D,
        Object.fromEntries(
            Array.from(uniqueViews.keys()).map((key) => [
                key,
                polyline.getSegmentForceVisibleForView(key),
            ]),
        ),
        projectionViews,
    );
    const changed = result.changed || forceVisibleResult.changed;
    if (changed) {
        polyline.setPoints(result.points);
        polyline.setSegmentVisibleByView(result.segmentVisibleByView);
        polyline.setSegmentForceVisibleByView(forceVisibleResult.segmentVisibleByView);
    }
    const autoBoundaryPointIndices: number[] = [];
    for (let pointIndex = 1; pointIndex < result.points.length - 1; pointIndex++) {
        const previousMidpoint = result.points[pointIndex - 1]
            .clone()
            .lerp(result.points[pointIndex], 0.5);
        const nextMidpoint = result.points[pointIndex]
            .clone()
            .lerp(result.points[pointIndex + 1], 0.5);
        const isBoundary = projectionViews.some((projectionView) => {
            const previousProjected = projectionView.project(previousMidpoint);
            const nextProjected = projectionView.project(nextMidpoint);
            return (
                projectionView.isVisible(previousProjected) !==
                projectionView.isVisible(nextProjected)
            );
        });
        if (isBoundary) {
            autoBoundaryPointIndices.push(pointIndex);
        }
    }
    polyline.setAutoVisibilityBoundaryPointIndices(autoBoundaryPointIndices);
    return changed;
}

export function getGroundPolylineSegmentVisibilityExport(
    polyline: GroundPolyline,
): SegmentVisibilityByView {
    const exported = segmentVisibilityByViewToExport(polyline.segmentVisibleByView);
    exported.bev = toBevExportSegmentVisibility(polyline.getBevSegmentVisible());
    return exported;
}

export function getGroundPolylineForceVisibleExport(
    polyline: GroundPolyline,
): SegmentVisibilityByView {
    return segmentVisibilityByViewToExport(polyline.segmentForceVisibleByView);
}

export function applyGroundPolylineSegmentVisibilityImport(
    polyline: GroundPolyline,
    raw: SegmentVisibilityByView | undefined,
): void {
    polyline.setSegmentVisibleByView(
        segmentVisibilityByViewFromImport(raw, polyline.points3D.length),
    );
    if (raw?.bev) {
        const bevVisible = segmentVisibleFromImport(raw.bev, polyline.points3D.length);
        polyline.setBevSegmentVisible(bevVisible);
    }
}

export function applyGroundPolylineForceVisibleImport(
    polyline: GroundPolyline,
    raw: SegmentVisibilityByView | undefined,
): void {
    polyline.setSegmentForceVisibleByView(
        segmentVisibilityByViewFromImport(raw, polyline.points3D.length, false),
    );
}

export function getViewKeyForImageView(view: Image2DRenderView): string {
    return getViewKeyFromImageView(view);
}

export {
    deriveBevVisibility,
    getViewKeyFromImageView,
    segmentVisibilityByViewFromImport,
    segmentVisibilityByViewToExport,
} from './polylineSegmentVisibility';
