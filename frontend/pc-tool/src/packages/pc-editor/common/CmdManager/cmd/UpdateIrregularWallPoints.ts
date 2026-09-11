import * as THREE from 'three';
import CmdBase from '../CmdBase';
import type { ICmdOption } from './index';

export default class UpdateIrregularWallPoints extends CmdBase<ICmdOption['update-irregular-wall-points'], THREE.Vector3[]> {
    redo(): void {
        const { object, side, points } = this.data;
        if (points.length < 2) throw new Error('IrregularWall sides require at least two points');
        if (!this.undoData) {
            this.undoData = (this.data.beforePoints || (side === 'bottom' ? object.bottomPoints : object.topPoints)).map((point) => point.clone());
        }
        this.editor.dataManager.setIrregularWallPoints(object, side, points);
    }

    undo(): void {
        if (this.undoData) {
            this.editor.dataManager.setIrregularWallPoints(
                this.data.object,
                this.data.side,
                this.undoData,
            );
        }
    }

    canMerge(cmd: CmdBase): boolean {
        return cmd instanceof UpdateIrregularWallPoints && this.data.object === cmd.data.object && this.data.side === cmd.data.side && Math.abs(this.updateTime - cmd.updateTime) < 500;
    }

    merge(cmd: UpdateIrregularWallPoints): void {
        this.data.points = cmd.data.points;
        this.updateTime = Date.now();
    }
}
