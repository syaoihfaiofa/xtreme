import type { SegmentVisibilityByView, ISegmentVisibilityEntry } from '../packages/pc-editor/type';
import {
    deriveBevVisibility,
    getImageViews,
    toBevExportSegmentVisibility,
} from '../packages/pc-editor/utils/groundPolylineVisibility';
import type Editor from '../packages/pc-editor/Editor';
import type { GroundPolyline } from 'pc-render';
import type * as THREE from 'three';

export interface ITrainingBevPolylineContour {
    points: Array<{ x: number; y: number; z: number }>;
    segmentVisibility: ISegmentVisibilityEntry[];
}

export interface ITrainingBevPolylineExportInput {
    points: THREE.Vector3[];
    segmentVisibilityByView?: SegmentVisibilityByView;
    segmentForceVisibleByView?: SegmentVisibilityByView;
}

export function toTrainingBevPolylineContour(
    editor: Editor,
    input: ITrainingBevPolylineExportInput,
): ITrainingBevPolylineContour {
    const points = input.points.map((point) => ({
        x: point.x,
        y: point.y,
        z: point.z,
    }));
    const views = getImageViews(editor);
    const byView: Record<string, boolean[]> = {};
    const raw = input.segmentVisibilityByView || {};
    Object.entries(raw).forEach(([viewKey, entries]) => {
        if (!Array.isArray(entries)) {
            return;
        }
        const flags = Array.from({ length: Math.max(0, points.length - 1) }, () => true);
        entries.forEach((entry) => {
            if (
                Number.isInteger(entry.index) &&
                entry.index >= 0 &&
                entry.index < flags.length
            ) {
                flags[entry.index] = entry.visible !== false;
            }
        });
        byView[viewKey] = flags;
    });
    const forceVisibleByView: Record<string, boolean[]> = {};
    Object.entries(input.segmentForceVisibleByView || {}).forEach(([viewKey, entries]) => {
        const flags = Array.from({ length: Math.max(0, points.length - 1) }, () => false);
        entries.forEach((entry) => {
            if (Number.isInteger(entry.index) && entry.index >= 0 && entry.index < flags.length) {
                flags[entry.index] = entry.visible === true;
            }
        });
        forceVisibleByView[viewKey] = flags;
    });
    const vectorPoints = input.points.map(
        (point) => point.clone() as THREE.Vector3,
    );
    const bevVisible = deriveBevVisibility(
        byView,
        vectorPoints,
        views,
        forceVisibleByView,
    );
    return {
        points,
        segmentVisibility: toBevExportSegmentVisibility(bevVisible),
    };
}

export function toTrainingBevPolylineFromObject(
    editor: Editor,
    polyline: GroundPolyline,
): ITrainingBevPolylineContour {
    return toTrainingBevPolylineContour(editor, {
        points: polyline.points3D,
        segmentVisibilityByView: Object.fromEntries(
            Object.entries(polyline.segmentVisibleByView).map(([viewKey, flags]) => [
                viewKey,
                flags.map((visible, index) => ({ index, visible })),
            ]),
        ),
        segmentForceVisibleByView: Object.fromEntries(
            Object.entries(polyline.segmentForceVisibleByView).map(([viewKey, flags]) => [
                viewKey,
                flags.map((visible, index) => ({ index, visible })),
            ]),
        ),
    });
}
