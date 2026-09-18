import { GroundPolyline, Image2DRenderView } from 'pc-render';

import type Editor from '../Editor';
import {
    getViewKeyFromImageView,
    segmentVisibleFromImport,
    toBevExportSegmentVisibility,
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
    getViewKeyFromImageView,
    segmentVisibilityByViewFromImport,
    segmentVisibilityByViewToExport,
} from './polylineSegmentVisibility';
