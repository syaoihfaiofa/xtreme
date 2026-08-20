import CmdBase from '../CmdBase';
import * as THREE from 'three';
import { GroundPolyline } from 'pc-render';
import type { ICmdOption } from './index';

export default class UpdateGroundPolylinePoints extends CmdBase<
    ICmdOption['update-ground-polyline-points'],
    THREE.Vector3[]
> {
    redo(): void {
        const { object, points } = this.data;
        if (points.length < 2) throw new Error('GroundPolyline requires at least two points');
        if (!this.undoData) this.undoData = object.points3D.map((point) => point.clone());
        this.editor.dataManager.setGroundPolygonPoints(object, points);
    }

    undo(): void {
        if (this.undoData) this.editor.dataManager.setGroundPolygonPoints(this.data.object, this.undoData);
    }

    canMerge(cmd: CmdBase): boolean {
        return (
            cmd instanceof UpdateGroundPolylinePoints &&
            this.data.object === cmd.data.object &&
            Math.abs(this.updateTime - cmd.updateTime) < 500
        );
    }

    merge(cmd: UpdateGroundPolylinePoints): void {
        this.data.points = cmd.data.points;
        this.updateTime = new Date().getTime();
    }
}
