import * as THREE from 'three';
import { AnnotateType, Intersect } from '../type';
import { ObjectType } from 'pc-editor';

const HIDDEN_LINE_COLOR = 0xffe600;
const CAMERA_VIEW_KEYS = ['0', '1', '2', '3'];

export interface IBevRenderSegment {
    start: THREE.Vector3;
    end: THREE.Vector3;
    visible: boolean;
}

export default class GroundPolyline extends THREE.LineSegments {
    annotateType = AnnotateType.ANNOTATE_3D;
    objectType = ObjectType.TYPE_GROUND_POLYLINE;
    color = new THREE.Color();
    wallHeight = 0;
    readonly points3D: THREE.Vector3[] = [];
    segmentVisibleByView: Record<string, boolean[]> = {};
    segmentForceVisibleByView: Record<string, boolean[]> = {};
    private autoVisibilityBoundaryPointIndices = new Set<number>();
    private bevSegmentVisible: boolean[] = [];
    private readonly hiddenLine: THREE.LineSegments;
    readonly wallMesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false }),
    );
    readonly topLine = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ toneMapped: false }),
    );

    constructor(points: THREE.Vector3[]) {
        super(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ toneMapped: false }));
        this.type = 'GroundPolyline';
        this.hiddenLine = new THREE.LineSegments(
            new THREE.BufferGeometry(),
            new THREE.LineBasicMaterial({
                color: HIDDEN_LINE_COLOR,
                toneMapped: false,
            }),
        );
        this.hiddenLine.visible = false;
        this.add(this.hiddenLine);
        this.wallMesh.visible = false;
        this.topLine.visible = false;
        this.add(this.wallMesh);
        this.add(this.topLine);
        this.setPoints(points);
    }

    setPoints(points: THREE.Vector3[]): void {
        if (points.length < 2) {
            throw new Error(`GroundPolyline requires at least two points; received ${points.length}`);
        }
        const oldPointCount = this.points3D.length;
        this.points3D.splice(0, this.points3D.length, ...points.map((point) => point.clone()));
        if (oldPointCount > 0 && oldPointCount !== points.length) {
            this.remapAllViewSegmentVisible(oldPointCount, points.length);
        }
        this.rebuildLineGeometry(this.bevSegmentVisible);
        this.rebuildWallGeometry();
        this.geometry.computeBoundingBox();
        this.geometry.computeBoundingSphere();
    }

    setWallHeight(height: number): void {
        this.wallHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
        this.rebuildWallGeometry();
    }

    insertPointAfter(segmentIndex: number, point: THREE.Vector3): void {
        if (segmentIndex < 0 || segmentIndex >= this.points3D.length - 1) {
            throw new Error(`Invalid GroundPolyline segment index: ${segmentIndex}`);
        }
        const pointCount = this.points3D.length;
        const points = this.points3D.map((item) => item.clone());
        points.splice(segmentIndex + 1, 0, point.clone());
        const splitVisible = this.splitSegmentFlags(this.segmentVisibleByView, pointCount, segmentIndex);
        const splitForceVisible = this.splitSegmentFlags(
            this.segmentForceVisibleByView,
            pointCount,
            segmentIndex,
            false,
        );
        const splitBevVisible = this.splitFlags(
            this.bevSegmentVisible,
            pointCount,
            segmentIndex,
        );
        const shiftedBoundaries = this.getAutoVisibilityBoundaryPointIndices().map((index) =>
            index > segmentIndex ? index + 1 : index,
        );

        this.setPoints(points);
        this.setSegmentVisibleByView(splitVisible);
        this.setSegmentForceVisibleByView(splitForceVisible);
        this.setBevSegmentVisible(splitBevVisible);
        this.setAutoVisibilityBoundaryPointIndices(shiftedBoundaries);
    }

    getAutoVisibilityBoundaryPointIndices(): number[] {
        return Array.from(this.autoVisibilityBoundaryPointIndices);
    }

    setSegmentVisibleByView(byView: Record<string, boolean[]>): void {
        this.segmentVisibleByView = {};
        Object.entries(byView).forEach(([viewKey, flags]) => {
            this.segmentVisibleByView[viewKey] = flags.slice();
        });
    }

    setSegmentForceVisibleByView(byView: Record<string, boolean[]>): void {
        this.segmentForceVisibleByView = {};
        Object.entries(byView).forEach(([viewKey, flags]) => {
            this.segmentForceVisibleByView[viewKey] = this.normalizeSegmentForceVisible(flags);
        });
    }

    getSegmentVisibleForView(viewKey: string): boolean[] {
        return this.normalizeSegmentVisible(this.segmentVisibleByView[viewKey]);
    }

    getSegmentForceVisibleForView(viewKey: string): boolean[] {
        return this.normalizeSegmentForceVisible(this.segmentForceVisibleByView[viewKey]);
    }

    setSegmentVisibleForView(viewKey: string, flags: boolean[]): void {
        this.segmentVisibleByView[viewKey] = this.normalizeSegmentVisible(flags);
    }

    toggleSegmentVisibleForView(viewKey: string, segmentIndex: number): boolean[] {
        const flags = this.getSegmentVisibleForView(viewKey);
        if (segmentIndex < 0 || segmentIndex >= flags.length) {
            return flags;
        }
        flags[segmentIndex] = !flags[segmentIndex];
        this.segmentVisibleByView[viewKey] = flags;
        return flags.slice();
    }

    setBevSegmentVisible(flags: boolean[]): void {
        this.bevSegmentVisible = this.normalizeSegmentVisible(flags);
        this.rebuildLineGeometry(this.bevSegmentVisible);
    }

    getBevSegmentVisible(): boolean[] {
        return this.bevSegmentVisible.slice();
    }

    setBevRenderSegments(segments: readonly IBevRenderSegment[]): void {
        // Visibility/occlusion is retained in data for compatibility, but is
        // deliberately not visualized: all curb segments use the normal line.
        const points = segments.flatMap((segment) => [segment.start.clone(), segment.end.clone()]);
        this.geometry.setFromPoints(points);
        this.geometry.computeBoundingBox();
        this.geometry.computeBoundingSphere();
        this.hiddenLine.visible = false;
    }

    isVisibilityBoundaryPoint(pointIndex: number): boolean {
        if (pointIndex <= 0 || pointIndex >= this.points3D.length - 1) {
            return false;
        }
        // Visibility changes alone must not hide a vertex: a manually inserted point can sit
        // exactly where adjacent segments have different visibility. Only points explicitly
        // created by automatic boundary splitting are non-editable boundary points.
        return this.autoVisibilityBoundaryPointIndices.has(pointIndex);
    }

    setAutoVisibilityBoundaryPointIndices(indices: Iterable<number>): void {
        this.autoVisibilityBoundaryPointIndices = new Set(
            Array.from(indices).filter(
                (index) => index > 0 && index < this.points3D.length - 1,
            ),
        );
    }

    padNewSegmentsForAllViews(
        oldPointCount: number,
        newPointCount: number,
        defaultVisible: boolean,
    ): void {
        const next: Record<string, boolean[]> = {};
        Object.entries(this.segmentVisibleByView).forEach(([viewKey, flags]) => {
            next[viewKey] = this.padFlags(flags, oldPointCount, newPointCount, defaultVisible);
        });
        CAMERA_VIEW_KEYS.forEach((viewKey) => {
            if (!next[viewKey]) {
                next[viewKey] = this.padFlags([], oldPointCount, newPointCount, defaultVisible);
            }
        });
        this.segmentVisibleByView = next;
        const nextForceVisible: Record<string, boolean[]> = {};
        CAMERA_VIEW_KEYS.forEach((viewKey) => {
            nextForceVisible[viewKey] = this.padFlags(
                this.segmentForceVisibleByView[viewKey],
                oldPointCount,
                newPointCount,
                false,
            );
        });
        this.segmentForceVisibleByView = nextForceVisible;
    }

    raycast(raycaster: THREE.Raycaster, intersects: Intersect[]): void {
        super.raycast(raycaster, intersects as THREE.Intersection[]);
        if (this.hiddenLine.visible) {
            this.hiddenLine.raycast(raycaster, intersects as THREE.Intersection[]);
        }
    }

    setColor(color: THREE.ColorRepresentation): void {
        this.color.set(color);
        (this.material as THREE.LineBasicMaterial).color.copy(this.color);
        (this.wallMesh.material as THREE.MeshBasicMaterial).color.copy(this.color);
        (this.topLine.material as THREE.LineBasicMaterial).color.copy(this.color);
    }

    private remapAllViewSegmentVisible(oldPointCount: number, newPointCount: number): void {
        const next: Record<string, boolean[]> = {};
        Object.entries(this.segmentVisibleByView).forEach(([viewKey, flags]) => {
            next[viewKey] = this.remapFlagsForPointCount(flags, oldPointCount, newPointCount);
        });
        this.segmentVisibleByView = next;
        const nextForceVisible: Record<string, boolean[]> = {};
        Object.entries(this.segmentForceVisibleByView).forEach(([viewKey, flags]) => {
            nextForceVisible[viewKey] = this.remapFlagsForPointCount(
                flags,
                oldPointCount,
                newPointCount,
                false,
            );
        });
        this.segmentForceVisibleByView = nextForceVisible;
        if (this.bevSegmentVisible.length > 0) {
            this.bevSegmentVisible = this.remapFlagsForPointCount(
                this.bevSegmentVisible,
                oldPointCount,
                newPointCount,
            );
        }
    }

    private normalizeSegmentVisible(flags: boolean[] | undefined): boolean[] {
        const segmentCount = Math.max(0, this.points3D.length - 1);
        const normalized = Array.from({ length: segmentCount }, () => true);
        if (!flags) {
            return normalized;
        }
        for (let index = 0; index < segmentCount; index++) {
            if (typeof flags[index] === 'boolean') {
                normalized[index] = flags[index];
            }
        }
        return normalized;
    }

    private normalizeSegmentForceVisible(flags: boolean[] | undefined): boolean[] {
        return this.normalizeSegmentVisibleForCount(flags, this.points3D.length, false);
    }

    private remapFlagsForPointCount(
        flags: boolean[] | undefined,
        oldPointCount: number,
        newPointCount: number,
        defaultValue: boolean = true,
    ): boolean[] {
        const normalized = this.normalizeSegmentVisibleForCount(
            flags,
            oldPointCount,
            defaultValue,
        );
        if (newPointCount < 2) {
            return [];
        }
        if (newPointCount > oldPointCount) {
            return this.padFlags(
                normalized,
                oldPointCount,
                newPointCount,
                normalized.at(-1) ?? defaultValue,
            );
        }
        let next = [...normalized];
        let currentPointCount = oldPointCount;
        while (currentPointCount > newPointCount && next.length > Math.max(0, newPointCount - 1)) {
            const removeIndex = Math.max(1, Math.min(next.length - 1, newPointCount - 1));
            const mergedVisible = (next[removeIndex - 1] ?? true) && (next[removeIndex] ?? true);
            next.splice(removeIndex - 1, 2, mergedVisible);
            currentPointCount -= 1;
        }
        return this.normalizeSegmentVisibleForCount(next, newPointCount, defaultValue);
    }

    private splitSegmentFlags(
        byView: Record<string, boolean[]>,
        pointCount: number,
        segmentIndex: number,
        defaultValue: boolean = true,
    ): Record<string, boolean[]> {
        return Object.fromEntries(
            Object.entries(byView).map(([viewKey, flags]) => [
                viewKey,
                this.splitFlags(flags, pointCount, segmentIndex, defaultValue),
            ]),
        );
    }

    private splitFlags(
        flags: boolean[] | undefined,
        pointCount: number,
        segmentIndex: number,
        defaultValue: boolean = true,
    ): boolean[] {
        const normalized = this.normalizeSegmentVisibleForCount(flags, pointCount, defaultValue);
        const segmentVisible = normalized[segmentIndex] ?? defaultValue;
        normalized.splice(segmentIndex, 1, segmentVisible, segmentVisible);
        return normalized;
    }

    private normalizeSegmentVisibleForCount(
        flags: boolean[] | undefined,
        pointCount: number,
        defaultValue: boolean = true,
    ): boolean[] {
        const segmentCount = Math.max(0, pointCount - 1);
        const normalized = Array.from({ length: segmentCount }, () => defaultValue);
        if (!flags) {
            return normalized;
        }
        for (let index = 0; index < segmentCount; index++) {
            if (typeof flags[index] === 'boolean') {
                normalized[index] = flags[index];
            }
        }
        return normalized;
    }

    private padFlags(
        flags: boolean[] | undefined,
        oldPointCount: number,
        newPointCount: number,
        defaultVisible: boolean,
    ): boolean[] {
        const next = this.normalizeSegmentVisibleForCount(flags, oldPointCount);
        const targetCount = Math.max(0, newPointCount - 1);
        while (next.length < targetCount) {
            next.push(defaultVisible);
        }
        return next;
    }

    private rebuildLineGeometry(segmentVisible: boolean[]): void {
        const segmentCount = Math.max(0, this.points3D.length - 1);
        const points = this.points3D.slice(0, -1).flatMap((start, index) => [
            start.clone(),
            this.points3D[index + 1].clone(),
        ]);
        this.geometry.setFromPoints(points);
        this.hiddenLine.visible = false;
    }

    private rebuildWallGeometry(): void {
        const segmentCount = Math.max(0, this.points3D.length - 1);
        if (this.wallHeight <= 0 || segmentCount === 0) {
            this.wallMesh.visible = false;
            this.topLine.visible = false;
            return;
        }
        const vertices: number[] = [];
        const topPoints: THREE.Vector3[] = [];
        for (let index = 0; index < segmentCount; index++) {
            const start = this.points3D[index];
            const end = this.points3D[index + 1];
            const startTop = start.clone();
            const endTop = end.clone();
            startTop.z += this.wallHeight;
            endTop.z += this.wallHeight;
            vertices.push(
                start.x, start.y, start.z,
                end.x, end.y, end.z,
                endTop.x, endTop.y, endTop.z,
                start.x, start.y, start.z,
                endTop.x, endTop.y, endTop.z,
                startTop.x, startTop.y, startTop.z,
            );
            topPoints.push(startTop, endTop);
        }
        this.wallMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        this.wallMesh.geometry.computeBoundingSphere();
        this.topLine.geometry.setFromPoints(topPoints);
        this.topLine.geometry.computeBoundingSphere();
        this.wallMesh.visible = true;
        this.topLine.visible = true;
    }
}
