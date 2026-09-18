import type { SegmentVisibilityByView, ISegmentVisibilityEntry } from '../packages/pc-editor/type';
import {
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
    _editor: Editor,
    input: ITrainingBevPolylineExportInput,
): ITrainingBevPolylineContour {
    const points = input.points.map((point) => ({
        x: point.x,
        y: point.y,
        z: point.z,
    }));
    return {
        points,
        // Camera/BEV visibility is no longer part of wall rendering or export.
        // Keep this legacy field for downstream schema compatibility, with all
        // segments present.
        segmentVisibility: toBevExportSegmentVisibility(
            Array.from({ length: Math.max(0, points.length - 1) }, () => true),
        ),
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
