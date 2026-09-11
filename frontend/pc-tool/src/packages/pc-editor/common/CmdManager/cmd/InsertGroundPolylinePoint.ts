import CmdBase from '../CmdBase';
import * as THREE from 'three';
import { GroundPolyline } from 'pc-render';
import type { ICmdOption } from './index';

type UndoData = {
    points: THREE.Vector3[];
    segmentVisibleByView: Record<string, boolean[]>;
    segmentForceVisibleByView: Record<string, boolean[]>;
    bevSegmentVisible: boolean[];
    autoVisibilityBoundaryPointIndices: number[];
};

export default class InsertGroundPolylinePoint extends CmdBase<
    ICmdOption['insert-ground-polyline-point'],
    UndoData
> {
    redo(): void {
        const { object, segmentIndex, point } = this.data;
        if (!this.undoData) {
            this.undoData = {
                points: object.points3D.map((item) => item.clone()),
                segmentVisibleByView: cloneFlags(object.segmentVisibleByView),
                segmentForceVisibleByView: cloneFlags(object.segmentForceVisibleByView),
                bevSegmentVisible: object.getBevSegmentVisible(),
                autoVisibilityBoundaryPointIndices: object.getAutoVisibilityBoundaryPointIndices(),
            };
        }
        object.insertPointAfter(segmentIndex, point);
        this.editor.markSyncDirtyForGroundShape(object);
        this.editor.dataManager.setGroundPolygonPoints(object, object.points3D);
    }

    undo(): void {
        if (!this.undoData) return;
        const { object } = this.data;
        object.setPoints(this.undoData.points);
        object.setSegmentVisibleByView(this.undoData.segmentVisibleByView);
        object.setSegmentForceVisibleByView(this.undoData.segmentForceVisibleByView);
        object.setBevSegmentVisible(this.undoData.bevSegmentVisible);
        object.setAutoVisibilityBoundaryPointIndices(this.undoData.autoVisibilityBoundaryPointIndices);
        this.editor.dataManager.setGroundPolygonPoints(object, object.points3D);
    }
}

function cloneFlags(byView: Record<string, boolean[]>): Record<string, boolean[]> {
    return Object.fromEntries(Object.entries(byView).map(([viewKey, flags]) => [viewKey, flags.slice()]));
}
