import * as THREE from 'three';
import { AnnotateType, Intersect } from '../type';
import { ObjectType } from 'pc-editor';

const HIDDEN_LINE_COLOR = 0x888888;
const CAMERA_VIEW_KEYS = ['0', '1', '2', '3'];

export default class GroundPolyline extends THREE.Line {
    annotateType = AnnotateType.ANNOTATE_3D;
    objectType = ObjectType.TYPE_GROUND_POLYLINE;
    color = new THREE.Color();
    readonly points3D: THREE.Vector3[] = [];
    segmentVisibleByView: Record<string, boolean[]> = {};
    private bevSegmentVisible: boolean[] = [];
    private readonly hiddenLine: THREE.Line;

    constructor(points: THREE.Vector3[]) {
        super(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ toneMapped: false }));
        this.type = 'GroundPolyline';
        this.hiddenLine = new THREE.Line(
            new THREE.BufferGeometry(),
            new THREE.LineDashedMaterial({
                color: HIDDEN_LINE_COLOR,
                dashSize: 0.4,
                gapSize: 0.25,
                toneMapped: false,
                transparent: true,
                opacity: 0.75,
            }),
        );
        this.hiddenLine.visible = false;
        this.add(this.hiddenLine);
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
        this.geometry.computeBoundingBox();
        this.geometry.computeBoundingSphere();
    }

    setSegmentVisibleByView(byView: Record<string, boolean[]>): void {
        this.segmentVisibleByView = {};
        Object.entries(byView).forEach(([viewKey, flags]) => {
            this.segmentVisibleByView[viewKey] = flags.slice();
        });
    }

    getSegmentVisibleForView(viewKey: string): boolean[] {
        return this.normalizeSegmentVisible(this.segmentVisibleByView[viewKey]);
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
    }

    raycast(raycaster: THREE.Raycaster, intersects: Intersect[]): void {
        super.raycast(raycaster, intersects as THREE.Intersection[]);
    }

    setColor(color: THREE.ColorRepresentation): void {
        this.color.set(color);
        (this.material as THREE.LineBasicMaterial).color.copy(this.color);
    }

    private remapAllViewSegmentVisible(oldPointCount: number, newPointCount: number): void {
        const next: Record<string, boolean[]> = {};
        Object.entries(this.segmentVisibleByView).forEach(([viewKey, flags]) => {
            next[viewKey] = this.remapFlagsForPointCount(flags, oldPointCount, newPointCount);
        });
        this.segmentVisibleByView = next;
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

    private remapFlagsForPointCount(
        flags: boolean[] | undefined,
        oldPointCount: number,
        newPointCount: number,
    ): boolean[] {
        const normalized = this.normalizeSegmentVisibleForCount(flags, oldPointCount);
        if (newPointCount < 2) {
            return [];
        }
        if (newPointCount > oldPointCount) {
            return this.padFlags(normalized, oldPointCount, newPointCount, normalized.at(-1) ?? true);
        }
        let next = [...normalized];
        let currentPointCount = oldPointCount;
        while (currentPointCount > newPointCount && next.length > Math.max(0, newPointCount - 1)) {
            const removeIndex = Math.max(1, Math.min(next.length - 1, newPointCount - 1));
            const mergedVisible = (next[removeIndex - 1] ?? true) && (next[removeIndex] ?? true);
            next.splice(removeIndex - 1, 2, mergedVisible);
            currentPointCount -= 1;
        }
        return this.normalizeSegmentVisibleForCount(next, newPointCount);
    }

    private normalizeSegmentVisibleForCount(
        flags: boolean[] | undefined,
        pointCount: number,
    ): boolean[] {
        const segmentCount = Math.max(0, pointCount - 1);
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
        const flags = this.normalizeSegmentVisible(segmentVisible);
        const hasHiddenSegments =
            segmentCount > 0 && flags.length === segmentCount && flags.some((visible) => !visible);

        if (!hasHiddenSegments) {
            this.geometry.setFromPoints(this.points3D);
            this.hiddenLine.visible = false;
            return;
        }

        const visiblePoints: THREE.Vector3[] = [];
        const hiddenPoints: THREE.Vector3[] = [];
        for (let index = 0; index < segmentCount; index++) {
            const start = this.points3D[index];
            const end = this.points3D[index + 1];
            const target = flags[index] ? visiblePoints : hiddenPoints;
            if (target.length === 0 || !target[target.length - 1].equals(start)) {
                target.push(start.clone());
            }
            target.push(end.clone());
        }

        this.geometry.setFromPoints(visiblePoints.length >= 2 ? visiblePoints : this.points3D);
        if (hiddenPoints.length >= 2) {
            this.hiddenLine.geometry.setFromPoints(hiddenPoints);
            this.hiddenLine.computeLineDistances();
            this.hiddenLine.visible = true;
        } else {
            this.hiddenLine.visible = false;
        }
    }
}
