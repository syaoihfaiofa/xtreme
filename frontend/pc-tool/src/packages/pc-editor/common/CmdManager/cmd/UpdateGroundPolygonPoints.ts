import CmdBase from '../CmdBase';
import * as THREE from 'three';
import { GroundPolygon } from 'pc-render';
import type { ICmdOption } from './index';

export default class UpdateGroundPolygonPoints extends CmdBase<
    ICmdOption['update-ground-polygon-points'],
    THREE.Vector3[]
> {
    redo(): void {
        const { object, points } = this.data;
        if (!GroundPolygon.isValidPoints(points)) {
            throw new Error('GroundPolygon points must form a non-self-intersecting area');
        }
        if (!this.undoData) {
            this.undoData = object.points3D.map((point) => point.clone());
        }
        this.editor.dataManager.setGroundPolygonPoints(object, points);
    }

    undo(): void {
        if (!this.undoData) return;
        this.editor.dataManager.setGroundPolygonPoints(this.data.object, this.undoData);
    }

    canMerge(cmd: CmdBase): boolean {
        return (
            cmd instanceof UpdateGroundPolygonPoints &&
            this.data.object === cmd.data.object &&
            Math.abs(this.updateTime - cmd.updateTime) < 500
        );
    }

    merge(cmd: UpdateGroundPolygonPoints): void {
        this.data.points = cmd.data.points;
        this.updateTime = new Date().getTime();
    }
}
