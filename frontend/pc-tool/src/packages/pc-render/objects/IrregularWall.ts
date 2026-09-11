import * as THREE from 'three';
import { AnnotateType, Intersect } from '../type';
import { ObjectType } from 'pc-editor';

export type WallSide = 'bottom' | 'top';

/** A ruled wall bounded by two independently sampled 3D polylines. */
export default class IrregularWall extends THREE.Group {
    annotateType = AnnotateType.ANNOTATE_3D;
    objectType = ObjectType.TYPE_IRREGULAR_WALL;
    readonly bottomPoints: THREE.Vector3[] = [];
    readonly topPoints: THREE.Vector3[] = [];
    readonly bottomLine = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    readonly topLine = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xff9f1c, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    readonly connectorLine = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    readonly bottomVertices = new THREE.Points(
        new THREE.BufferGeometry(),
        new THREE.PointsMaterial({ color: 0x00e5ff, size: 8, sizeAttenuation: false, depthTest: false, depthWrite: false }),
    );
    readonly topVertices = new THREE.Points(
        new THREE.BufferGeometry(),
        new THREE.PointsMaterial({ color: 0xff9f1c, size: 8, sizeAttenuation: false, depthTest: false, depthWrite: false }),
    );
    readonly wallMesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }),
    );
    private color = new THREE.Color('#00e5ff');

    constructor(bottomPoints: THREE.Vector3[] = [], topPoints: THREE.Vector3[] = []) {
        super();
        this.type = 'IrregularWall';
        this.bottomLine.renderOrder = 1000;
        this.topLine.renderOrder = 1000;
        this.connectorLine.renderOrder = 1000;
        this.bottomVertices.renderOrder = 1001;
        this.topVertices.renderOrder = 1001;
        this.add(this.wallMesh, this.bottomLine, this.topLine, this.connectorLine, this.bottomVertices, this.topVertices);
        this.setPoints(bottomPoints, topPoints);
    }

    setPoints(bottomPoints: THREE.Vector3[], topPoints: THREE.Vector3[]): void {
        this.assertPolyline(bottomPoints, 'bottom');
        this.assertPolyline(topPoints, 'top');
        this.bottomPoints.splice(0, this.bottomPoints.length, ...bottomPoints.map((point) => point.clone()));
        this.topPoints.splice(0, this.topPoints.length, ...topPoints.map((point) => point.clone()));
        this.rebuildGeometry();
    }

    setSidePoints(side: WallSide, points: THREE.Vector3[]): void {
        this.setPoints(side === 'bottom' ? points : this.bottomPoints, side === 'top' ? points : this.topPoints);
    }

    appendPoint(side: WallSide, point: THREE.Vector3, atStart = false): void {
        const points = (side === 'bottom' ? this.bottomPoints : this.topPoints).map((item) => item.clone());
        if (atStart) points.unshift(point.clone());
        else points.push(point.clone());
        this.setSidePoints(side, points);
    }

    setColor(color: THREE.ColorRepresentation): void {
        this.color.set(color);
        (this.bottomLine.material as THREE.LineBasicMaterial).color.copy(this.color);
        (this.bottomVertices.material as THREE.PointsMaterial).color.copy(this.color);
        (this.wallMesh.material as THREE.MeshBasicMaterial).color.copy(this.color);
    }

    validate(): string | null {
        if (this.bottomPoints.length < 2) return '底边至少需要两个点';
        if (this.topPoints.length === 1) return '顶边至少需要两个点';
        if (this.hasSelfIntersection(this.bottomPoints)) return '底边在鸟瞰投影中自交';
        if (this.topPoints.length === 0) return null;
        if (this.hasSelfIntersection(this.topPoints)) return '顶边在鸟瞰投影中自交';
        const samples = this.mergedSamples();
        for (const sample of samples) {
            if (sample.top.z + 1e-6 < sample.bottom.z) return '顶部不能低于对应底边';
        }
        return null;
    }

    raycast(raycaster: THREE.Raycaster, intersects: Intersect[]): void {
        this.bottomLine.raycast(raycaster, intersects as THREE.Intersection[]);
        this.topLine.raycast(raycaster, intersects as THREE.Intersection[]);
        this.wallMesh.raycast(raycaster, intersects as THREE.Intersection[]);
    }

    private assertPolyline(points: THREE.Vector3[], name: string): void {
        if (points.length > 0 && points.length < 2) throw new Error(`${name} polyline requires at least two points`);
        if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z))) {
            throw new Error(`${name} polyline contains an invalid point`);
        }
        for (let index = 1; index < points.length; index++) {
            if (points[index - 1].distanceToSquared(points[index]) <= 1e-12) throw new Error(`${name} polyline contains a zero-length segment`);
        }
    }

    private rebuildGeometry(): void {
        this.bottomLine.geometry.setFromPoints(this.toSegments(this.bottomPoints));
        this.topLine.geometry.setFromPoints(this.toSegments(this.topPoints));
        this.bottomVertices.geometry.setFromPoints(this.bottomPoints);
        this.topVertices.geometry.setFromPoints(this.topPoints);
        // BufferGeometry keeps its previous bounds after setFromPoints(). Rebuild
        // them so side-view frustum culling follows a newly adjusted wall height.
        this.bottomLine.geometry.computeBoundingSphere();
        this.topLine.geometry.computeBoundingSphere();
        this.bottomVertices.geometry.computeBoundingSphere();
        this.topVertices.geometry.computeBoundingSphere();
        const samples = this.mergedSamples();
        const connectors = samples.length >= 2 ? [samples[0].bottom, samples[0].top, samples.at(-1)!.bottom, samples.at(-1)!.top] : [];
        this.connectorLine.geometry.setFromPoints(connectors);
        this.connectorLine.geometry.computeBoundingSphere();
        const vertices: number[] = [];
        for (let index = 0; index + 1 < samples.length; index++) {
            const a = samples[index];
            const b = samples[index + 1];
            vertices.push(
                a.bottom.x, a.bottom.y, a.bottom.z, b.bottom.x, b.bottom.y, b.bottom.z, b.top.x, b.top.y, b.top.z,
                a.bottom.x, a.bottom.y, a.bottom.z, b.top.x, b.top.y, b.top.z, a.top.x, a.top.y, a.top.z,
            );
        }
        this.wallMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        this.wallMesh.geometry.computeBoundingBox();
        this.wallMesh.geometry.computeBoundingSphere();
        this.wallMesh.visible = vertices.length > 0;
    }

    private toSegments(points: THREE.Vector3[]): THREE.Vector3[] {
        return points.slice(0, -1).flatMap((point, index) => [point, points[index + 1]]);
    }

    private mergedSamples(): Array<{ bottom: THREE.Vector3; top: THREE.Vector3 }> {
        if (this.bottomPoints.length < 2 || this.topPoints.length < 2) return [];
        const topPoints = this.getOrientedTopPoints();
        const parameters = [...this.parameters(this.bottomPoints), ...this.parameters(topPoints)]
            .sort((a, b) => a - b)
            .filter((value, index, values) => index === 0 || value - values[index - 1] > 1e-8);
        return parameters.map((parameter) => ({
            bottom: this.interpolate(this.bottomPoints, parameter),
            top: this.interpolate(topPoints, parameter),
        }));
    }

    /**
     * Pointing the top polyline from either end is equally valid input. Keep the
     * original order for editing/export, but use the endpoint pairing with the
     * shortest two connector edges when building the wall surface.
     */
    private getOrientedTopPoints(): THREE.Vector3[] {
        const direct = this.topPoints;
        if (this.bottomPoints.length < 2 || direct.length < 2) return direct;
        const bottomStart = this.bottomPoints[0];
        const bottomEnd = this.bottomPoints.at(-1)!;
        const topStart = direct[0];
        const topEnd = direct.at(-1)!;
        const directDistance = bottomStart.distanceToSquared(topStart) + bottomEnd.distanceToSquared(topEnd);
        const reversedDistance = bottomStart.distanceToSquared(topEnd) + bottomEnd.distanceToSquared(topStart);
        return reversedDistance < directDistance ? [...direct].reverse() : direct;
    }

    private parameters(points: THREE.Vector3[]): number[] {
        const lengths = [0];
        for (let index = 1; index < points.length; index++) lengths.push(lengths[index - 1] + points[index - 1].distanceTo(points[index]));
        const total = lengths.at(-1)!;
        return lengths.map((length) => length / total);
    }

    private interpolate(points: THREE.Vector3[], parameter: number): THREE.Vector3 {
        const parameters = this.parameters(points);
        for (let index = 1; index < parameters.length; index++) {
            if (parameter <= parameters[index] + 1e-8) {
                const span = parameters[index] - parameters[index - 1];
                const ratio = span <= 1e-8 ? 0 : (parameter - parameters[index - 1]) / span;
                return points[index - 1].clone().lerp(points[index], ratio);
            }
        }
        return points.at(-1)!.clone();
    }

    private hasSelfIntersection(points: THREE.Vector3[]): boolean {
        for (let first = 0; first + 1 < points.length; first++) {
            for (let second = first + 2; second + 1 < points.length; second++) {
                if (this.segmentsIntersect(points[first], points[first + 1], points[second], points[second + 1])) return true;
            }
        }
        return false;
    }

    private segmentsIntersect(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): boolean {
        const orient = (origin: THREE.Vector3, first: THREE.Vector3, second: THREE.Vector3) => (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
        const abC = orient(a, b, c);
        const abD = orient(a, b, d);
        const cdA = orient(c, d, a);
        const cdB = orient(c, d, b);
        return abC * abD < -1e-10 && cdA * cdB < -1e-10;
    }
}
