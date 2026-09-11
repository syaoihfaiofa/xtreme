import * as THREE from 'three';
import Image2DRenderView from '../renderView/Image2DRenderView';
import { Event } from '../config';
import Action from './Action';
import { Object2D, Rect, Box2D, Box, GroundPolygon, GroundPolyline, IrregularWall, ProjectedPolygon, ProjectedPolyline, ProjectedIrregularWall, AnnotateObject } from '../objects';
import { renderBox2D, renderRect } from '../utils';
import {
    getCameraViewKey,
    getRelevantViewKeysForPolyline,
    uniqueCameraViews,
} from '../utils/polylineProjection';

const SEGMENT_RENDER_SAMPLES = 16;
const HIDDEN_LINE_COLOR = '#ffe600';
const HIDDEN_LINE_OUTLINE_COLOR = '#111827';

function getViewKeyFromImageView(view: Image2DRenderView): string {
    if (view.visibilityViewKey) {
        return view.visibilityViewKey;
    }
    const viewId = view.renderId || view.id;
    const match = viewId.match(/[0-9]{1,5}$/);
    return match ? match[0] : viewId;
}

export default class Render2DAction extends Action {
    static actionName: string = 'render-2d-shape';
    renderView: Image2DRenderView;
    constructor(renderView: Image2DRenderView) {
        super();

        this.renderView = renderView;
        this.onRender = this.onRender.bind(this);
    }

