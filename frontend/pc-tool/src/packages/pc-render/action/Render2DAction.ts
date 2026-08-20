import * as THREE from 'three';
import Image2DRenderView from '../renderView/Image2DRenderView';
import { Event } from '../config';
import Action from './Action';
import { Object2D, Rect, Box2D, Box, GroundPolygon, GroundPolyline, ProjectedPolygon, ProjectedPolyline } from '../objects';
import { renderBox2D, renderRect } from '../utils';

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
        const project = (point: THREE.Vector3): THREE.Vector2 => {
            const value = this.renderView.worldToImg(point.clone());
            return new THREE.Vector2(value.x, value.y);
        };
        const points = obj.points3D.map(project);
        if (points.length < 2) return;
        const { context } = this.renderView.proxy;
        context.save();
        context.lineWidth = lineWidth;
        context.strokeStyle = `#${obj.color.getHexString()}`;
        context.beginPath();
        if (this.renderView.isFisheye()) {
            obj.points3D.slice(0, -1).forEach((point, index) => {
                const next = obj.points3D[index + 1];
                const samples = Array.from({ length: 9 }, (_, sampleIndex) =>
                    project(point.clone().lerp(next, sampleIndex / 8)),
                );
                context.moveTo(samples[0].x, samples[0].y);
                samples.slice(1).forEach((sample) => context.lineTo(sample.x, sample.y));
            });
        } else {
            context.moveTo(points[0].x, points[0].y);
            points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        }
        context.stroke();
        context.restore();
    }
    renderProjectedPolyline(obj: ProjectedPolyline, lineWidth: number) {
        if (obj.points.length < 2) return;
        const { context } = this.renderView.proxy;
        context.save();
        context.lineWidth = lineWidth;
        context.strokeStyle = obj.color;
        context.beginPath();
        context.moveTo(obj.points[0].x, obj.points[0].y);
        obj.points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        context.stroke();
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
                } else {
                    this.renderBox2D(obj as Box2D, lineWidth);
                }
            }
        });
    }
}
