import * as THREE from 'three';
import Box from '../objects/Box';
import GroundPolygon from '../objects/GroundPolygon';
import GroundPolyline from '../objects/GroundPolyline';
import IrregularWall from '../objects/IrregularWall';
import ProjectedPolygon from '../objects/projectedPolygon';
import ProjectedPolyline from '../objects/projectedPolyline';
import ProjectedIrregularWall from '../objects/projectedIrregularWall';
import { Rect, Box2D } from '../objects';
import Render from './Render';
import PointCloud from '../PointCloud';
import { Event } from '../config';
import type { ITransform } from '../type';
import PointsMaterial from '../material/PointsMaterial';

export let axisUpInfo = {
    x: {
        yAxis: { axis: 'z', dir: new THREE.Vector3(0, 0, 1) },
        xAxis: { axis: 'y', dir: new THREE.Vector3(0, 1, 0) },
    },
    '-x': {
        yAxis: { axis: 'z', dir: new THREE.Vector3(0, 0, 1) },
        xAxis: { axis: 'y', dir: new THREE.Vector3(0, -1, 0) },
    },
    z: {
        yAxis: { axis: 'x', dir: new THREE.Vector3(1, 0, 0) },
        xAxis: { axis: 'y', dir: new THREE.Vector3(0, -1, 0) },
    },
    // '-z': {
    //     yAxis: { axis: 'y', dir: new THREE.Vector3(0, 1, 0) },
    //     xAxis: { axis: 'x', dir: new THREE.Vector3(-1, 0, 0) },
    // },
    y: {
        yAxis: { axis: 'z', dir: new THREE.Vector3(0, 0, 1) },
        xAxis: { axis: 'x', dir: new THREE.Vector3(-1, 0, 0) },
    },
    '-y': {
        yAxis: { axis: 'z', dir: new THREE.Vector3(0, 0, 1) },
        xAxis: { axis: 'x', dir: new THREE.Vector3(1, 0, 0) },
    },
};

export type axisType = keyof typeof axisUpInfo;
// export type axisType = 'x' | 'y' | 'z' | '-x' | '-y';

// const defaultActions: string[] = [];
const defaultActions = ['resize-translate', 'distance-measure'];
// Keep the midpoint insertion control clear of the two vertex controls.
const MIN_SEGMENT_INSERT_HANDLE_DISTANCE_PX = 36;

