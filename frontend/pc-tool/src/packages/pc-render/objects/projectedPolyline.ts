import * as THREE from 'three';
import { ObjectType } from 'pc-editor';
import { Object2D } from './object2d';

export default class ProjectedPolyline extends Object2D {
    points: THREE.Vector2[] = [];
    objectType = ObjectType.TYPE_2D_GROUND_POLYLINE;

    constructor(points: THREE.Vector2[] = []) {
        super();
        this.points = points.map((point) => point.clone());
    }

    isContainPosition(position: THREE.Vector2): boolean {
        return this.points.slice(0, -1).some((start, index) => {
            const end = this.points[index + 1];
            const segment = end.clone().sub(start);
            const lengthSq = segment.lengthSq();
            if (lengthSq === 0) return position.distanceTo(start) <= 8;
            const factor = THREE.MathUtils.clamp(position.clone().sub(start).dot(segment) / lengthSq, 0, 1);
            return position.distanceTo(start.clone().addScaledVector(segment, factor)) <= 8;
        });
    }
}
