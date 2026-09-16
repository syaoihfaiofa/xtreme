import * as THREE from 'three';
import MainRenderView from '../renderView/MainRenderView';
import Image2DRenderView from '../renderView/Image2DRenderView';
import {
    Rect,
    Box2D,
    Object2D,
    AnnotateObject,
    ProjectedPolygon,
    ProjectedPolyline,
    ProjectedIrregularWall,
} from '../objects';
import Box from '../objects/Box';
import GroundPolygon from '../objects/GroundPolygon';
import GroundPolyline from '../objects/GroundPolyline';
import IrregularWall from '../objects/IrregularWall';
import { Event } from '../config';
import Action from './Action';
import { get } from '../utils/tempVar';
import * as _ from 'lodash';

export default class SelectAction extends Action {
    static actionName: string = 'select';
    renderView: MainRenderView | Image2DRenderView;

    private _time: number = 0;
    private _mouseDown: boolean = false;
    private _clickValid: boolean = false;
    private _mouseDownPos: THREE.Vector2 = new THREE.Vector2();
    private raycaster: THREE.Raycaster = new THREE.Raycaster();
    private clickHandler: _.DebouncedFunc<(event: MouseEvent) => void>;

    constructor(renderView: MainRenderView | Image2DRenderView) {
        super();
        this.renderView = renderView;
        this.enabled = true;

        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        // this.onDBLClick = this.onDBLClick.bind(this);
        this.clickHandler = _.debounce(this.onClick.bind(this), 500, {
            leading: true,
            trailing: false,
        });
    }
    init() {
        let dom = this.renderView.container;
        this._mouseDown = false;
        this._mouseDownPos = new THREE.Vector2();

        dom.addEventListener('mousedown', this.onMouseDown);
        dom.addEventListener('mouseup', this.onMouseUp);
        // dom.addEventListener('dblclick', this.onDBLClick);
        dom.addEventListener('click', this.clickHandler);
    }

    destroy(): void {
        const dom = this.renderView.container;
        dom.removeEventListener('mousedown', this.onMouseDown);
        dom.removeEventListener('mouseup', this.onMouseUp);
        dom.removeEventListener('click', this.clickHandler);
        this.clickHandler.cancel();
        this._mouseDown = false;
        this._clickValid = false;
    }

    onDBLClick(event: MouseEvent) {
        let object = this.getObject(event);
        if (object) {
            event.stopPropagation();

            this.renderView.pointCloud.dispatchEvent({
                type: Event.OBJECT_DBLCLICK,
                data: object,
            });
        }
        // console.log('onDBLClick');
    }
    onSelect() {}
    onClick(event: MouseEvent) {
        if (!this.enabled || !this._clickValid) return;

        // console.log('onClick');
        let object = this.getObject(event);
        if (object) {
            this.selectObject(object as any);
            this.onSelect();
        }
    }

    onMouseDown(event: MouseEvent) {
        if (!this.enabled) return;

        this._mouseDown = true;
        this._mouseDownPos.set(event.offsetX, event.offsetY);
    }
    onMouseUp(event: MouseEvent) {
        if (!this.enabled) return;

        let tempVec2 = new THREE.Vector2();
        let distance = tempVec2.set(event.offsetX, event.offsetY).distanceTo(this._mouseDownPos);
        this._clickValid = this._mouseDown && distance < 10;
        this._mouseDown = false;
    }

    getObject(event: MouseEvent) {
        let object;
        if (this.renderView instanceof MainRenderView) {
            object = this.checkMainView(event);
        } else {
            object = this.checkImage2DView(event);
        }

        return object;
    }

    checkMainView(event: MouseEvent) {
        let pos = get(THREE.Vector2, 0);
        this.getProjectPos(event, pos);
        let annotate3D = this.renderView.pointCloud
            .getAnnotate3D()
            .filter((object) => object.visible !== false);

        this.raycaster.setFromCamera(pos, this.renderView.camera);
        const intersects = this.raycaster.intersectObjects(annotate3D);
        // console.log(intersects);
        if (intersects.length > 0) {
            return this.resolveAnnotateRoot(intersects[0].object);
            // this.selectObject(intersects[0].object as any);
        }
    }