    init() {
        this.renderView.addEventListener(Event.RENDER_AFTER, this.onRender);
    }
    destroy() {
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.onRender);
    }

    renderRect(obj: Rect, lineWidth: number) {
        let pointCloud = this.renderView.pointCloud;
        let { selectionMap } = pointCloud;
        let { context } = this.renderView.proxy;
        let selectColor = `#${pointCloud.selectColor.getHexString()}`;
        let color =
            selectionMap[obj.uuid] &&
            obj.userData?.occluded !== true &&
            obj.userData?.syncDirty !== true &&
            obj.userData?.reviewedCorrectVisible !== true
                ? selectColor
                : obj.color;
        let highFlag = this.renderView.isHighlight(obj);
        color = highFlag ? selectColor : color;

        renderRect(context, obj, { lineWidth: lineWidth, color });
    }

    renderBox2D(obj: Box2D, lineWidth: number) {
        let pointCloud = this.renderView.pointCloud;
        let { selectionMap } = pointCloud;
        let { context } = this.renderView.proxy;
        let selectColor = `#${pointCloud.selectColor.getHexString()}`;
        let color =
            selectionMap[obj.uuid] &&
            obj.userData?.occluded !== true &&
            obj.userData?.syncDirty !== true &&
            obj.userData?.reviewedCorrectVisible !== true
                ? selectColor
                : obj.color;
        let highFlag = this.renderView.isHighlight(obj);
        color = highFlag ? selectColor : color;

        if (this.renderView.isFisheye() && obj.userData?.isProjection) {
            // `connectId` is a runtime-only Three.js object id (never persisted), so it only
            // links a projected 2D shape to its source 3D box within the same session. Once the
            // frame is saved and reloaded all objects get fresh ids and the link breaks, silently
            // falling back to the stale, un-corrected shape below. `trackId` is persisted and
            // copied from the source box when the projection is created, so prefer matching on
            // that and only fall back to `connectId` for objects created before this fix.
            const trackId = obj.userData?.trackId;
            const box = this.renderView.get3DObject().find((object) => {
                if (!(object instanceof Box)) return false;
                if (trackId) return object.userData?.trackId === trackId;
                return object.id === obj.connectId;
            }) as Box | undefined;
            if (box) {
                const lines = this.renderView.getFisheyeBoxLines(box);
                const positions = ([] as THREE.Vector2[]).concat(...lines);
                if (positions.length > 0 && this.renderView.isFisheyeBoxVisible(positions)) {
                    this.renderView.renderFisheyeBoxLines(context, lines, color);
                    return;
                }
            }
        }

        renderBox2D(context, obj, { lineWidth: lineWidth, color });
    }
    renderProjectedPolygon(obj: ProjectedPolygon, lineWidth: number) {
        const pointCloud = this.renderView.pointCloud;
        const { context } = this.renderView.proxy;
        const selectColor = `#${pointCloud.selectColor.getHexString()}`;
        const color = pointCloud.selectionMap[obj.uuid] ? selectColor : obj.color;
        const points = obj.points;
        if (points.length !== 4) return;

        context.save();
        context.lineWidth = lineWidth;
        context.strokeStyle = color;
        context.beginPath();
        if (obj.edgePoints?.length === 4) {
            obj.edgePoints.forEach((edge) => {
                if (edge.length === 0) return;
                context.moveTo(edge[0].x, edge[0].y);
                edge.slice(1).forEach((point) => context.lineTo(point.x, point.y));
            });
        } else {
            context.moveTo(points[0].x, points[0].y);
            points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
            context.closePath();
        }
        context.stroke();

        // P3 -> P0 is the opening edge. The arrow points from the rear edge
        // centre to that opening so the direction remains unambiguous in every view.
        const rear = points[1].clone().add(points[2]).multiplyScalar(0.5);
        const opening = points[0].clone().add(points[3]).multiplyScalar(0.5);
        const direction = opening.clone().sub(rear);
        if (direction.lengthSq() > 0.000001) {
            const arrowLength = Math.min(24 / this.renderView.getScale(), direction.length() * 0.35);
            direction.normalize();
            const arrowEnd = rear.clone().addScaledVector(direction, arrowLength);
            const perpendicular = new THREE.Vector2(-direction.y, direction.x)
                .multiplyScalar(arrowLength * 0.3);
            context.lineWidth = lineWidth * 1.5;
            context.beginPath();
            context.moveTo(rear.x, rear.y);
            context.lineTo(arrowEnd.x, arrowEnd.y);
            context.moveTo(arrowEnd.x, arrowEnd.y);
            context.lineTo(
                arrowEnd.x - direction.x * arrowLength * 0.25 + perpendicular.x,
                arrowEnd.y - direction.y * arrowLength * 0.25 + perpendicular.y,
            );
            context.moveTo(arrowEnd.x, arrowEnd.y);
            context.lineTo(
                arrowEnd.x - direction.x * arrowLength * 0.25 - perpendicular.x,
                arrowEnd.y - direction.y * arrowLength * 0.25 - perpendicular.y,
            );
            context.stroke();
        }
        context.restore();
    }
    renderGroundPolygonProjection(obj: GroundPolygon, lineWidth: number) {
        const points = obj.points3D.map((point) => {
            const projected = this.renderView.worldToImg(point.clone());
            return new THREE.Vector2(projected.x, projected.y);
        });
        const visible = points.some(
            (point) =>
                Number.isFinite(point.x) &&
                Number.isFinite(point.y) &&
                point.x >= 0 &&
                point.x <= this.renderView.imgSize.x &&
                point.y >= 0 &&
                point.y <= this.renderView.imgSize.y,
        );
        if (!visible) return;
        const projection = new ProjectedPolygon(points);
        projection.color = `#${obj.color.getHexString()}`;
        if (this.renderView.isFisheye()) {
            projection.edgePoints = obj.points3D.map((point, index) => {
                const next = obj.points3D[(index + 1) % 4];
                return Array.from({ length: 9 }, (_, sampleIndex) => {
                    const projected = this.renderView.worldToImg(
                        point.clone().lerp(next, sampleIndex / 8),
                    );
                    return new THREE.Vector2(projected.x, projected.y);
                });
            });
        }
        this.renderProjectedPolygon(projection, lineWidth);
    }
    renderGroundPolylineProjection(obj: GroundPolyline, lineWidth: number) {
        const viewKey = getViewKeyFromImageView(this.renderView);
        this.renderPolylineSegments(
            obj.points3D,
            (point) => {
                const value = this.renderView.worldToImg(point.clone());
                return new THREE.Vector2(value.x, value.y);
            },
            `#${obj.color.getHexString()}`,
            lineWidth,
            obj.getSegmentVisibleForView(viewKey),
            obj.getSegmentForceVisibleForView(viewKey),
            this.renderView.isFisheye(),
        );
    }
    renderProjectedPolyline(obj: ProjectedPolyline, lineWidth: number) {
        if (obj.points.length < 2) return;
        const source = this.findSourceGroundPolyline(obj);
        const pointCloud = this.renderView.pointCloud;
        const selected = pointCloud.selectionMap[obj.uuid] || (source && pointCloud.selectionMap[source.uuid]);
        const color = selected
            ? `#${pointCloud.selectColor.getHexString()}`
            : obj.color;
        const viewKey = getViewKeyFromImageView(this.renderView);
        const segmentVisible = source
            ? source.getSegmentVisibleForView(viewKey)
            : undefined;
        const segmentForceVisible = source
            ? source.getSegmentForceVisibleForView(viewKey)
            : undefined;
        if (source && this.renderView.isFisheye()) {
            this.renderGroundPolylineHeightPlane(source, obj, color, lineWidth);
            this.renderPolylineSegments(
                source.points3D,
                (point) => {
                    const value = this.renderView.worldToImg(point.clone());
                    return new THREE.Vector2(value.x, value.y);
                },
                color,
                lineWidth * 2,
                segmentVisible,
                segmentForceVisible,
                true,
                obj.points,
            );
            return;
        }
        this.renderGroundPolylineHeightPlane(source, obj, color, lineWidth);
        this.renderPolylineSegments(
            obj.points,
            (point) => point.clone(),
            color,
            lineWidth * 2,
            segmentVisible,
            segmentForceVisible,
            false,
            undefined,
            source?.points3D,
        );
    }

    private renderGroundPolylineHeightPlane(
        source: GroundPolyline | null,
        projection: ProjectedPolyline,
        color: string,
        lineWidth: number,
    ): void {
        if (!source || source.wallHeight <= 0 || projection.points.length < 2) return;
        const top = source.points3D.map((point) => {
            const world = point.clone();
            world.z += source.wallHeight;
            const image = this.renderView.worldToImg(world);
            return new THREE.Vector2(image.x, image.y);
        });
        if (top.length !== projection.points.length) return;
        this.renderFlatWallFace(projection.points, top, color);
        this.renderPolylineSegments(top, (point) => point.clone(), color, lineWidth * 1.5, undefined, undefined, false);
        if (this.renderView.isFisheye()) {
            this.renderFisheyeSideEdge(
                source.points3D[0],
                source.points3D[0].clone().add(new THREE.Vector3(0, 0, source.wallHeight)),
                color,
                lineWidth,
            );
            this.renderFisheyeSideEdge(
                source.points3D.at(-1)!,
                source.points3D.at(-1)!.clone().add(new THREE.Vector3(0, 0, source.wallHeight)),
                color,
                lineWidth,
            );
        }
    }

    renderProjectedIrregularWall(obj: ProjectedIrregularWall, lineWidth: number) {
        const pointCloud = this.renderView.pointCloud;
        const source = this.findSourceIrregularWall(obj);
        const selected =
            pointCloud.selectionMap[obj.uuid] || (source && pointCloud.selectionMap[source.uuid]);
        const color = selected ? `#${pointCloud.selectColor.getHexString()}` : obj.color;
        const renderBoundary = (stored: THREE.Vector2[], world?: THREE.Vector3[]) => {
            if (source && world && this.renderView.isFisheye()) {
                this.renderPolylineSegments(
                    world,
                    (point) => {
                        const value = this.renderView.worldToImg(point.clone());
                        return new THREE.Vector2(value.x, value.y);
                    },
                    color,
                    lineWidth * 2,
                    undefined,
                    undefined,
                    true,
                    stored,
                );
                return;
            }
            this.renderPolylineSegments(
                stored,
                (point) => point.clone(),
                color,
                lineWidth * 2,
                undefined,
                undefined,
                false,
            );
        };

        if (obj.bottomPoints.length >= 2 && obj.topPoints.length >= 2) {
            const topReversed = source
                ? this.isIrregularWallTopReversed(source.bottomPoints, source.topPoints)
                : this.isIrregularWallTopReversed(obj.bottomPoints, obj.topPoints);
            this.renderFlatWallFace(
                obj.bottomPoints,
                topReversed ? [...obj.topPoints].reverse() : obj.topPoints,
                color,
            );
            if (source && this.renderView.isFisheye()) {
                const alignedTop = topReversed ? [...source.topPoints].reverse() : source.topPoints;
                if (alignedTop.length >= 2) {
                    this.renderFisheyeSideEdge(source.bottomPoints[0], alignedTop[0], color, lineWidth);
                    this.renderFisheyeSideEdge(
                        source.bottomPoints.at(-1)!,
                        alignedTop.at(-1)!,
                        color,
                        lineWidth,
                    );
                }
            }
        }
        renderBoundary(obj.bottomPoints, source?.bottomPoints);
        renderBoundary(obj.topPoints, source?.topPoints);
    }

    private renderFlatWallFace(bottom: THREE.Vector2[], top: THREE.Vector2[], color: string): void {
        if (bottom.length < 2 || top.length < 2) return;
        const { context } = this.renderView.proxy;
        context.save();
        context.fillStyle = color;
        context.globalAlpha = 0.18;
        context.beginPath();
        context.moveTo(bottom[0].x, bottom[0].y);
        bottom.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        [...top].reverse().forEach((point) => context.lineTo(point.x, point.y));
        context.closePath();
        context.fill();
        context.restore();
    }

    private renderFisheyeSideEdge(
        bottom: THREE.Vector3,
        top: THREE.Vector3,
        color: string,
        lineWidth: number,
    ): void {
        this.renderPolylineSegments(
            [bottom, top],
            (point) => {
                const image = this.renderView.worldToImg(point.clone());
                return new THREE.Vector2(image.x, image.y);
            },
            color,
            lineWidth,
            undefined,
            undefined,
            true,
        );
    }

    private isIrregularWallTopReversed(
        bottom: Array<THREE.Vector2 | THREE.Vector3>,
        top: Array<THREE.Vector2 | THREE.Vector3>,
    ): boolean {
        const distance = (
            first: THREE.Vector2 | THREE.Vector3,
            second: THREE.Vector2 | THREE.Vector3,
        ) => Math.hypot(
            first.x - second.x,
            first.y - second.y,
            ('z' in first ? first.z : 0) - ('z' in second ? second.z : 0),
        );
        const direct = distance(bottom[0], top[0]) +
            distance(bottom.at(-1)!, top.at(-1)!);
        const reversed = distance(bottom[0], top.at(-1)!) +
            distance(bottom.at(-1)!, top[0]);
        return reversed < direct;
    }

    private findSourceGroundPolyline(obj: ProjectedPolyline): GroundPolyline | null {
        const sourceId = obj.userData?.projectedFromId as string | undefined;
        const trackId = obj.userData?.trackId as string | undefined;
        const source = (this.renderView.pointCloud
            .getAnnotate3D() as AnnotateObject[])
            .find((object) =>
                object instanceof GroundPolyline &&
                (object.uuid === sourceId || (!!trackId && object.userData?.trackId === trackId)),
            );
        if (source instanceof GroundPolyline) obj.userData.projectedFromId = source.uuid;
        return source instanceof GroundPolyline ? source : null;
    }

    private findSourceIrregularWall(obj: ProjectedIrregularWall): IrregularWall | null {
        const sourceId = obj.userData?.projectedFromId as string | undefined;
        const trackId = obj.userData?.trackId as string | undefined;
        const source = (this.renderView.pointCloud
            .getAnnotate3D() as AnnotateObject[])
            .find((object) =>
                object instanceof IrregularWall &&
                (object.uuid === sourceId || (!!trackId && object.userData?.trackId === trackId)),
            );
        if (source instanceof IrregularWall) obj.userData.projectedFromId = source.uuid;
        return source instanceof IrregularWall ? source : null;
    }

    private renderPolylineSegments(
        points: THREE.Vector3[] | THREE.Vector2[],
        project: (point: any) => THREE.Vector2,
        color: string,
        lineWidth: number,
        segmentVisible: boolean[] | undefined,
        segmentForceVisible: boolean[] | undefined,
        useFisheyeSampling: boolean,
        endpointOverrides?: THREE.Vector2[],
        sourcePoints3D?: THREE.Vector3[],
    ): void {
        if (points.length < 2) {
            return;
        }
        const { context } = this.renderView.proxy;
        const visibleEdges: Array<[THREE.Vector2, THREE.Vector2]> = [];
        context.save();
        const cameraViews = uniqueCameraViews(
            this.renderView.pointCloud.renderViews.filter(
                (view): view is Image2DRenderView => view instanceof Image2DRenderView,
            ),
        );
        const currentViewKey = getCameraViewKey(this.renderView);
        const relevancePoints =
            sourcePoints3D && sourcePoints3D.length >= 2
                ? sourcePoints3D
                : points[0] instanceof THREE.Vector3
                  ? (points as THREE.Vector3[])
                  : null;
        if (
            relevancePoints &&
            !getRelevantViewKeysForPolyline(relevancePoints, cameraViews).includes(currentViewKey)
        ) {
            context.restore();
            return;
        }
        context.lineCap = 'round';
        context.lineJoin = 'round';
        for (let index = 0; index < points.length - 1; index++) {
            let samples: THREE.Vector2[];
            if (points[index] instanceof THREE.Vector3) {
                const start = points[index] as THREE.Vector3;
                const end = points[index + 1] as THREE.Vector3;
                const sampleCount =
                    useFisheyeSampling || this.renderView.hasOcclusionMask()
                        ? SEGMENT_RENDER_SAMPLES
                        : 1;
                samples = Array.from({ length: sampleCount + 1 }, (_, sampleIndex) =>
                    project(start.clone().lerp(end, sampleIndex / sampleCount)),
                );
                if (endpointOverrides?.[index] && endpointOverrides[index + 1]) {
                    samples[0] = endpointOverrides[index];
                    samples[samples.length - 1] = endpointOverrides[index + 1];
                }
            } else {
                const start = points[index] as THREE.Vector2;
                const end = points[index + 1] as THREE.Vector2;
                const sampleCount = this.renderView.hasOcclusionMask()
                    ? SEGMENT_RENDER_SAMPLES
                    : 1;
                samples = Array.from({ length: sampleCount + 1 }, (_, sampleIndex) =>
                    start.clone().lerp(end, sampleIndex / sampleCount),
                );
            }
            for (let sampleIndex = 0; sampleIndex < samples.length - 1; sampleIndex++) {
                const start = samples[sampleIndex];
                const end = samples[sampleIndex + 1];
                if (
                    !Number.isFinite(start.x) ||
                    !Number.isFinite(start.y) ||
                    !Number.isFinite(end.x) ||
                    !Number.isFinite(end.y)
                ) {
                    continue;
                }
                // Occlusion is no longer part of the annotation workflow. Draw
                // every segment with its normal style instead of the former
                // yellow, enlarged hidden-segment treatment.
                visibleEdges.push([start, end]);
            }
        }
        const strokeEdges = (
            edges: Array<[THREE.Vector2, THREE.Vector2]>,
            strokeStyle: string,
            width: number,
        ): void => {
            if (edges.length === 0) {
                return;
            }
            context.beginPath();
            edges.forEach(([start, end]) => {
                context.moveTo(start.x, start.y);
                context.lineTo(end.x, end.y);
            });
            context.strokeStyle = strokeStyle;
            context.lineWidth = width;
            context.stroke();
        };
        strokeEdges(visibleEdges, color, lineWidth);
        context.restore();
    }

    getLineWidth() {
        let size = 1 / this.renderView.getScale();
        return size;
        // return Math.min(2, Math.max(0.5, size));
    }

    onRender() {
        let objects = this.renderView.get2DObject();
        let lineWidth = this.getLineWidth();
        this.renderView.setContextTransform();
        objects.forEach((obj) => {
            if (this.renderView.isRenderable(obj)) {
                if (obj instanceof Rect) {
                    this.renderRect(obj, lineWidth);
                } else if (obj instanceof ProjectedPolygon) {
                    this.renderProjectedPolygon(obj, lineWidth);
                } else if (obj instanceof ProjectedPolyline) {
                    this.renderProjectedPolyline(obj, lineWidth);
                } else if (obj instanceof ProjectedIrregularWall) {
                    this.renderProjectedIrregularWall(obj, lineWidth);
                } else {
                    this.renderBox2D(obj as Box2D, lineWidth);
                }
            }
        });
    }

}