export default class SideRenderView extends Render {
    container: HTMLDivElement;
    pointCloud: PointCloud;
    width: number;
    height: number;
    renderer: THREE.WebGLRenderer;
    camera: THREE.OrthographicCamera;
    cameraHelper?: THREE.CameraHelper;
    object: Box | GroundPolygon | GroundPolyline | IrregularWall | null;
    projectRect: THREE.Box3;
    axis: axisType;
    alignAxis: THREE.Vector3;
    paddingPercent: number;
    needFit: boolean = true;
    enableFit: boolean = true;
    // material: THREE.ShaderMaterial;
    selectColor: THREE.Color = new THREE.Color(0, 1, 0);
    boxInvertMatrix: THREE.Matrix4 = new THREE.Matrix4();
    zoom: number = 1;
    cameraOffset: THREE.Vector3 = new THREE.Vector3();
    onGroundPolygonPointsChange?: (object: GroundPolygon, points: THREE.Vector3[]) => void;
    onGroundPolygonVertexSelect?: (object: GroundPolygon, index: number) => void;
    onGroundPolylinePointsChange?: (
        object: GroundPolyline,
        points: THREE.Vector3[],
        beforePoints?: THREE.Vector3[],
    ) => void;
    onIrregularWallPointsChange?: (
        object: IrregularWall,
        side: 'bottom' | 'top',
        points: THREE.Vector3[],
        beforePoints?: THREE.Vector3[],
    ) => void;
    onIrregularWallVertexSelect?: (object: IrregularWall, side: 'bottom' | 'top', index: number) => void;
    onIrregularWallSegmentInsert?: (
        object: IrregularWall,
        side: 'bottom' | 'top',
        segmentIndex: number,
        point: THREE.Vector3,
    ) => void;
    getSelectedIrregularWallVertex?: () => { object: IrregularWall; side: 'bottom' | 'top'; index: number } | undefined;
    onGroundPolylineVertexSelect?: (object: GroundPolyline, index: number) => void;
    onGroundPolylineSegmentInsert?: (
        object: GroundPolyline,
        segmentIndex: number,
        point: THREE.Vector3,
    ) => void;
    onGroundPolylineHeightChange?: (object: GroundPolyline, wallHeight: number) => void;
    getSelectedGroundPolylineVertex?: () => { object: GroundPolyline; index: number } | undefined;
    getSelectedGroundPolygonVertex?: () => { object: GroundPolygon; index: number } | undefined;
    private readonly vertexHandleLayer: HTMLDivElement;
    private readonly vertexHandles: HTMLDivElement[] = [];
    private readonly segmentHandles: HTMLDivElement[] = [];
    private heightDragMove?: (event: PointerEvent) => void;
    private heightDragUp?: () => void;
    private readonly groundPolylineEditLine = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({
            depthTest: false,
            toneMapped: false,
        }),
    );
    private readonly irregularWallBottomEditLine = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x00e5ff, depthTest: false, toneMapped: false }),
    );
    private readonly irregularWallTopEditLine = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xff9f1c, depthTest: false, toneMapped: false }),
    );
    private readonly irregularWallConnectorEditLine = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.65, toneMapped: false }),
    );
    private readonly onSelect = () => {
        // A pointer can be released outside this view while changing selection in
        // another panel. Never let that stale drag retain the previous wall as the
        // active side-view target.
        this.clearHeightDrag();
        const object = this.resolveSideTarget();
        if (object) {
            this.enableFit = true;
            this.zoom = 1;
            this.updateSize();
            this.fitObject(object);
        } else {
            this.object = null;
        }
        this.render();
    };
    private readonly onObjectTransform = (e: any) => {
        let object = e.data.object;
        const transform = e.data.option as Partial<ITransform> | undefined;
        if (
            object &&
            object instanceof THREE.Object3D &&
            object === this.object &&
            this.needFit &&
            this.enableFit
        ) {
            // Editing a wall boundary changes its geometry, not its transform.
            // Keep the current side-view scale while it is being dragged; fitting
            // every pointer move hides the visible height change and can leave the
            // view targeting stale bounds.
            if ((transform as any)?.pointsChanged) {
                this.updateProjectRect();
                this.render();
                return;
            }
            // Z/X rotates only the box. Keep the current orthographic range so its
            // behavior matches mouse rotation instead of visibly zooming every step,
            // while still re-aligning every side-view camera to the rotated object.
            if (transform?.rotation && !transform.position && !transform.scale) {
                this.fitObjectKeepViewport();
                this.render();
                return;
            }
            this.fitObject();
            this.render();
        }
    };

    constructor(container: HTMLDivElement, pointCloud: PointCloud, config = {} as any) {
        super(config.name || '');

        let { axis = 'z', paddingPercent = 1 } = config;

        this.container = container;
        this.pointCloud = pointCloud;

        this.object = null;
        this.projectRect = new THREE.Box3();
        this.axis = axis;
        this.alignAxis = new THREE.Vector3();
        this.setAxis(axis);

        // this.resizing = false;
        this.paddingPercent = paddingPercent;

        this.width = this.container.clientWidth;
        this.height = this.container.clientHeight;

        // renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.autoClear = false;
        this.renderer.sortObjects = false;
        this.renderer.setPixelRatio(pointCloud.pixelRatio);
        this.renderer.setSize(this.width, this.height);
        this.container.appendChild(this.renderer.domElement);
        // Listen on the container so Shift-drag also works when the transparent SVG edit
        // overlay is the event target instead of the WebGL canvas.
        this.container.addEventListener('pointerdown', this.onHeightPointerDown, true);
        if (!this.container.style.position) this.container.style.position = 'relative';
        this.vertexHandleLayer = document.createElement('div');
        this.vertexHandleLayer.style.cssText =
            'position:absolute;inset:0;pointer-events:none;z-index:3;display:none;';
        this.container.appendChild(this.vertexHandleLayer);
        this.initGroundPolygonVertexHandles();

        this.camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 10);
        this.pointCloud.scene.add(this.camera);
        // this.camera.position.set(-0, 0, -100);
        // this.camera.up.set(0, 1, 0);

        // helper
        let camera = this.camera;
        // camera.lookAt(0, 0, 0);
        const helper = new THREE.CameraHelper(camera);
        // this.pointCloud.scene.add(helper);
        this.cameraHelper = helper;

        // this.renderer.setClearColor(new THREE.Color(0.1, 0.1, 0.1));
        this.setActions(config.actions || defaultActions);
        this.initEvent();
        // this.material = this.createMaterial();
        // this.initDom();

        // @ts-ignore
        window.subView = this;
    }

    initEvent() {
        this.pointCloud.addEventListener(Event.SELECT, this.onSelect);
        this.pointCloud.addEventListener(Event.OBJECT_TRANSFORM, this.onObjectTransform);
    }

    setAxis(axis: axisType) {
        this.axis = axis;
        this.alignAxis.set(0, 0, 0);

        let axisValue = this.axis.length === 2 ? this.axis[1] : this.axis[0];
        let isInverse = this.axis.length === 2;
        this.alignAxis[axisValue as 'x' | 'y' | 'z'] = isInverse ? -0.5 : 0.5;

        if (this.object) this.fitObject();

        this.render();
    }

    cameraToCanvas(pos: THREE.Vector3) {
        pos.project(this.camera);
        pos.x = ((pos.x + 1) / 2) * this.width;
        pos.y = (-(pos.y - 1) / 2) * this.height;
        return pos;
    }

    cameraSpaceToCanvas(pos: THREE.Vector3) {
        pos.applyMatrix4(this.camera.projectionMatrix);
        pos.x = ((pos.x + 1) / 2) * this.width;
        pos.y = (-(pos.y - 1) / 2) * this.height;
        return pos;
    }

    canvasToCamera(pos: THREE.Vector3) {
        // pos.applyMatrix4(this.camera.projectionMatrix.clone().invert());
        pos.x = (pos.x / this.width) * 2 - 1;
        pos.y = ((-1 * pos.y) / this.height) * 2 + 1;

        pos.x *= this.camera.right - this.camera.left;
        pos.y *= this.camera.top - this.camera.bottom;
        return pos;
    }

    updateProjectRect() {
        if (!this.object) return;

        let { axis, object, camera } = this;

        camera.updateMatrixWorld();
        object.updateMatrixWorld();

        let bbox: THREE.Box3;
        if (object instanceof GroundPolygon || object instanceof GroundPolyline || object instanceof IrregularWall) {
            const points = object instanceof IrregularWall
                ? [...object.bottomPoints, ...object.topPoints]
                : object.points3D;
            bbox = new THREE.Box3().setFromPoints(points);
        } else {
            if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
            bbox = object.geometry.boundingBox as THREE.Box3;
        }

        const projectBoundingBox = bbox
            .clone()
            .applyMatrix4(object.matrixWorld)
            .applyMatrix4(camera.matrixWorldInverse);
        this.projectRect.copy(projectBoundingBox);
        //  = { min, max };
        // return ;
    }

    private resolveSideTarget(): Box | GroundPolygon | GroundPolyline | IrregularWall | null {
        const target = this.pointCloud.selection.find(
            (annotate) =>
                (annotate instanceof Box || annotate instanceof GroundPolygon || annotate instanceof GroundPolyline || annotate instanceof IrregularWall) &&
                annotate.parent === this.pointCloud.annotate3D,
        );
        if (
            target instanceof Box ||
            target instanceof GroundPolygon ||
            target instanceof GroundPolyline ||
            target instanceof IrregularWall
        ) {
            return target;
        }

        // Image clicks select a 2D projection.  Side views still need its 3D
        // source in order to draw the height/orthographic projection, even if
        // an old annotation has not yet restored that source into selection.
        const projection = this.pointCloud.selection.find(
            (annotate) =>
                annotate instanceof Rect ||
                annotate instanceof Box2D ||
                annotate instanceof ProjectedPolygon ||
                annotate instanceof ProjectedPolyline ||
                annotate instanceof ProjectedIrregularWall,
        );
        if (!projection) return null;

        const candidates = this.pointCloud.getAnnotate3D().filter((annotate) =>
            ((projection instanceof Rect || projection instanceof Box2D) && annotate instanceof Box) ||
            (projection instanceof ProjectedPolygon && annotate instanceof GroundPolygon) ||
            (projection instanceof ProjectedPolyline && annotate instanceof GroundPolyline) ||
            (projection instanceof ProjectedIrregularWall && annotate instanceof IrregularWall),
        ) as Array<Box | GroundPolygon | GroundPolyline | IrregularWall>;
        const sourceId = projection.userData?.projectedFromId;
        const trackId = projection.userData?.trackId;
        const connectId = projection instanceof Rect || projection instanceof Box2D
            ? projection.connectId
            : undefined;
        const source = candidates.find(
            (annotate) =>
                annotate.uuid === sourceId ||
                (!!trackId && annotate.userData?.trackId === trackId) ||
                (connectId !== undefined && annotate.id === connectId),
        ) || (candidates.length === 1 ? candidates[0] : undefined);
        if (source) projection.userData.projectedFromId = source.uuid;
        return source || null;
    }

    fitObject(object?: Box | GroundPolygon | GroundPolyline | IrregularWall) {
        // console.log('fitObject');
        if (object) this.object = object;

        object = this.object as Box | GroundPolygon | GroundPolyline | IrregularWall;
        if (!object) return;

        object.updateMatrixWorld();

        let temp = new THREE.Vector3();
        if (object instanceof GroundPolygon || object instanceof GroundPolyline || object instanceof IrregularWall) {
            const shapePoints = object instanceof IrregularWall
                ? [...object.bottomPoints, ...object.topPoints]
                : object.points3D;
            const worldPoints = shapePoints.map((point) =>
                point.clone().applyMatrix4(object.matrixWorld),
            );
            const center = new THREE.Box3().setFromPoints(worldPoints).getCenter(temp);
            const axisValue = this.axis.replace('-', '') as 'x' | 'y' | 'z';
            const direction = new THREE.Vector3();
            direction[axisValue] = this.axis.startsWith('-') ? -1 : 1;
            const maxDepth = worldPoints.reduce(
                (depth, point) => Math.max(depth, point.clone().sub(center).dot(direction)),
                0,
            );
            this.camera.position
                .copy(center)
                .addScaledVector(direction, Math.max(5, maxDepth + 5));
            this.camera.up.copy(axisUpInfo[this.axis].yAxis.dir);
            this.camera.lookAt(center);
            this.updateProjectRect();
            this.updateCameraProject();
            return;
        }

        temp.copy(this.alignAxis);
        temp.applyMatrix4(object.matrixWorld);
        this.camera.position.copy(temp);

        temp.copy(axisUpInfo[this.axis].yAxis.dir)
            .applyMatrix4(object.matrixWorld)
            .sub(new THREE.Vector3().applyMatrix4(object.matrixWorld));
        this.camera.up.copy(temp);

        temp.set(0, 0, 0);
        temp.applyMatrix4(object.matrixWorld);
        this.camera.lookAt(temp);

        this.updateProjectRect();
        this.updateCameraProject();
        // this._render();
        // this.updateDom();
        // this.render();
    }

    private fitObjectKeepViewport(): void {
        const { left, right, top, bottom } = this.camera;
        this.fitObject();
        this.camera.left = left;
        this.camera.right = right;
        this.camera.top = top;
        this.camera.bottom = bottom;
        this.camera.updateProjectionMatrix();
        this.cameraHelper?.update();
    }

    updateCameraProject() {
        let { projectRect } = this;
        let rectWidth = projectRect.max.x - projectRect.min.x;
        let rectHeight = projectRect.max.y - projectRect.min.y;
        let aspect = Math.max(this.width / this.height, 0.01);

        // debugger
        let cameraW, cameraH;
        let padding = Math.min(rectWidth, rectHeight) * this.paddingPercent;
        // let padding = (200 * rectWidth) / this.width;
        cameraW = Math.max(rectWidth + padding, (rectHeight + padding) * aspect);
        cameraH = Math.max(rectHeight + padding, (rectWidth + padding) / aspect);
        cameraW = Math.max(cameraW, 0.5);
        cameraH = Math.max(cameraH, 0.5);

        this.camera.left = (-cameraW / 2) * this.zoom;
        this.camera.right = (cameraW / 2) * this.zoom;
        this.camera.top = (cameraH / 2) * this.zoom;
        this.camera.bottom = (-cameraH / 2) * this.zoom;
        // debugger
        // Ground shapes have zero thickness, so keep a large far plane for them.
        // 3D boxes follow upstream xtreme1: clip along the view axis by box thickness.
        this.camera.far =
            this.object instanceof GroundPolygon || this.object instanceof GroundPolyline || this.object instanceof IrregularWall
                ? 200
                : projectRect.max.z - projectRect.min.z;
        this.camera.updateProjectionMatrix();

        // this.camera.position.add(this.cameraOffset);
        // this.camera.updateMatrixWorld();
        // this.camera.far = 0;
        this.cameraHelper?.update();
    }

    focusSelectedGroundPolylineVertex(): void {
        const selected = this.getSelectedGroundPolylineVertex?.();
        const selectedGroundPolygonVertex = this.getSelectedGroundPolygonVertex?.();
        const selectedIrregularWallVertex = this.getSelectedIrregularWallVertex?.();
        const selectedWallPoints = selectedIrregularWallVertex?.side === 'bottom'
            ? selectedIrregularWallVertex.object.bottomPoints
            : selectedIrregularWallVertex?.object.topPoints;
        const selectedWallPoint = selectedIrregularWallVertex && selectedWallPoints
            ? selectedWallPoints[selectedIrregularWallVertex.index]
            : undefined;
        const object = selected?.object || selectedGroundPolygonVertex?.object || selectedIrregularWallVertex?.object;
        if (!object || object !== this.object) return;
        const point = selected?.object === object
            ? selected.object.points3D[selected.index]
            : selectedGroundPolygonVertex?.object === object
              ? selectedGroundPolygonVertex.object.points3D[selectedGroundPolygonVertex.index]
            : selectedWallPoint;
        if (!point) return;

        object.updateMatrixWorld();
        this.camera.updateMatrixWorld();
        const projected = point.clone().applyMatrix4(object.matrixWorld).project(this.camera);
        const halfWidth = (this.camera.right - this.camera.left) / 2;
        const halfHeight = (this.camera.top - this.camera.bottom) / 2;
        const right = new THREE.Vector3(1, 0, 0).transformDirection(this.camera.matrixWorld);
        const up = new THREE.Vector3(0, 1, 0).transformDirection(this.camera.matrixWorld);
        // Shift the orthographic camera by the point's current screen offset, placing
        // the selected vertex at the centre without changing its scale or orientation.
        this.camera.position
            .addScaledVector(right, projected.x * halfWidth)
            .addScaledVector(up, projected.y * halfHeight);
        this.camera.updateMatrixWorld();
    }

    updateSize() {
        let width = this.container.clientWidth || 10;
        let height = this.container.clientHeight || 10;

        if (width !== this.width || height !== this.height) {
            this.width = width;
            this.height = height;
            this.renderer.setSize(this.width, this.height);
            // this.camera.aspect = this.width / this.height;
            // this.camera.updateProjectionMatrix();
        }
    }

    // render
    renderFrame() {
        // console.log('renderFrame');
        let { groupPoints, selection } = this.pointCloud;

        this.updateSize();
        // if(this.renderTimer) return;
        this.renderer.clear(true, true, true);

        if (groupPoints.children.length === 0) return;

        const hasObject3D = this.resolveSideTarget();

        if (selection.length > 0 && hasObject3D) {
            if (hasObject3D instanceof GroundPolygon || hasObject3D instanceof GroundPolyline || hasObject3D instanceof IrregularWall) {
                const groupPoint = groupPoints.children[0] as THREE.Points;
                const material = groupPoint.material as PointsMaterial;
                const oldDepthTest = material.depthTest;
                const oldHasFilterBox = material.getUniforms('hasFilterBox');
                const oldType = material.getUniforms('boxInfo').type;
                const oldSideViewContrast = material.getUniforms('sideViewContrast');
                const oldSideViewContrastCenters = material.getUniforms('sideViewContrastCenters');
                const oldHideNonGroundRgb = material.getUniforms('hideNonGroundRgb');
                hasObject3D.updateMatrixWorld();
                // P annotations always use all four vertices as contrast centres.
                // Selecting a vertex only controls its editing highlight; it must not
                // collapse the visual enhancement back to a single small area.
                const contrastCenters = Array.from({ length: 4 }, (_, index) => {
                    // Only P annotations have the four-point local-contrast mode.
                    // Irregular walls store bottom/top point arrays instead.
                    const point = hasObject3D instanceof GroundPolygon
                        ? hasObject3D.points3D[index]
                        : undefined;
                    return point
                        ? point.clone().applyMatrix4(hasObject3D.matrixWorld)
                        : new THREE.Vector3(1e6, 1e6, 1e6);
                });

                material.depthTest = false;
                material.setUniforms({
                    hasFilterBox: -1,
                    sideViewContrast: -1,
                    sideViewContrastCenters: contrastCenters,
                    // Keep all context points in side views; the RGB non-ground
                    // filter is a main-cloud viewing aid and would blank wall views.
                    hideNonGroundRgb: -1,
                });
                try {
                    this.renderer.render(groupPoint, this.camera);
                    this.renderParkingDensityOverlay();
                } finally {
                    material.setUniforms({
                        hasFilterBox: oldHasFilterBox,
                        sideViewContrast: oldSideViewContrast,
                        sideViewContrastCenters: oldSideViewContrastCenters,
                        hideNonGroundRgb: oldHideNonGroundRgb,
                        boxInfo: { type: oldType },
                    });
                    material.depthTest = oldDepthTest;
                }
                if (hasObject3D instanceof GroundPolyline) {
                    this.groundPolylineEditLine.geometry.setFromPoints(hasObject3D.points3D);
                    this.groundPolylineEditLine.geometry.computeBoundingSphere();
                    (
                        this.groundPolylineEditLine.material as THREE.LineBasicMaterial
                    ).color.copy(hasObject3D.color);
                    this.groundPolylineEditLine.matrixAutoUpdate = false;
                    this.groundPolylineEditLine.matrix.copy(hasObject3D.matrixWorld);
                    this.groundPolylineEditLine.updateMatrixWorld(true);
                    this.renderer.render(this.groundPolylineEditLine, this.camera);
                    if (hasObject3D.wallHeight > 0) {
                        this.renderer.render(hasObject3D.wallMesh, this.camera);
                        this.renderer.render(hasObject3D.topLine, this.camera);
                    }
                } else if (hasObject3D instanceof IrregularWall) {
                    this.renderIrregularWallEditLines(hasObject3D);
                } else {
                    this.renderer.render(hasObject3D, this.camera);
                }
                // Ground-shape side-view rendering returns early so its custom
                // vertex overlays can be refreshed. Draw the transient measure
                // layer before that return as well; otherwise a selected curb or
                // wall hides the line segment between the two measured points.
                this.renderer.render(this.pointCloud.groupMeasure, this.camera);
                this.updateProjectRect();
                this.updateGroundPolygonVertexHandles();
                return;
            }
            // render points
            let groupPoint = groupPoints.children[0] as THREE.Points;
            let box = hasObject3D as Box;
            box.updateMatrixWorld();
            // if (!box.geometry.boundingBox) box.geometry.computeBoundingBox();

            let bbox = box.geometry.boundingBox as THREE.Box3;
            let material = groupPoint.material as PointsMaterial;

            let oldDepthTest = material.depthTest;
            let oldHasFilterBox = material.getUniforms('hasFilterBox');
            let oldType = material.getUniforms('boxInfo').type;
            let oldHasOcclusionClip = material.getUniforms('hasOcclusionClip');
            const oldSideViewContrast = material.getUniforms('sideViewContrast');
            const oldHideNonGroundRgb = material.getUniforms('hideNonGroundRgb');
            const occlusionAxis = new THREE.Vector3();
            const axisValue = this.axis.replace('-', '') as 'x' | 'y' | 'z';
            occlusionAxis[axisValue] = 1;

            material.depthTest = false;
            material.setUniforms({
                // The selected box is rendered as an outline below. Keep point colors
                // untouched here so the local red/green color-transition display can
                // classify points on both sides of the annotation boundary.
                hasFilterBox: -1,
                hasOcclusionClip: 1,
                sideViewContrast: -1,
                hideNonGroundRgb: -1,
                occlusionAxis,
                occlusionDirection: this.axis.startsWith('-') ? -1 : 1,
                boxInfo: {
                    type: 0,
                    min: bbox.min,
                    max: bbox.max,
                    color: this.selectColor,
                    matrix: this.boxInvertMatrix.copy(box.matrixWorld).invert(),
                },
            });
            try {
                this.renderer.render(groupPoint, this.camera);
                this.renderParkingDensityOverlay();
            } finally {
                material.setUniforms({
                    hasFilterBox: oldHasFilterBox,
                    hasOcclusionClip: oldHasOcclusionClip,
                    sideViewContrast: oldSideViewContrast,
                    hideNonGroundRgb: oldHideNonGroundRgb,
                    boxInfo: { type: oldType },
                });
                material.depthTest = oldDepthTest;
            }

            // render box
            selection.forEach((object) => {
                if (object instanceof THREE.Object3D) {
                    this.renderer.render(object, this.camera);
                }
            });
            // Image-originated selection can resolve the correct 3D box for
            // this side view before the legacy 2D projection has a persisted
            // source id. In that case the global selection still contains only
            // the 2D object, so render the resolved target explicitly.
            if (!selection.includes(box)) {
                this.renderer.render(box, this.camera);
            }
        } else {
            this.renderer.render(groupPoints, this.camera);
            this.renderParkingDensityOverlay();
        }

        // Distance measurements are scene-owned temporary graphics. Render them
        // after the point cloud so their endpoints and line are visible in every
        // orthographic side view without becoming annotation objects.
        this.renderer.render(this.pointCloud.groupMeasure, this.camera);

        this.updateProjectRect();
        this.updateGroundPolygonVertexHandles();
        // console.log('renderFrame');
        // this.updateDom();
    }

    /**
     * The RGB density layer is intentionally scene-owned so it never affects
     * point-cloud loading/picking.  Side views render the base point group
     * directly, therefore draw that display-only scene child explicitly too.
     */
    private renderParkingDensityOverlay(): void {
        const overlay = this.pointCloud.scene.getObjectByName('parking-rgb-neighbour-points');
        if (!overlay?.visible || overlay.children.length === 0) return;

        const materials: Array<{ material: THREE.PointsMaterial; depthTest: boolean; size: number }> = [];
        const worldPerPixel = (this.camera.top - this.camera.bottom)
            / Math.max(this.height * this.renderer.getPixelRatio(), 1);
        overlay.traverse((child) => {
            if (!(child instanceof THREE.Points)) return;
            const material = child.material as THREE.PointsMaterial;
            materials.push({ material, depthTest: material.depthTest, size: material.size });
            // The base cloud is rendered without depth testing in orthographic
            // side views; do the same for neighbours so they are not hidden by
            // the current frame's road surface.
            material.depthTest = false;
            if (this.axis === 'z') {
                // THREE.PointsMaterial does not attenuate point size for an
                // orthographic camera. Convert the shared world-space ground
                // point size to this view's current screen scale.
                material.size /= worldPerPixel;
            }
        });
        try {
            this.renderer.render(overlay, this.camera);
        } finally {
            materials.forEach(({ material, depthTest, size }) => {
                material.depthTest = depthTest;
                material.size = size;
            });
        }
    }

    private renderIrregularWallEditLines(wall: IrregularWall): void {
        wall.updateWorldMatrix(true, true);
        // Preserve the translucent wall face in side views; the independent lines
        // below are only used to make both boundaries reliable during editing.
        this.renderer.render(wall.wallMesh, this.camera);
        const renderLine = (line: THREE.Line | THREE.LineSegments, points: THREE.Vector3[]): void => {
            line.geometry.setFromPoints(points);
            line.geometry.computeBoundingSphere();
            line.matrixAutoUpdate = false;
            line.matrix.copy(wall.matrixWorld);
            line.updateMatrixWorld(true);
            this.renderer.render(line, this.camera);
        };

        renderLine(this.irregularWallBottomEditLine, wall.bottomPoints);
        if (wall.topPoints.length >= 2) {
            renderLine(this.irregularWallTopEditLine, wall.topPoints);
            const directDistance =
                wall.bottomPoints[0].distanceToSquared(wall.topPoints[0]) +
                wall.bottomPoints.at(-1)!.distanceToSquared(wall.topPoints.at(-1)!);
            const reversedDistance =
                wall.bottomPoints[0].distanceToSquared(wall.topPoints.at(-1)!) +
                wall.bottomPoints.at(-1)!.distanceToSquared(wall.topPoints[0]);
            const topStart = reversedDistance < directDistance
                ? wall.topPoints.at(-1)!
                : wall.topPoints[0];
            const topEnd = reversedDistance < directDistance
                ? wall.topPoints[0]
                : wall.topPoints.at(-1)!;
            renderLine(this.irregularWallConnectorEditLine, [
                wall.bottomPoints[0], topStart,
                wall.bottomPoints.at(-1)!, topEnd,
            ]);
        }
    }

    destroy(): void {
        super.destroy();
        this.pointCloud.removeEventListener(Event.SELECT, this.onSelect);
        this.pointCloud.removeEventListener(Event.OBJECT_TRANSFORM, this.onObjectTransform);
        this.pointCloud.scene.remove(this.camera);
        this.cameraHelper?.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss();
        this.container.removeEventListener('pointerdown', this.onHeightPointerDown, true);
        this.clearHeightDrag();
        this.renderer.domElement.remove();
        this.groundPolylineEditLine.geometry.dispose();
        (this.groundPolylineEditLine.material as THREE.Material).dispose();
        this.irregularWallBottomEditLine.geometry.dispose();
        (this.irregularWallBottomEditLine.material as THREE.Material).dispose();
        this.irregularWallTopEditLine.geometry.dispose();
        (this.irregularWallTopEditLine.material as THREE.Material).dispose();
        this.irregularWallConnectorEditLine.geometry.dispose();
        (this.irregularWallConnectorEditLine.material as THREE.Material).dispose();
        this.vertexHandleLayer.remove();
        this.segmentHandles.splice(0);
        this.object = null;
        // @ts-ignore
        if (window.subView === this) window.subView = undefined;
    }

    private initGroundPolygonVertexHandles(): void {
        this.ensureVertexHandles(4);
    }

    private ensureVertexHandles(count: number): void {
        while (this.vertexHandles.length < count) {
            const handle = document.createElement('div');
            handle.style.cssText =
                'position:absolute;width:10px;height:10px;border:2px solid #00e5ff;' +
                'border-radius:50%;background:#10252a;box-sizing:border-box;' +
                'transform:translate(-50%,-50%);pointer-events:auto;cursor:grab;';
            handle.addEventListener('pointerdown', (event) => {
                this.startGroundPolygonVertexDrag(event, Number(handle.dataset.index));
            });
            this.vertexHandleLayer.appendChild(handle);
            this.vertexHandles.push(handle);
        }
    }

    private ensureSegmentHandles(count: number): void {
        while (this.segmentHandles.length < count) {
            const handle = document.createElement('div');
            handle.style.cssText =
                'position:absolute;width:14px;height:14px;border:2px solid #7cff7c;' +
                'border-radius:50%;background:#16301a;color:#7cff7c;font-size:12px;' +
                'line-height:10px;text-align:center;box-sizing:border-box;' +
                'transform:translate(-50%,-50%);pointer-events:auto;cursor:pointer;' +
                'font-weight:bold;user-select:none;';
            handle.textContent = '+';
            handle.title = 'Insert point into this segment';
            handle.addEventListener('pointerdown', (event) => {
                this.insertGroundShapeSegmentPoint(
                    event,
                    Number(handle.dataset.index),
                    handle.dataset.side as 'bottom' | 'top' | undefined,
                );
            });
            this.vertexHandleLayer.appendChild(handle);
            this.segmentHandles.push(handle);
        }
        this.segmentHandles.forEach((handle, index) => {
            handle.dataset.index = String(index);
        });
    }

    private updateGroundPolygonVertexHandles(): void {
        const object = this.resolveSideTarget();
        if (!(object instanceof GroundPolygon) && !(object instanceof GroundPolyline) && !(object instanceof IrregularWall)) {
            this.vertexHandleLayer.style.display = 'none';
            return;
        }

        object.updateMatrixWorld();
        this.object = object;
        this.camera.updateMatrixWorld();
        this.vertexHandleLayer.style.display = 'block';
        const editablePoints = object instanceof IrregularWall
            ? [...object.bottomPoints, ...object.topPoints]
            : object.points3D;
        this.ensureVertexHandles(editablePoints.length);
        const segmentCount = object instanceof GroundPolyline
            ? object.points3D.length - 1
            : object instanceof IrregularWall
                ? object.bottomPoints.length + object.topPoints.length - 2
                : 0;
        this.ensureSegmentHandles(segmentCount);
        editablePoints.forEach((point, index) => {
            const canvasPoint = this.cameraToCanvas(point.clone().applyMatrix4(object.matrixWorld));
            const handle = this.vertexHandles[index];
            handle.dataset.index = String(index);
            handle.dataset.side = object instanceof IrregularWall
                ? index < object.bottomPoints.length ? 'bottom' : 'top'
                : '';
            handle.dataset.sideIndex = String(object instanceof IrregularWall && index >= object.bottomPoints.length ? index - object.bottomPoints.length : index);
            handle.style.display =
                object instanceof GroundPolyline && object.isVisibilityBoundaryPoint(index)
                    ? 'none'
                    : 'block';
            handle.style.left = `${canvasPoint.x}px`;
            handle.style.top = `${canvasPoint.y}px`;
            const selectedVertex = this.getSelectedGroundPolylineVertex?.();
            const selectedGroundPolygonVertex = this.getSelectedGroundPolygonVertex?.();
            const selectedIrregularWallVertex = this.getSelectedIrregularWallVertex?.();
            const isSelectedGroundPolygonVertex =
                object instanceof GroundPolygon &&
                selectedGroundPolygonVertex?.object === object &&
                selectedGroundPolygonVertex.index === index;
            const isSelectedIrregularWallVertex =
                object instanceof IrregularWall &&
                selectedIrregularWallVertex?.object === object &&
                selectedIrregularWallVertex.side === handle.dataset.side &&
                selectedIrregularWallVertex.index === Number(handle.dataset.sideIndex);
            handle.style.background = object instanceof IrregularWall
                ? isSelectedIrregularWallVertex ? '#ffff00' : handle.dataset.side === 'bottom' ? '#00e5ff' : '#ff9f1c'
                : isSelectedGroundPolygonVertex
                    ? '#ffff00'
                : selectedVertex?.object === object && selectedVertex.index === index
                    ? '#00e5ff'
                    : '#10252a';
            handle.style.borderColor =
                isSelectedIrregularWallVertex || isSelectedGroundPolygonVertex ? '#ffffff' : '';
            handle.style.boxShadow =
                isSelectedIrregularWallVertex || isSelectedGroundPolygonVertex
                    ? '0 0 0 3px rgba(255, 255, 0, 0.55)'
                    : '';
        });
        this.vertexHandles.slice(editablePoints.length).forEach((handle) => {
            handle.style.display = 'none';
        });
        if (object instanceof GroundPolyline) {
            for (let index = 0; index < object.points3D.length - 1; index++) {
                const start = this.cameraToCanvas(
                    object.points3D[index].clone().applyMatrix4(object.matrixWorld),
                );
                const end = this.cameraToCanvas(
                    object.points3D[index + 1].clone().applyMatrix4(object.matrixWorld),
                );
                const handle = this.segmentHandles[index];
                const canInsert =
                    start.x >= 0 &&
                    start.x <= this.width &&
                    start.y >= 0 &&
                    start.y <= this.height &&
                    end.x >= 0 &&
                    end.x <= this.width &&
                    end.y >= 0 &&
                    end.y <= this.height &&
                    Math.hypot(end.x - start.x, end.y - start.y) >=
                        MIN_SEGMENT_INSERT_HANDLE_DISTANCE_PX;
                handle.style.display = canInsert ? 'block' : 'none';
                handle.style.left = `${(start.x + end.x) / 2}px`;
                handle.style.top = `${(start.y + end.y) / 2}px`;
            }
        } else if (object instanceof IrregularWall) {
            const segments: Array<{ side: 'bottom' | 'top'; index: number; start: THREE.Vector3; end: THREE.Vector3 }> = [];
            (['bottom', 'top'] as const).forEach((side) => {
                const points = side === 'bottom' ? object.bottomPoints : object.topPoints;
                points.slice(0, -1).forEach((start, index) => segments.push({ side, index, start, end: points[index + 1] }));
            });
            segments.forEach((segment, handleIndex) => {
                const start = this.cameraToCanvas(segment.start.clone().applyMatrix4(object.matrixWorld));
                const end = this.cameraToCanvas(segment.end.clone().applyMatrix4(object.matrixWorld));
                const handle = this.segmentHandles[handleIndex];
                handle.dataset.index = String(segment.index);
                handle.dataset.side = segment.side;
                handle.textContent = '+';
                handle.title = 'Insert point into this segment';
                handle.style.display = Math.hypot(end.x - start.x, end.y - start.y) >= MIN_SEGMENT_INSERT_HANDLE_DISTANCE_PX ? 'block' : 'none';
                handle.style.left = `${(start.x + end.x) / 2}px`;
                handle.style.top = `${(start.y + end.y) / 2}px`;
            });
        }
        this.segmentHandles.slice(segmentCount).forEach(
            (handle) => {
                handle.style.display = 'none';
            },
        );
    }

    private startGroundPolygonVertexDrag(event: PointerEvent, index: number): void {
        const object = this.object;
        if (!(object instanceof GroundPolygon) && !(object instanceof GroundPolyline) && !(object instanceof IrregularWall)) {
            return;
        }
        if (object instanceof GroundPolyline && object.isVisibilityBoundaryPoint(index)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        if (object instanceof GroundPolyline) {
            this.onGroundPolylineVertexSelect?.(object, index);
        } else if (object instanceof GroundPolygon) {
            this.onGroundPolygonVertexSelect?.(object, index);
        } else if (object instanceof IrregularWall) {
            const selectedSide = this.vertexHandles[index]?.dataset.side as 'bottom' | 'top';
            const selectedIndex = Number(this.vertexHandles[index]?.dataset.sideIndex);
            if (selectedSide && Number.isInteger(selectedIndex)) {
                this.onIrregularWallVertexSelect?.(object, selectedSide, selectedIndex);
            }
        }
        this.updateGroundPolygonVertexHandles();
        this.enableFit = false;
        const start = new THREE.Vector2(event.clientX, event.clientY);
        const side = object instanceof IrregularWall ? (this.vertexHandles[index]?.dataset.side as 'bottom' | 'top') : undefined;
        const sideIndex = object instanceof IrregularWall ? Number(this.vertexHandles[index]?.dataset.sideIndex) : index;
        const points = object instanceof IrregularWall
            ? (side === 'top' ? object.topPoints : object.bottomPoints).map((point) => point.clone())
            : object.points3D.map((point) => point.clone());
        let latestPoints = points.map((point) => point.clone());
        let irregularWallChanged = false;
        let groundPolylineChanged = false;
        const right = new THREE.Vector3(1, 0, 0).transformDirection(this.camera.matrixWorld);
        const up = new THREE.Vector3(0, 1, 0).transformDirection(this.camera.matrixWorld);
        const worldPerPixelX = (this.camera.right - this.camera.left) / this.width;
        const worldPerPixelY = (this.camera.top - this.camera.bottom) / this.height;

        const onMove = (moveEvent: PointerEvent): void => {
            if (object instanceof IrregularWall && (!side || !Number.isInteger(sideIndex))) return;
            const candidate = points.map((point) => point.clone());
            candidate[object instanceof IrregularWall ? sideIndex : index]
                .addScaledVector(right, (moveEvent.clientX - start.x) * worldPerPixelX)
                .addScaledVector(up, (start.y - moveEvent.clientY) * worldPerPixelY);
            if (object instanceof GroundPolygon) {
                if (!GroundPolygon.isValidPoints(candidate)) return;
                this.onGroundPolygonPointsChange?.(object, candidate);
            } else if (object instanceof IrregularWall) {
                latestPoints = candidate;
                irregularWallChanged = true;
                // Preview directly while dragging; committing a command for every
                // pointer event makes long point-cloud walls visibly laggy.
                object.setSidePoints(side, candidate);
                this.pointCloud.dispatchEvent({ type: Event.OBJECT_TRANSFORM, data: { object, option: { pointsChanged: true } } });
                this.pointCloud.render();
            } else {
                // Do not run projection/BEV visibility and annotation-change work for
                // every pointer event.  A long wall can have thousands of segments.
                // Preview locally, then make one undoable canonical update on release.
                latestPoints = candidate;
                groundPolylineChanged = true;
                object.setPoints(candidate);
                this.pointCloud.dispatchEvent({
                    type: Event.OBJECT_TRANSFORM,
                    data: { object, option: { pointsChanged: true, previewPointIndex: index } },
                });
                this.pointCloud.render();
            }
        };
        const onUp = (): void => {
            this.enableFit = true;
            if (object instanceof IrregularWall && side && irregularWallChanged) {
                this.onIrregularWallPointsChange?.(object, side, latestPoints, points);
            } else if (object instanceof GroundPolyline && groundPolylineChanged) {
                this.onGroundPolylinePointsChange?.(object, latestPoints, points);
            }
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    }

    private insertGroundShapeSegmentPoint(event: PointerEvent, segmentIndex: number, side?: 'bottom' | 'top'): void {
        const object = this.object;
        if (object instanceof IrregularWall && side) {
            const points = side === 'bottom' ? object.bottomPoints : object.topPoints;
            if (segmentIndex < 0 || segmentIndex >= points.length - 1) return;
            event.preventDefault();
            event.stopPropagation();
            this.onIrregularWallSegmentInsert?.(
                object,
                side,
                segmentIndex,
                points[segmentIndex].clone().lerp(points[segmentIndex + 1], 0.5),
            );
            return;
        }
        if (
            !(object instanceof GroundPolyline) ||
            segmentIndex < 0 ||
            segmentIndex >= object.points3D.length - 1
        ) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const point = object.points3D[segmentIndex]
            .clone()
            .lerp(object.points3D[segmentIndex + 1], 0.5);
        this.onGroundPolylineSegmentInsert?.(object, segmentIndex, point);
    }

    private readonly onHeightPointerDown = (event: PointerEvent): void => {
        if (!event.shiftKey) return;
        const object = this.resolveSideTarget();
        if (!(object instanceof GroundPolyline) && !(object instanceof IrregularWall)) return;
        object.updateMatrixWorld();
        const rect = this.renderer.domElement.getBoundingClientRect();
        const pointer = new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
        let midpoint: THREE.Vector3 | null = null;
        let irregularWallSide: 'bottom' | 'top' | undefined;
        let nearestDistance = 18;
        const findNearestSegment = (
            points: THREE.Vector3[],
            side?: 'bottom' | 'top',
            heightOffset?: THREE.Vector3,
        ): void => {
            for (let index = 0; index < points.length - 1; index++) {
                if (
                    object instanceof GroundPolyline &&
                    (object.isVisibilityBoundaryPoint(index) || object.isVisibilityBoundaryPoint(index + 1))
                ) {
                    continue;
                }
                const segmentStart = points[index].clone().add(heightOffset || new THREE.Vector3());
                const segmentEnd = points[index + 1].clone().add(heightOffset || new THREE.Vector3());
                const start = this.cameraToCanvas(
                    segmentStart.clone().applyMatrix4(object.matrixWorld),
                );
                const end = this.cameraToCanvas(
                    segmentEnd.clone().applyMatrix4(object.matrixWorld),
                );
                const distance = distanceToScreenSegment(pointer, start, end);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    midpoint = segmentStart
                        .clone()
                        .lerp(segmentEnd, 0.5)
                        .applyMatrix4(object.matrixWorld);
                    irregularWallSide = side;
                }
            }
        };
        if (object instanceof IrregularWall) {
            findNearestSegment(object.bottomPoints, 'bottom');
            findNearestSegment(object.topPoints, 'top');
        } else {
            findNearestSegment(object.points3D);
            // Once a wall has height, its top outline is the most natural handle for
            // subsequent adjustments. Treat it exactly like the ground segment.
            if (object.wallHeight > 0) {
                findNearestSegment(object.points3D, undefined, new THREE.Vector3(0, 0, object.wallHeight));
            }
        }
        if (!midpoint) return;
        const base = this.cameraToCanvas(midpoint.clone());
        const up = this.cameraToCanvas(midpoint.clone().add(new THREE.Vector3(0, 0, 1))).sub(base);
        if (up.lengthSq() < 1) return;
        event.preventDefault();
        event.stopPropagation();
        this.clearHeightDrag();
        if (object instanceof IrregularWall && event.shiftKey) {
            // Shift means “set wall height”: keep the ground boundary fixed and
            // derive a uniform top boundary from it, matching the main-view
            // height gesture instead of translating whichever edge was clicked.
            const bottomPoints = object.bottomPoints.map((point) => point.clone());
            const beforeTopPoints = object.topPoints.map((point) => point.clone());
            const startHeight = beforeTopPoints.length > 0
                ? beforeTopPoints[0].z - bottomPoints[0].z
                : 0;
            const startPointer = new THREE.Vector2(event.clientX, event.clientY);
            let irregularWallHeightChanged = false;
            this.heightDragMove = (moveEvent: PointerEvent): void => {
                const delta = new THREE.Vector2(moveEvent.clientX, moveEvent.clientY).sub(startPointer);
                const height = Math.max(0, startHeight + delta.dot(up) / up.lengthSq());
                object.setSidePoints(
                    'top',
                    bottomPoints.map((point) => point.clone().add(new THREE.Vector3(0, 0, height))),
                );
                irregularWallHeightChanged = true;
                this.pointCloud.dispatchEvent({ type: Event.OBJECT_TRANSFORM, data: { object, option: { pointsChanged: true } } });
                this.pointCloud.render();
            };
            this.heightDragUp = (): void => {
                if (irregularWallHeightChanged) {
                    this.onIrregularWallPointsChange?.(
                        object,
                        'top',
                        object.topPoints.map((point) => point.clone()),
                        beforeTopPoints,
                    );
                }
                this.clearHeightDrag();
            };
            document.addEventListener('pointermove', this.heightDragMove);
            document.addEventListener('pointerup', this.heightDragUp);
            return;
        }
        const startHeight = object instanceof GroundPolyline ? object.wallHeight : 0;
        const startPoints = object instanceof IrregularWall && irregularWallSide
            ? (irregularWallSide === 'top' ? object.topPoints : object.bottomPoints).map((point) => point.clone())
            : [];
        const startPointer = new THREE.Vector2(event.clientX, event.clientY);
        let irregularWallHeightChanged = false;
        this.heightDragMove = (moveEvent: PointerEvent): void => {
            const delta = new THREE.Vector2(moveEvent.clientX, moveEvent.clientY).sub(startPointer);
            const heightDelta = delta.dot(up) / up.lengthSq();
            if (object instanceof IrregularWall && irregularWallSide) {
                object.setSidePoints(
                    irregularWallSide,
                    startPoints.map((point) => point.clone().add(new THREE.Vector3(0, 0, heightDelta))),
                );
                irregularWallHeightChanged = true;
                this.pointCloud.dispatchEvent({ type: Event.OBJECT_TRANSFORM, data: { object, option: { pointsChanged: true } } });
                this.pointCloud.render();
            } else if (object instanceof GroundPolyline) {
                this.onGroundPolylineHeightChange?.(
                    object,
                    Math.max(0, startHeight + heightDelta),
                );
            }
        };
        this.heightDragUp = (): void => {
            if (object instanceof IrregularWall && irregularWallSide && irregularWallHeightChanged) {
                const latestPoints = (irregularWallSide === 'top' ? object.topPoints : object.bottomPoints)
                    .map((point) => point.clone());
                this.onIrregularWallPointsChange?.(object, irregularWallSide, latestPoints, startPoints);
            }
            this.clearHeightDrag();
        };
        document.addEventListener('pointermove', this.heightDragMove);
        document.addEventListener('pointerup', this.heightDragUp);
    };

    private clearHeightDrag(): void {
        if (this.heightDragMove) {
            document.removeEventListener('pointermove', this.heightDragMove);
            this.heightDragMove = undefined;
        }
        if (this.heightDragUp) {
            document.removeEventListener('pointerup', this.heightDragUp);
            this.heightDragUp = undefined;
        }
    }
}

function distanceToScreenSegment(point: THREE.Vector2, start: THREE.Vector2, end: THREE.Vector2): number {
    const segment = end.clone().sub(start);
    const lengthSquared = segment.lengthSq();
    if (lengthSquared === 0) return point.distanceTo(start);
    const t = Math.max(0, Math.min(1, point.clone().sub(start).dot(segment) / lengthSquared));
    return point.distanceTo(start.addScaledVector(segment, t));
}