    checkImage2DView(event: MouseEvent) {
        // debugger;
        let renderView = this.renderView as Image2DRenderView;
        let imgSize = renderView.imgSize;

        let findObject;
        let imgPos = get(THREE.Vector2, 0).set(event.offsetX, event.offsetY);
        // 转换到图片坐标系
        renderView.domToImg(imgPos);
        // tempPos.x = ((pos.x + 1) / 2) * imgSize.x;
        // tempPos.y = ((-pos.y + 1) / 2) * imgSize.y;

        if (
            !findObject &&
            (renderView.renderRect || renderView.renderBox2D || renderView.renderProjectedGround)
        ) {
            let annotate2D = renderView.get2DObject();
            let obj;
            for (let i = annotate2D.length - 1; i >= 0; i--) {
                obj = annotate2D[i];

                if (obj.visible !== false && renderView.isRenderable(obj) && obj.isContainPosition(imgPos)) {
                    findObject = obj;
                    break;
                }
            }
        }

        if (!findObject && renderView.renderBox) {
            let annotate3D = renderView.get3DObject().filter((object) => object.visible !== false);
            let projectPos = get(THREE.Vector2, 1).copy(imgPos);
            this.getProjectImgPos(projectPos);
            this.raycaster.setFromCamera(projectPos, this.renderView.camera);

            let intersects = this.raycaster.intersectObjects(annotate3D);
            findObject = intersects.length > 0 ? this.resolveAnnotateRoot(intersects[0].object) : null;
        }

        return findObject;
    }

    selectObject(object?: AnnotateObject) {
        // A projected ground shape is only the image representation. Keep its
        // canonical 3D source selected as well so the main/side views retain the
        // active target and toolbar actions such as Reproject operate on it.
        if (
            this.renderView instanceof Image2DRenderView &&
            (object instanceof Rect || object instanceof Box2D)
        ) {
            const source = this.resolveProjectedBoxSource(object);
            if (source) {
                object.userData.projectedFromId = source.uuid;
                this.renderView.pointCloud.selectObject([source, object]);
                return;
            }
        }
        if (
            this.renderView instanceof Image2DRenderView &&
            (object instanceof ProjectedPolygon ||
                object instanceof ProjectedPolyline ||
                object instanceof ProjectedIrregularWall)
        ) {
            const source = this.resolveProjectedGroundSource(object);
            if (source) {
                // Older annotations may not have persisted their source link.
                // Repair it once a unique source has been identified, so later
                // edits/reprojection use the direct, deterministic relationship.
                object.userData.projectedFromId = source.uuid;
                this.renderView.pointCloud.selectObject([source, object]);
                return;
            }
        }
        this.renderView.pointCloud.selectObject(object);
    }

    private resolveProjectedBoxSource(projection: Rect | Box2D): Box | undefined {
        const sourceId = projection.userData?.projectedFromId;
        const trackId = projection.userData?.trackId;
        const connectId = projection.connectId;
        const sources = this.renderView.pointCloud
            .getAnnotate3D()
            .filter((candidate): candidate is Box => candidate instanceof Box);
        const linked = sources.find(
            (candidate) =>
                candidate.uuid === sourceId ||
                (!!trackId && candidate.userData?.trackId === trackId) ||
                (connectId !== undefined && candidate.id === connectId),
        );
        if (linked) return linked;
        if (sources.length === 1) return sources[0];

        // Historical 2D box projections did not persist a source id. Reproject
        // each 3D box through this exact camera and accept only a close, unique
        // geometric match; this works for every class, including untracked ones.
        const scored = sources
            .map((candidate) => ({ candidate, error: this.getBoxProjectionError(projection, candidate) }))
            .filter((item) => Number.isFinite(item.error))
            .sort((left, right) => left.error - right.error);
        if (!scored.length || scored[0].error > 24) return undefined;
        if (scored.length > 1 && scored[1].error - scored[0].error < 4) return undefined;
        return scored[0].candidate;
    }

