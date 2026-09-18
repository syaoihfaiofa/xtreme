import CmdBase from '../CmdBase';
import * as THREE from 'three';
import type { ICmdOption } from './index';

interface IUndoData {
    points: THREE.Vector3[];
    byView: Record<string, boolean[]>;
    forceVisibleByView: Record<string, boolean[]>;
}

export default class UpdateGroundPolylineVisibilityRange extends CmdBase<
    ICmdOption['update-ground-polyline-visibility-range'],
    IUndoData
> {
    redo(): void {
        const { object, points, byView, forceVisibleByView } = this.data;
        if (!this.undoData) {
            this.undoData = {
                points: object.points3D.map((point) => point.clone()),
                byView: JSON.parse(JSON.stringify(object.segmentVisibleByView)),
                forceVisibleByView: JSON.parse(
                    JSON.stringify(object.segmentForceVisibleByView),
                ),
            };
        }
        this.editor.dataManager.setGroundPolygonPoints(object, points);
        object.setSegmentVisibleByView(byView);
        object.setSegmentForceVisibleByView(forceVisibleByView);
        const frame = (object as { frame?: import('../../type').IFrame }).frame;
        this.editor.dataManager.onAnnotatesChange([object], frame, { type: 'userData' });
    }

    undo(): void {
        if (!this.undoData) return;
        this.editor.dataManager.setGroundPolygonPoints(this.data.object, this.undoData.points);
        this.data.object.setSegmentVisibleByView(this.undoData.byView);
        this.data.object.setSegmentForceVisibleByView(this.undoData.forceVisibleByView);
        const frame = (this.data.object as { frame?: import('../../type').IFrame }).frame;
        this.editor.dataManager.onAnnotatesChange([this.data.object], frame, { type: 'userData' });
    }

    canMerge(): boolean {
        return false;
    }
}
