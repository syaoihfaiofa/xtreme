import * as THREE from 'three';
import Box from '../objects/Box';
import GroundPolygon from '../objects/GroundPolygon';
import GroundPolyline from '../objects/GroundPolyline';
import Render from './Render';
import PointCloud from '../PointCloud';
import { Event } from '../config';
import PointsMaterial from '../material/PointsMaterial';
import * as _ from 'lodash';

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
const defaultActions = ['resize-translate'];

export default class SideRenderView extends Render {
    container: HTMLDivElement;
    pointCloud: PointCloud;
    width: number;
    height: number;
    renderer: THREE.WebGLRenderer;
    camera: THREE.OrthographicCamera;
    cameraHelper?: THREE.CameraHelper;
    object: Box | GroundPolygon | GroundPolyline | null;
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
    onGroundPolylinePointsChange?: (object: GroundPolyline, points: THREE.Vector3[]) => void;
    private readonly vertexHandleLayer: HTMLDivElement;
    private readonly vertexHandles: HTMLDivElement[] = [];
    private selectedVertexIndex: number | null = null;
    private readonly onSelect = () => {
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
        if (
            object &&
            object instanceof THREE.Object3D &&
            object === this.object &&
            this.needFit &&
            this.enableFit
        ) {
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

        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        let bbox = object.geometry.boundingBox as any as THREE.Box3;

        const projectBoundingBox = bbox
            .clone()
            .applyMatrix4(object.matrixWorld)
            .applyMatrix4(camera.matrixWorldInverse);
        this.projectRect.copy(projectBoundingBox);
        //  = { min, max };
        // return ;
    }

    private resolveSideTarget(): Box | GroundPolygon | GroundPolyline | null {
        const target = this.pointCloud.selection.find(
            (annotate) =>
                (annotate instanceof Box || annotate instanceof GroundPolygon || annotate instanceof GroundPolyline) &&
                annotate.parent === this.pointCloud.annotate3D,
        );
        return target instanceof Box || target instanceof GroundPolygon || target instanceof GroundPolyline
            ? target
            : null;
    }

    fitObject(object?: Box | GroundPolygon | GroundPolyline) {
        // console.log('fitObject');
        if (object) this.object = object;

        object = this.object as Box | GroundPolygon | GroundPolyline;
        if (!object) return;

        object.updateMatrixWorld();

        let temp = new THREE.Vector3();
        if (object instanceof GroundPolygon || object instanceof GroundPolyline) {
            if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
            const center = (object.geometry.boundingBox as THREE.Box3)
                .getCenter(temp)
                .applyMatrix4(object.matrixWorld);
            const axisValue = this.axis.replace('-', '') as 'x' | 'y' | 'z';
            const direction = new THREE.Vector3();
            direction[axisValue] = this.axis.startsWith('-') ? -1 : 1;
            this.camera.position.copy(center).addScaledVector(direction, 5);
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
        // Ground polygons have zero thickness along one or more axes. A zero
        // far plane invalidates the orthographic camera and prevents the next
        // selected 3D box from rendering in this side view.
        this.camera.far =
            this.object instanceof GroundPolygon || this.object instanceof GroundPolyline
                ? 200
                : Math.max(projectRect.max.z - projectRect.min.z, 10);
        this.camera.updateProjectionMatrix();

        // this.camera.position.add(this.cameraOffset);
        // this.camera.updateMatrixWorld();
        // this.camera.far = 0;
        this.cameraHelper?.update();
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
            if (hasObject3D instanceof GroundPolygon || hasObject3D instanceof GroundPolyline) {
                const groupPoint = groupPoints.children[0] as THREE.Points;
                const material = groupPoint.material as PointsMaterial;
                const oldDepthTest = material.depthTest;
                const oldHasFilterBox = material.getUniforms('hasFilterBox');
                const oldType = material.getUniforms('boxInfo').type;

                material.depthTest = false;
                material.setUniforms({ hasFilterBox: -1 });
                try {
                    this.renderer.render(groupPoint, this.camera);
                } finally {
                    material.setUniforms({
                        hasFilterBox: oldHasFilterBox,
                        boxInfo: { type: oldType },
                    });
                    material.depthTest = oldDepthTest;
                }
                this.renderer.render(hasObject3D, this.camera);
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

            material.depthTest = false;
            material.setUniforms({
                hasFilterBox: 1,
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
            } finally {
                material.setUniforms({ hasFilterBox: oldHasFilterBox, boxInfo: { type: oldType } });
                material.depthTest = oldDepthTest;
            }

            // render box
            selection.forEach((object) => {
                // The selected Box is represented by the editable RectTool overlay.
                // Rendering it here as well creates two overlapping frames in side views.
                if (object === box) return;
                if (object instanceof THREE.Object3D) {
                    this.renderer.render(object, this.camera);
                }
            });
        } else {
            this.renderer.render(groupPoints, this.camera);
        }

        this.updateProjectRect();
        this.updateGroundPolygonVertexHandles();
        // console.log('renderFrame');
        // this.updateDom();
    }

    destroy(): void {
        super.destroy();
        this.pointCloud.removeEventListener(Event.SELECT, this.onSelect);
        this.pointCloud.removeEventListener(Event.OBJECT_TRANSFORM, this.onObjectTransform);
        this.pointCloud.scene.remove(this.camera);
        this.cameraHelper?.dispose();
        this.renderer.dispose();
        this.renderer.forceContextLoss();
        this.renderer.domElement.remove();
        this.vertexHandleLayer.remove();
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

    private updateGroundPolygonVertexHandles(): void {
        const object = this.resolveSideTarget();
        if (!(object instanceof GroundPolygon) && !(object instanceof GroundPolyline)) {
            this.vertexHandleLayer.style.display = 'none';
            return;
        }

        object.updateMatrixWorld();
        this.camera.updateMatrixWorld();
        this.vertexHandleLayer.style.display = 'block';
        this.ensureVertexHandles(object.points3D.length);
        object.points3D.forEach((point, index) => {
            const canvasPoint = this.cameraToCanvas(point.clone().applyMatrix4(object.matrixWorld));
            const handle = this.vertexHandles[index];
            handle.dataset.index = String(index);
            handle.style.display = 'block';
            handle.style.left = `${canvasPoint.x}px`;
            handle.style.top = `${canvasPoint.y}px`;
            handle.style.background = this.selectedVertexIndex === index ? '#00e5ff' : '#10252a';
        });
        this.vertexHandles.slice(object.points3D.length).forEach((handle) => {
            handle.style.display = 'none';
        });
    }

    private startGroundPolygonVertexDrag(event: PointerEvent, index: number): void {
        const object = this.object;
        if (
            !(object instanceof GroundPolygon) &&
            !(object instanceof GroundPolyline)
        ) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        this.selectedVertexIndex = index;
        this.updateGroundPolygonVertexHandles();
        this.enableFit = false;
        const start = new THREE.Vector2(event.clientX, event.clientY);
        const points = object.points3D.map((point) => point.clone());
        const right = new THREE.Vector3(1, 0, 0).transformDirection(this.camera.matrixWorld);
        const up = new THREE.Vector3(0, 1, 0).transformDirection(this.camera.matrixWorld);
        const worldPerPixelX = (this.camera.right - this.camera.left) / this.width;
        const worldPerPixelY = (this.camera.top - this.camera.bottom) / this.height;

        const onMove = (moveEvent: PointerEvent): void => {
            const candidate = points.map((point) => point.clone());
            candidate[index]
                .addScaledVector(right, (moveEvent.clientX - start.x) * worldPerPixelX)
                .addScaledVector(up, (start.y - moveEvent.clientY) * worldPerPixelY);
            if (object instanceof GroundPolygon) {
                if (!GroundPolygon.isValidPoints(candidate)) return;
                this.onGroundPolygonPointsChange?.(object, candidate);
            } else {
                this.onGroundPolylinePointsChange?.(object, candidate);
            }
        };
        const onUp = (): void => {
            this.enableFit = true;
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    }
}
