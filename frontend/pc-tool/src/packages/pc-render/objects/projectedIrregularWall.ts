import * as THREE from 'three';
import { ObjectType } from 'pc-editor';
import { Object2D } from './object2d';

/** Camera-image projection of an IrregularWall's bottom/top boundaries. */
export default class ProjectedIrregularWall extends Object2D {
    objectType = ObjectType.TYPE_2D_IRREGULAR_WALL;
    readonly bottomPoints: THREE.Vector2[] = [];
    readonly topPoints: THREE.Vector2[] = [];

    constructor(bottomPoints: THREE.Vector2[] = [], topPoints: THREE.Vector2[] = []) {
        super();
        this.setPoints(bottomPoints, topPoints);
    }

    setPoints(bottomPoints: THREE.Vector2[], topPoints: THREE.Vector2[]): void {
        this.bottomPoints.splice(
            0,
            this.bottomPoints.length,
            ...bottomPoints.map((point) => point.clone()),
        );
        this.topPoints.splice(
            0,
            this.topPoints.length,
            ...topPoints.map((point) => point.clone()),
        );
    }

    isContainPosition(position: THREE.Vector2): boolean {
        const segments: Array<[THREE.Vector2, THREE.Vector2]> = [];
        this.addSegments(segments, this.bottomPoints);
        this.addSegments(segments, this.topPoints);
        if (this.bottomPoints.length >= 2 && this.topPoints.length >= 2) {
            const top = orientTop(this.bottomPoints, this.topPoints);
            segments.push(
                [this.bottomPoints[0], top[0]],
                [this.bottomPoints.at(-1)!, top.at(-1)!],
            );
        }
        return segments.some(([start, end]) => distanceToSegment(position, start, end) <= 8);
    }

    private addSegments(
        target: Array<[THREE.Vector2, THREE.Vector2]>,
        points: THREE.Vector2[],
    ): void {
        points.slice(0, -1).forEach((point, index) => {
            target.push([point, points[index + 1]]);
        });
    }
}

function orientTop(bottom: THREE.Vector2[], top: THREE.Vector2[]): THREE.Vector2[] {
    const direct = bottom[0].distanceTo(top[0]) + bottom.at(-1)!.distanceTo(top.at(-1)!);
    const reversed = bottom[0].distanceTo(top.at(-1)!) + bottom.at(-1)!.distanceTo(top[0]);
    return reversed < direct ? [...top].reverse() : top;
}

function distanceToSegment(
    point: THREE.Vector2,
    start: THREE.Vector2,
    end: THREE.Vector2,
): number {
    const segment = end.clone().sub(start);
    const lengthSquared = segment.lengthSq();
    if (lengthSquared <= 1e-8) return point.distanceTo(start);
    const t = THREE.MathUtils.clamp(
        point.clone().sub(start).dot(segment) / lengthSquared,
        0,
        1,
    );
    return point.distanceTo(start.clone().addScaledVector(segment, t));
}
