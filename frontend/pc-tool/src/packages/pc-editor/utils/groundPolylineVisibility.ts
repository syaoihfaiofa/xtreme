import type Editor from '../Editor';
import { GroundPolyline, Image2DRenderView } from 'pc-render';
import {
    deriveBevVisibility,
    getViewKeyFromImageView,
    segmentVisibilityByViewFromImport,
    segmentVisibilityByViewToExport,
    type SegmentVisibilityByView,
} from './polylineSegmentVisibility';

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
