import * as THREE from 'three';
import Image2DRenderView from '../renderView/Image2DRenderView';
import Action from './Action';
import { ITransform } from '../type';
import {
    Object2D,
    Rect,
    Box2D,
    Vector2Of4,
    GroundPolygon,
    ProjectedPolygon,
    ProjectedPolyline,
    ProjectedIrregularWall,
    GroundPolyline,
    IrregularWall,
} from '../objects';
import { Event } from '../config';
import { get } from '../utils/tempVar';
import { Info, RectTool, Box3DTool, ClearHandler, IBoxEvent, IRectEvent } from '../common/BasicSvg';
import { isLeft, isRight } from '../utils';
import * as _ from 'lodash';

let tempV2_1 = new THREE.Vector2();
let tempV2_2 = new THREE.Vector2();

export default class Edit2DAction extends Action {
    static actionName: string = 'edit-2d';
    renderView: Image2DRenderView;
    object: Object2D | null = null;
    rectTool: RectTool;
    boxTool: Box3DTool;
    onGroundProjectionPointChange?: (
        object: ProjectedPolygon | ProjectedPolyline,
        index: number,
        point: THREE.Vector2,
    ) => void;
    /** Invoked once when an image-plane ground-vertex drag finishes. */
    onGroundProjectionPointCommit?: (
        object: ProjectedPolygon | ProjectedPolyline,
        index: number,
        point: THREE.Vector2,
    ) => void;
    onIrregularWallProjectionPointChange?: (
        object: ProjectedIrregularWall,
        side: 'bottom' | 'top',
        index: number,
        point: THREE.Vector2,
    ) => void;
    // The active P vertex is selected in the 3D point-cloud view.  Image views
    // use it only for the visual highlight; the 3D shape remains the canonical
    // owner of the point.
    getSelectedGroundPolygonVertex?: () => { object: GroundPolygon; index: number } | undefined;
    //
    clearCall: ClearHandler[] = [];
    private readonly vertexHandleLayer: HTMLDivElement;
    private readonly vertexHandles: HTMLDivElement[] = [];
    private selectedGroundSource?: GroundPolygon | GroundPolyline | IrregularWall;
    private readonly onRender = () => {
        this.syncSelectedSourcePolygon();
        this.update();
    };
    private readonly onSelect = () => {
        let selection = this.renderView.pointCloud.selection;
        const projection = selection.find(
            (item) =>
                item instanceof ProjectedPolygon ||
                item instanceof ProjectedPolyline ||
                item instanceof ProjectedIrregularWall,
        ) as ProjectedPolygon | ProjectedPolyline | ProjectedIrregularWall | undefined;
        const source = selection.find(
            (item) =>
                item instanceof GroundPolygon ||
                item instanceof GroundPolyline ||
                item instanceof IrregularWall,
        ) as GroundPolygon | GroundPolyline | IrregularWall | undefined;
        this.selectedGroundSource = source;
        this.object = projection || (source ? this.getProjectionForSource(source) : null);
    };

    constructor(renderView: Image2DRenderView) {
        super();
        this.renderView = renderView;
        this.rectTool = new RectTool(renderView.container);
        this.boxTool = new Box3DTool(renderView.container);
        this.vertexHandleLayer = document.createElement('div');
        this.vertexHandleLayer.style.cssText =
            'position:absolute;inset:0;pointer-events:none;z-index:3;display:none;';
        renderView.container.appendChild(this.vertexHandleLayer);
        this.rectTool.setOption({
            rotateAble: false,
            circleStyle: {
                opacity: 1,
            },
        });
        this.boxTool.setOption({
            circleStyle: {
                opacity: 1,
            },
        });
    }

    init() {
        this.initRectDrop();
        this.initBoxDrop();
        this.renderView.addEventListener(Event.RENDER_AFTER, this.onRender);
        this.renderView.pointCloud.addEventListener(Event.SELECT, this.onSelect);
        // A maximized image view is created after the P object may already be
        // selected, so it will not necessarily receive a new SELECT event.
        this.onSelect();
    }

