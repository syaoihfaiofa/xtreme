import * as THREE from 'three';
import { isPointInRect } from '../utils';
import { ObjectType } from 'pc-editor';
import { Object2D } from './object2d';

export default class ProjectedPolygon extends Object2D {
    points: [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2] = [
        new THREE.Vector2(),
        new THREE.Vector2(),
        new THREE.Vector2(),
        new THREE.Vector2(),
    ];
    openingDirection: THREE.Vector2 = new THREE.Vector2();
    edgePoints?: THREE.Vector2[][];
    objectType = ObjectType.TYPE_2D_GROUND_POLYGON;

    constructor(points?: THREE.Vector2[], openingDirection?: THREE.Vector2) {
        super();
        if (points) this.setPoints(points);
        if (openingDirection) this.openingDirection.copy(openingDirection);
    }

    setPoints(points: THREE.Vector2[]): void {
        if (points.length !== 4) {
            throw new Error(`ProjectedPolygon requires exactly four points; received ${points.length}`);
        }
        points.forEach((point, index) => this.points[index].copy(point));
    }

    isContainPosition(pos: THREE.Vector2): boolean {
        return isPointInRect(pos, this.points);
    }
}
