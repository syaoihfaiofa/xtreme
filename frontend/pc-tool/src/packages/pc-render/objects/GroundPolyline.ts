import * as THREE from 'three';
import { AnnotateType, Intersect } from '../type';
import { ObjectType } from 'pc-editor';

export default class GroundPolyline extends THREE.Line {
    annotateType = AnnotateType.ANNOTATE_3D;
    objectType = ObjectType.TYPE_GROUND_POLYLINE;
    color = new THREE.Color();
    readonly points3D: THREE.Vector3[] = [];

    constructor(points: THREE.Vector3[]) {
        super(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ toneMapped: false }));
        this.type = 'GroundPolyline';
        this.setPoints(points);
    }

    setPoints(points: THREE.Vector3[]): void {
        if (points.length < 2) {
            throw new Error(`GroundPolyline requires at least two points; received ${points.length}`);
        }
        this.points3D.splice(0, this.points3D.length, ...points.map((point) => point.clone()));
        this.geometry.setFromPoints(this.points3D);
        this.geometry.computeBoundingBox();
        this.geometry.computeBoundingSphere();
    }

    setColor(color: THREE.ColorRepresentation): void {
        this.color.set(color);
        (this.material as THREE.LineBasicMaterial).color.copy(this.color);
    }

    raycast(raycaster: THREE.Raycaster, intersects: Intersect[]): void {
        super.raycast(raycaster, intersects as THREE.Intersection[]);
    }
}
