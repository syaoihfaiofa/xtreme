import * as THREE from 'three';
import { AnnotateType, Intersect } from '../type';
import { ObjectType } from 'pc-editor';

const defaultMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
});

/**
 * A four-vertex ground footprint. Vertices are ordered left-front, left-rear,
 * right-rear, right-front; the closing P3 -> P0 edge is the parking entrance.
 */
export default class GroundPolygon extends THREE.LineLoop {
    annotateType = AnnotateType.ANNOTATE_3D;
    objectType = ObjectType.TYPE_GROUND_POLYGON;
    color = new THREE.Color();
    readonly points3D: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Vector3(),
    ];
    private readonly openingEdge: THREE.Line;
    private readonly directionArrow: THREE.LineSegments;

    constructor(points?: THREE.Vector3[]) {
        super(new THREE.BufferGeometry(), defaultMaterial.clone());
        this.type = 'GroundPolygon';
        this.openingEdge = new THREE.Line(
            new THREE.BufferGeometry(),
            new THREE.LineBasicMaterial({ color: 0x00e5ff, linewidth: 2, toneMapped: false }),
        );
        this.directionArrow = new THREE.LineSegments(
            new THREE.BufferGeometry(),
            new THREE.LineBasicMaterial({ color: 0x00e5ff, linewidth: 2, toneMapped: false }),
        );
        this.add(this.openingEdge, this.directionArrow);
        if (points) this.setPoints(points);
        else this.updateGeometry();
    }

    setPoints(points: THREE.Vector3[]): void {
        if (points.length !== 4) {
            throw new Error(`GroundPolygon requires exactly four points; received ${points.length}`);
        }
        points.forEach((point, index) => this.points3D[index].copy(point));
        this.updateGeometry();
    }

    static isValidPoints(points: THREE.Vector3[]): boolean {
        if (points.length !== 4) return false;

        const area = points.reduce((sum, point, index) => {
            const next = points[(index + 1) % points.length];
            return sum + point.x * next.y - next.x * point.y;
        }, 0);
        if (Math.abs(area) <= 1e-6) return false;

        return (
            !GroundPolygon.segmentsIntersect(points[0], points[1], points[2], points[3]) &&
            !GroundPolygon.segmentsIntersect(points[1], points[2], points[3], points[0])
        );
    }

    getOpeningDirection(target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
        const rearCenter = new THREE.Vector3()
            .copy(this.points3D[1])
            .add(this.points3D[2])
            .multiplyScalar(0.5);
        const openingCenter = new THREE.Vector3()
            .copy(this.points3D[0])
            .add(this.points3D[3])
            .multiplyScalar(0.5);
        return target.copy(openingCenter).sub(rearCenter).normalize();
    }

    setColor(color: THREE.ColorRepresentation): void {
        this.color.set(color);
        (this.material as THREE.LineBasicMaterial).color.copy(this.color);
    }

    raycast(raycaster: THREE.Raycaster, intersects: Intersect[]): void {
        super.raycast(raycaster, intersects as THREE.Intersection[]);
    }

    private updateGeometry(): void {
        this.geometry.setFromPoints(this.points3D);
        this.geometry.computeBoundingBox();
        this.geometry.computeBoundingSphere();

        this.openingEdge.geometry.setFromPoints([this.points3D[3], this.points3D[0]]);
        const rearCenter = this.points3D[1].clone().add(this.points3D[2]).multiplyScalar(0.5);
        const openingCenter = this.points3D[0].clone().add(this.points3D[3]).multiplyScalar(0.5);
        const direction = openingCenter.clone().sub(rearCenter);
        const arrowLength = Math.min(direction.length() * 0.45, 1.2);
        if (arrowLength <= 0.001) {
            this.directionArrow.geometry.setFromPoints([]);
            return;
        }
        direction.normalize();
        const arrowEnd = rearCenter.clone().addScaledVector(direction, arrowLength);
        const side = new THREE.Vector3(-direction.y, direction.x, 0).multiplyScalar(arrowLength * 0.25);
        const arrowBase = arrowEnd.clone().addScaledVector(direction, -arrowLength * 0.25);
        this.directionArrow.geometry.setFromPoints([
            rearCenter,
            arrowEnd,
            arrowEnd,
            arrowBase.clone().add(side),
            arrowEnd,
            arrowBase.clone().sub(side),
        ]);
    }

    private static segmentsIntersect(
        startA: THREE.Vector3,
        endA: THREE.Vector3,
        startB: THREE.Vector3,
        endB: THREE.Vector3,
    ): boolean {
        const cross = (origin: THREE.Vector3, pointA: THREE.Vector3, pointB: THREE.Vector3): number =>
            (pointA.x - origin.x) * (pointB.y - origin.y) -
            (pointA.y - origin.y) * (pointB.x - origin.x);
        const crossA = cross(startA, endA, startB);
        const crossB = cross(startA, endA, endB);
        const crossC = cross(startB, endB, startA);
        const crossD = cross(startB, endB, endA);
        const epsilon = 1e-6;

        if (
            ((crossA > epsilon && crossB < -epsilon) || (crossA < -epsilon && crossB > epsilon)) &&
            ((crossC > epsilon && crossD < -epsilon) || (crossC < -epsilon && crossD > epsilon))
        ) {
            return true;
        }

        const isOnSegment = (
            start: THREE.Vector3,
            point: THREE.Vector3,
            end: THREE.Vector3,
        ): boolean =>
            point.x >= Math.min(start.x, end.x) - epsilon &&
            point.x <= Math.max(start.x, end.x) + epsilon &&
            point.y >= Math.min(start.y, end.y) - epsilon &&
            point.y <= Math.max(start.y, end.y) + epsilon;
        return (
            (Math.abs(crossA) <= epsilon && isOnSegment(startA, startB, endA)) ||
            (Math.abs(crossB) <= epsilon && isOnSegment(startA, endB, endA)) ||
            (Math.abs(crossC) <= epsilon && isOnSegment(startB, startA, endB)) ||
            (Math.abs(crossD) <= epsilon && isOnSegment(startB, endA, endB))
        );
    }
}