    destroy() {
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.onRender);
        this.renderView.pointCloud.removeEventListener(Event.SELECT, this.onSelect);
        this.clearCall.forEach((fn) => fn());
        this.clearCall = [];
        this.rectTool.destroy();
        this.boxTool.destroy();
        this.vertexHandleLayer.remove();
        this.object = null;
        this.selectedGroundSource = undefined;
    }

    initBoxDrop() {
        // let scaleSize = new THREE.Vector2();
        let renderView = this.renderView;
        // const onStart = (data: IBoxEvent) => {
        //     let { imgSize, width, height } = renderView;
        //     scaleSize.set(imgSize.x / width, imgSize.y / height);
        // };
        const onUpdate = _.throttle((data: IBoxEvent) => {
            // console.log('drop', data);
            if (!data.data) return;
            const {
                dir,
                info,
                data: { positions1, positions2 },
            } = data;
            if (!positions1 || !positions2) return;
            if (dir === 'front' || info === 'front-bg') {
                let posMap: Record<number, THREE.Vector2> = {};
                positions1.reduce(
                    (map: Record<number, THREE.Vector2>, pos: THREE.Vector2, index: number) => {
                        let copy = pos.clone();
                        renderView.domToImg(copy);
                        map[index] = copy;
                        return map;
                    },
                    posMap,
                );
                this.updateBox2DData('positions1', posMap);
            } else if (dir === 'back' || info === 'back-bg') {
                let posMap: Record<number, THREE.Vector2> = {};
                positions2.reduce(
                    (map: Record<number, THREE.Vector2>, pos: THREE.Vector2, index: number) => {
                        let copy = pos.clone();
                        renderView.domToImg(copy);
                        map[index] = copy;
                        return map;
                    },
                    posMap,
                );
                this.updateBox2DData('positions2', posMap);
            }
        }, 30);
        // this.boxTool.addEventListener('start', onStart);
        this.boxTool.addEventListener('update', onUpdate);

        // this.boxTool.box2DWrap.addEventListener('dblclick', (e: MouseEvent) => {
        //     if (this.object) {
        //         e.stopPropagation();

        //         this.renderView.pointCloud.dispatchEvent({
        //             type: Event.OBJECT_DBLCLICK,
        //             data: this.object,
        //         });
        //     }
        // });
    }

    validRect(center: THREE.Vector2, size: THREE.Vector2, moveOnly: boolean) {}

    initRectDrop() {
        // const scaleSize = new THREE.Vector2();

        // const onStart = (data: IRectEvent) => {
        //     let { imgSize, width, height } = this.renderView;
        //     scaleSize.set(imgSize.x / width, imgSize.y / height);
        // };
        const onUpdate = _.throttle((data: IRectEvent) => {
            if (!data.data) return;
            const { center, size } = data.data;
            if (!center || !size) return;

            // let { imgSize, width, height } = this.renderView;
            let scale = this.renderView.getScale();
            let newCenter = center.clone();
            let newScale = size.clone().multiplyScalar(1 / scale);
            this.renderView.domToImg(newCenter);
            this.validRect(newCenter, newScale, data.info === 'bg');

            this.updateRectData(newCenter, newScale);
        }, 30);

        // this.rectTool.addEventListener('start', onStart);
        this.rectTool.addEventListener('update', onUpdate);

        // this.rectTool.rectWrap.addEventListener('dblclick', () => {
        //     if (this.object) {
        //         this.renderView.pointCloud.dispatchEvent({
        //             type: Event.OBJECT_DBLCLICK,
        //             data: this.object,
        //         });
        //     }
        // });
    }
    update() {
        this.updateGroundProjectionVertexHandles();
        if (
            !this.isEnable() ||
            !this.object ||
            !this.renderView.isRenderable(this.object as Object2D)
        ) {
            this.rectTool.hide();
            this.boxTool.hide();
            return;
        }
        if (this.object instanceof Rect) {
            this.rectTool.show();
            this.boxTool.hide();
            this.updateRect();
        } else {
            if (
                this.object instanceof ProjectedPolygon ||
                this.object instanceof ProjectedPolyline ||
                this.object instanceof ProjectedIrregularWall
            ) {
                this.rectTool.hide();
                this.boxTool.hide();
                return;
            }
            this.boxTool.show();
            this.rectTool.hide();
            this.updateBox2D();
        }
    }
    updateBox2D() {
        let newPos = get(THREE.Vector2, 1);
        let { positions1, positions2 } = this.object as Box2D;
        // let { imgSize, width, height } = this.renderView;
        // const scaleSize = get(THREE.Vector2, 2).set(width, height).divide(imgSize);
        const circlePositions1: Vector2Of4 = this.boxTool.getEmptyVector2Of4();
        const circlePositions2: Vector2Of4 = this.boxTool.getEmptyVector2Of4();
        positions1.forEach((pos, index) => {
            newPos.copy(pos);
            this.renderView.imgToDom(newPos);
            circlePositions1[index].copy(newPos);
        });
        positions2.forEach((pos, index) => {
            newPos.copy(pos);
            this.renderView.imgToDom(newPos);
            circlePositions2[index].copy(newPos);
        });
        this.boxTool.updateBox2D(circlePositions1, circlePositions2);
    }

    updateRect() {
        let { center, size } = this.object as Rect;
        let scale = this.renderView.getScale();
        let newCenter = tempV2_1.copy(center);
        let newSize = tempV2_2.copy(size).multiplyScalar(scale);

        this.renderView.imgToDom(newCenter);
        this.rectTool.updateRect(newSize, newCenter);
    }

    updateRectData(center: THREE.Vector2, size?: THREE.Vector2) {
        let object = this.object as Rect;
        this.renderView.pointCloud.update2DRect(object, { center, size });
    }
    updateBox2DData(
        positionName: 'positions1' | 'positions2',
        positionMap: Record<number, THREE.Vector2>,
    ) {
        let object = this.object as Box2D;
        let option = {} as any;
        option[positionName] = positionMap;
        this.renderView.pointCloud.update2DBox(object, option);
    }

    private updateGroundProjectionVertexHandles(): void {
        const object = this.object;
        if (
            !(object instanceof ProjectedPolygon) &&
            !(object instanceof ProjectedPolyline) &&
            !(object instanceof ProjectedIrregularWall)
        ) {
            this.vertexHandleLayer.style.display = 'none';
            return;
        }

        const entries: Array<{
            point: THREE.Vector2;
            index: number;
            side?: 'bottom' | 'top';
        }> = object instanceof ProjectedIrregularWall
            ? (['bottom', 'top'] as const).flatMap((side) =>
                  (side === 'bottom' ? object.bottomPoints : object.topPoints).map(
                      (point, index) => ({ point, side, index }),
                  ),
              )
            : object.points.map((point, index) => ({ point, index }));
        this.vertexHandleLayer.style.display = 'block';
        this.ensureVertexHandles(entries.length);
        entries.forEach((entry, handleIndex) => {
            const position = entry.point.clone();
            this.renderView.imgToDom(position);
            const handle = this.vertexHandles[handleIndex];
            handle.dataset.index = String(entry.index);
            handle.dataset.side = entry.side || '';
            handle.style.display = 'block';
            handle.style.left = `${position.x}px`;
            handle.style.top = `${position.y}px`;
            const selectedVertex = this.getSelectedGroundPolygonVertex?.();
            const isSelectedParkingVertex =
                object instanceof ProjectedPolygon &&
                this.selectedGroundSource instanceof GroundPolygon &&
                selectedVertex?.object === this.selectedGroundSource &&
                selectedVertex.index === entry.index;
            handle.style.borderColor = isSelectedParkingVertex
                ? '#ffffff'
                : entry.side === 'top'
                  ? '#ff9f1c'
                  : '#00e5ff';
            handle.style.background = isSelectedParkingVertex ? '#ffff00' : '#10252a';
            handle.style.boxShadow = isSelectedParkingVertex
                ? '0 0 0 3px rgba(255, 255, 0, 0.55)'
                : '';
        });
        this.vertexHandles.slice(entries.length).forEach((handle) => {
            handle.style.display = 'none';
        });
    }

    private ensureVertexHandles(count: number): void {
        while (this.vertexHandles.length < count) {
            const handle = document.createElement('div');
            handle.style.cssText =
                'position:absolute;width:10px;height:10px;border:2px solid #00e5ff;' +
                'border-radius:50%;background:#10252a;box-sizing:border-box;' +
                'transform:translate(-50%,-50%);pointer-events:auto;cursor:grab;';
            handle.addEventListener('pointerdown', (event) => {
                this.startGroundProjectionVertexDrag(event, handle);
            });
            this.vertexHandleLayer.appendChild(handle);
            this.vertexHandles.push(handle);
        }
    }

    private syncSelectedSourcePolygon(): void {
        const selection = this.renderView.pointCloud.selection;
        const source = selection.find(
            (item) =>
                item instanceof GroundPolygon ||
                item instanceof GroundPolyline ||
                item instanceof IrregularWall,
        ) as GroundPolygon | GroundPolyline | IrregularWall | undefined;
        if (source) {
            this.selectedGroundSource = source;
            const selectedProjection = selection.find(
                (item) =>
                    item instanceof ProjectedPolygon ||
                    item instanceof ProjectedPolyline ||
                    item instanceof ProjectedIrregularWall,
            ) as ProjectedPolygon | ProjectedPolyline | ProjectedIrregularWall | undefined;
            this.object = selectedProjection || this.getProjectionForSource(source);
        } else if (this.selectedGroundSource) {
            this.selectedGroundSource = undefined;
            if (!(this.object instanceof Object2D) || !selection.includes(this.object as any)) {
                this.object = null;
            }
        }
    }

    private getProjectionForSource(
        source: GroundPolygon | GroundPolyline | IrregularWall,
    ): ProjectedPolygon | ProjectedPolyline | ProjectedIrregularWall | null {
        const sourceTrackId = source.userData?.trackId as string | undefined;
        const projection = this.renderView
            .get2DObject()
            .find(
                (candidate) =>
                    ((source instanceof GroundPolygon && candidate instanceof ProjectedPolygon) ||
                        (source instanceof GroundPolyline && candidate instanceof ProjectedPolyline) ||
                        (source instanceof IrregularWall && candidate instanceof ProjectedIrregularWall)) &&
                    this.renderView.isRenderable(candidate) &&
                    (candidate.userData?.projectedFromId === source.uuid ||
                        (!!sourceTrackId && candidate.userData?.trackId === sourceTrackId)),
            );
        return projection instanceof ProjectedPolygon ||
            projection instanceof ProjectedPolyline ||
            projection instanceof ProjectedIrregularWall
            ? projection
            : null;
    }

    private startGroundProjectionVertexDrag(event: PointerEvent, handle: HTMLDivElement): void {
        const object = this.object;
        if (
            !(object instanceof ProjectedPolygon) &&
            !(object instanceof ProjectedPolyline) &&
            !(object instanceof ProjectedIrregularWall)
        ) {
            return;
        }
        const index = Number(handle.dataset.index);
        const side = handle.dataset.side as 'bottom' | 'top' | undefined;

        event.preventDefault();
        event.stopPropagation();
        let lastImagePoint: THREE.Vector2 | undefined;
        const onMove = (moveEvent: PointerEvent): void => {
            const rect = this.renderView.container.getBoundingClientRect();
            const point = new THREE.Vector2(
                moveEvent.clientX - rect.left,
                moveEvent.clientY - rect.top,
            );
            this.renderView.domToImg(point);
            if (
                point.x < 0 ||
                point.x > this.renderView.imgSize.x ||
                point.y < 0 ||
                point.y > this.renderView.imgSize.y
            ) {
                return;
            }
            if (object instanceof ProjectedIrregularWall && side) {
                this.onIrregularWallProjectionPointChange?.(object, side, index, point);
            } else {
                lastImagePoint = point.clone();
                this.onGroundProjectionPointChange?.(
                    object as ProjectedPolygon | ProjectedPolyline,
                    index,
                    point,
                );
            }
        };
        const onUp = (): void => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            if (lastImagePoint && !(object instanceof ProjectedIrregularWall)) {
                this.onGroundProjectionPointCommit?.(
                    object as ProjectedPolygon | ProjectedPolyline,
                    index,
                    lastImagePoint,
                );
            }
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    }
}
