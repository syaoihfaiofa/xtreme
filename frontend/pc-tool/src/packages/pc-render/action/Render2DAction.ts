import * as THREE from 'three';
import Image2DRenderView from '../renderView/Image2DRenderView';
import { Event } from '../config';
import Action from './Action';
import { Object2D, Rect, Box2D, Box } from '../objects';
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
                } else {
                    this.renderBox2D(obj as Box2D, lineWidth);
                }
            }
        });
    }
}