    private getBoxProjectionError(projection: Rect | Box2D, box: Box): number {
        const view = this.renderView as Image2DRenderView;
        if (projection instanceof Rect) {
            const expected = view.getBoxRect(box);
            return expected.center.distanceTo(projection.center) +
                expected.size.distanceTo(projection.size) * 0.5;
        }
        const expected = view.getBox2DBox(box);
        const direct = expected.positionsFront.reduce(
            (sum, point, index) => sum + point.distanceTo(projection.positions1[index]) +
                expected.positionsBack[index].distanceTo(projection.positions2[index]),
            0,
        ) / 8;
        const swapped = expected.positionsFront.reduce(
            (sum, point, index) => sum + point.distanceTo(projection.positions2[index]) +
                expected.positionsBack[index].distanceTo(projection.positions1[index]),
            0,
        ) / 8;
        return Math.min(direct, swapped);
    }

    private resolveProjectedGroundSource(
        projection: ProjectedPolygon | ProjectedPolyline | ProjectedIrregularWall,
    ): GroundPolygon | GroundPolyline | IrregularWall | undefined {
        const sourceId = projection.userData?.projectedFromId;
        const trackId = projection.userData?.trackId;
        const sources = this.renderView.pointCloud.getAnnotate3D().filter(
            (candidate): candidate is GroundPolygon | GroundPolyline | IrregularWall =>
                candidate.visible !== false &&
                ((projection instanceof ProjectedPolygon && candidate instanceof GroundPolygon) ||
                    (projection instanceof ProjectedPolyline && candidate instanceof GroundPolyline) ||
                    (projection instanceof ProjectedIrregularWall && candidate instanceof IrregularWall)),
        );
        const linked = sources.find(
            (candidate) =>
                candidate.uuid === sourceId ||
                (!!trackId && candidate.userData?.trackId === trackId),
        );
        if (linked) return linked;

        // A few older data sets have neither linking field.  Use the actual
        // image geometry only when it identifies one unambiguous source.  This
        // keeps an unrelated projected line from selecting a nearby 3D wall.
        const projectionPoints = projection instanceof ProjectedIrregularWall
            ? [...projection.bottomPoints, ...projection.topPoints]
            : projection.points;
        const geometricallyMatching = sources.filter((candidate) => {
            const sourcePoints = candidate instanceof IrregularWall
                ? [...candidate.bottomPoints, ...candidate.topPoints]
                : candidate.points3D;
            if (sourcePoints.length !== projectionPoints.length || sourcePoints.length === 0) return false;
            const totalDistance = sourcePoints.reduce((total, point, index) => {
                const imagePoint = this.renderView.worldToImg(point.clone());
                return total + imagePoint.distanceTo(projectionPoints[index]);
            }, 0);
            return totalDistance / sourcePoints.length <= 12;
        });
        return geometricallyMatching.length === 1 ? geometricallyMatching[0] : undefined;
    }

    private resolveAnnotateRoot(object: THREE.Object3D): AnnotateObject | undefined {
        let current: THREE.Object3D | null = object;
        while (current) {
            if (
                current instanceof Box ||
                current instanceof GroundPolygon ||
                current instanceof GroundPolyline ||
                current instanceof IrregularWall
            ) {
                return current;
            }
            current = current.parent;
        }
        return undefined;
    }

    getProjectImgPos(pos: THREE.Vector2, target?: THREE.Vector2) {
        let renderView = this.renderView as Image2DRenderView;
        let { imgSize } = renderView;

        target = target || pos;
        target.x = (pos.x / imgSize.x) * 2 - 1;
        target.y = (-pos.y / imgSize.y) * 2 + 1;
        return target;
    }

    getProjectPos(event: MouseEvent, pos?: THREE.Vector2) {
        let x = (event.offsetX / this.renderView.width) * 2 - 1;
        let y = (-event.offsetY / this.renderView.height) * 2 + 1;

        pos = pos || new THREE.Vector2();
        pos.set(x, y);
        return pos;
    }
}
