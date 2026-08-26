import type Editor from '../Editor';
import { GroundPolyline, Image2DRenderView } from 'pc-render';
import {
    deriveBevVisibility,
    getViewKeyFromImageView,
    segmentVisibilityByViewFromImport,
    segmentVisibilityByViewToExport,
    type SegmentVisibilityByView,
} from './polylineSegmentVisibility';
import { computeImageBoundaryOcclusion } from './polylineImageBoundaryOcclusion';

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
        );
        polyline.setBevSegmentVisible(bevVisible);
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
    const result = computeImageBoundaryOcclusion(
        polyline.points3D,
        polyline.segmentVisibleByView,
        Array.from(uniqueViews.entries()).map(([key, view]) => ({
            key,
            width: view.imgSize.x,
            height: view.imgSize.y,
            project: (point) => {
                const projected = view.worldToImg(point);
                return { x: projected.x, y: projected.y };
            },
        })),
    );
    if (!result.changed) {
        return false;
    }
    polyline.setPoints(result.points);
    polyline.setSegmentVisibleByView(result.segmentVisibleByView);
    return true;
}

export function getGroundPolylineSegmentVisibilityExport(
    polyline: GroundPolyline,
): SegmentVisibilityByView {
    return segmentVisibilityByViewToExport(polyline.segmentVisibleByView);
}

export function applyGroundPolylineSegmentVisibilityImport(
    polyline: GroundPolyline,
    raw: SegmentVisibilityByView | undefined,
): void {
    polyline.setSegmentVisibleByView(
        segmentVisibilityByViewFromImport(raw, polyline.points3D.length),
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
    toBevExportSegmentVisibility,
} from './polylineSegmentVisibility';
