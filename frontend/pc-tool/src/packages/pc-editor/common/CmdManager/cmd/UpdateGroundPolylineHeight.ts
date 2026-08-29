import CmdBase from '../CmdBase';
import { GroundPolyline } from 'pc-render';
import type { ICmdOption } from './index';

export default class UpdateGroundPolylineHeight extends CmdBase<
    ICmdOption['update-ground-polyline-height'],
    number
> {
    redo(): void {
        const { object, wallHeight } = this.data;
        if (this.undoData == null) this.undoData = object.wallHeight;
        this.apply(object, wallHeight);
    }

    undo(): void {
        if (this.undoData == null) return;
        this.apply(this.data.object, this.undoData);
    }

    canMerge(cmd: CmdBase): boolean {
        return (
            cmd instanceof UpdateGroundPolylineHeight &&
            this.data.object === cmd.data.object &&
            Math.abs(this.updateTime - cmd.updateTime) < 500
        );
    }

    merge(cmd: UpdateGroundPolylineHeight): void {
        this.data.wallHeight = cmd.data.wallHeight;
        this.updateTime = new Date().getTime();
    }

    private apply(object: GroundPolyline, wallHeight: number): void {
        const height = Number.isFinite(wallHeight) ? Math.max(0, wallHeight) : 0;
        object.setWallHeight(height);
        object.userData.wallHeight = height;
        this.editor.dataManager.setGroundPolygonPoints(object, object.points3D);
    }
}
