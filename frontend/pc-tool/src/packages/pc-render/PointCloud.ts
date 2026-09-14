import * as THREE from 'three';
import RenderView from './renderView/Render';
// import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { Box, Rect, Box2D } from './objects';
import { Event } from './config';
import { AnnotateObject, Object2D } from './objects';
// import { PCDLoader } from './loader';
import { ITransform } from './type';
import { isArray } from 'lodash';
import TWEEN from '@tweenjs/tween.js';
import PointsMaterial from './material/PointsMaterial';
import { Points } from './points';
import * as _ from 'lodash';

export default class PointCloud extends THREE.EventDispatcher {
    scene: THREE.Scene;
    annotate3D: THREE.Group;
    annotate2D: Object2D[] = [];
    groupPoints: THREE.Group;
    groupTrack: THREE.Group;
    /** Transient two-point measurement graphics. Never part of annotation data. */
    groupMeasure: THREE.Group;
    selection: AnnotateObject[];
    selectionMap: Record<string, AnnotateObject>;
    renderViews: RenderView[];
    ground: THREE.PlaneHelper;
    trimBox: THREE.Box3Helper;
    pixelRatio: number;
    // loading
    loading: boolean = false;
    timeStamp: number = 0;
    //
    material: PointsMaterial = new PointsMaterial();
    selectColor: THREE.Color = new THREE.Color(1, 0, 0);
    highlightColor: THREE.Color = new THREE.Color(1, 0, 0);
    private renderTimer: number = 0;
    private tweenAnimationId: number = 0;
    private chunkPointIds = new Set<string>();

    constructor() {
        super();

        this.pixelRatio = 1;
        // this.pixelRatio = window.devicePixelRatio;
        this.scene = new THREE.Scene();
        // this.scene.autoUpdate = false;
        this.annotate3D = new THREE.Group();
        this.groupPoints = new THREE.Group();
        this.groupTrack = new THREE.Group();
        this.groupMeasure = new THREE.Group();

        let ground = new THREE.PlaneHelper(
            new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
            100,
            0xcccccc,
        );
        this.ground = ground;
        this.ground.visible = false;

        let box = new THREE.Box3(
            new THREE.Vector3(-100, -100, -100),
            new THREE.Vector3(100, 100, 100),
        );
        this.trimBox = new THREE.Box3Helper(box, new THREE.Color(0xffff00));
        this.trimBox.visible = false;

        this.scene.add(
            this.groupPoints,
            this.annotate3D,
            this.ground,
            this.trimBox,
            this.groupTrack,
            this.groupMeasure,
        );

        const axesHelper = new THREE.AxesHelper(100);
        axesHelper.visible = false;
        this.scene.add(axesHelper);

        this.selection = [];
        this.selectionMap = {};
        this.renderViews = [];

        // test
        // this.initStats();

        // @ts-ignore
        // window.pc = this;
    }

    initTween() {
        if (this.tweenAnimationId) return;
        const animate = (time: number) => {
            TWEEN.update(time);
            this.tweenAnimationId = requestAnimationFrame(animate);
        };
        this.tweenAnimationId = requestAnimationFrame(animate);
    }

    // general *************************************
    updateObjectTransform(object: THREE.Object3D, option: Partial<ITransform>) {
        //   console.log(scale, position)
        let { scale, position, rotation } = option;

        if (scale) object.scale.copy(scale);
        if (position) object.position.copy(position);
        if (rotation) object.rotation.copy(rotation);
        this.dispatchEvent({ type: Event.OBJECT_TRANSFORM, data: { object, option } });
        this.render();
    }

    update2DRect(object: Rect, option: { center?: THREE.Vector2; size?: THREE.Vector2 }) {
        //   console.log(scale, position)
        let { center, size } = option;

        if (center) object.center.copy(center);
        if (size) object.size.copy(size);
        this.dispatchEvent({ type: Event.OBJECT_2D_TRANSFORM, data: { object, option } });
        this.render();
    }

    update2DBox(
        object: Box2D,
        option: {
            positions2?: Record<number, THREE.Vector2>;
            positions1?: Record<number, THREE.Vector2>;
        },
    ) {
        //   console.log(scale, position)

        if (option.positions1) {
            Object.keys(option.positions1).forEach((index) => {
                object.positions1[index as any] = (option as any).positions1[index as any];
            });
        }

        if (option.positions2) {
            Object.keys(option.positions2).forEach((index) => {
                object.positions2[index as any] = (option as any).positions2[index as any];
            });
        }

        this.dispatchEvent({ type: Event.OBJECT_2D_TRANSFORM, data: { object, option } });
        this.render();
    }

    selectObject(object?: AnnotateObject | AnnotateObject[]) {
        let preSelection = this.selection;
        let selection: AnnotateObject[] = [];
        if (object) {
            selection = Array.isArray(object) ? object : [object];
        }
        // else {
        //     this.selection = [];
        // }
        // selection = selection.filter((item) => item.visible !== false);
        this.selection = selection;

        this.selectionMap = {};
        selection.forEach((e) => {
            this.selectionMap[e.uuid] = e;
        });

        this.dispatchEvent({
            type: Event.SELECT,
            data: { preSelection, curSelection: this.selection },
        });
        this.render();
    }
    selectObjectById(id: string) {
        const objects = [...this.getAnnotate3D(), ...this.getAnnotate2D()];
        this.selectObject(objects.find((o) => o.uuid == id));
    }
    addObject(objects: AnnotateObject | AnnotateObject[]) {
        if (!isArray(objects)) objects = [objects];

        objects.forEach((obj) => {
            // if (!obj.userData.id) obj.userData.id = THREE.MathUtils.generateUUID();
            if (obj instanceof THREE.Object3D) {
                if (this.annotate3D.children.indexOf(obj) < 0) this.annotate3D.add(obj);
            } else {
                if (this.annotate2D.indexOf(obj) < 0) this.annotate2D.push(obj);
            }
        });
        this.render();
        this.dispatchEvent({ type: Event.ADD_OBJECT, data: objects });
    }

    removeObject(objects: AnnotateObject | AnnotateObject[]) {
        if (!isArray(objects)) objects = [objects];
        // if (object.userData.type === ObjectType.ANNOTATE) {

        let updateSelect = false;
        objects.forEach((object) => {
            if (object instanceof THREE.Object3D) {
                this.annotate3D.remove(object);
            } else {
                let index = this.annotate2D.indexOf(object);
                if (index >= 0) this.annotate2D.splice(index, 1);
                // this.annotate2D.remove(object);
            }

            if (this.selectionMap[object.uuid]) {
                updateSelect = true;
                delete this.selectionMap[object.uuid];
            }
        });

        this.dispatchEvent({ type: Event.REMOVE_OBJECT, data: objects });

        if (updateSelect) {
            let selection = this.selection.filter((e) => this.selectionMap[e.uuid]);
            this.selectObject(selection);
        }

        this.render();
        // }
    }

    setObjectUserData(objects: AnnotateObject | AnnotateObject[], options: any | any[]) {
        if (!Array.isArray(objects)) objects = [objects];
        // if (!Array.isArray(options)) options = [options];

        objects.forEach((object, index) => {
            let option = Array.isArray(options) ? options[index] : options;
            Object.assign(object.userData, option);
        });

        this.dispatchEvent({ type: Event.USER_DATA_CHANGE, data: { objects, options } });
        this.render();
    }

    setVisible(objects: AnnotateObject | AnnotateObject[], visible: boolean) {
        if (!isArray(objects)) objects = [objects];

        objects.forEach((object) => {
            object.visible = visible;

            if (!visible && this.selection.length > 0 && this.selection[0] === object) {
                this.selectObject();
            }
        });

        this.dispatchEvent({ type: Event.VISIBLE_CHANGE, data: { objects, visible } });
        this.render();
    }

    addRenderView(view: RenderView) {
        if (this.renderViews.indexOf(view) >= 0) return;
        view.init();
        this.renderViews.push(view);
    }

    removeRenderView(view: RenderView) {
        let index = this.renderViews.indexOf(view);
        if (index < 0) return;

        this.renderViews.splice(index, 1);
        view.destroy();
    }

    getAnnotate3D() {
        return this.annotate3D.children as Box[];
    }

    getAnnotate2D() {
        return this.annotate2D;
    }

    clearData() {
        this.clearDistanceMeasure();
        this.selectObject();
        this.annotate3D.children = [];
        this.annotate2D = [];
        this.dispatchEvent({ type: Event.CLEAR_DATA });
        this.render();
    }

    // *********************************************
    setPointCloudData(data: any) {
        this.clearDistanceMeasure();
        this.clearPointCloudChunks();
        let points;
        if (this.groupPoints.children.length === 0) {
            points = new Points(this.material);
            // points.addEventListener(Event.POINTS_CHANGE, () => {
            //     this.dispatchEvent({ type: Event.POINTS_CHANGE });
            //     this.render();
            // });
            this.groupPoints.add(points);
        } else {
            points = this.groupPoints.children[0] as Points;
        }
        // this.dispatchEvent({ type: Event.LOAD_POINT_BEFORE });
        points.updateData(data);
        this.render();
        // this.dispatchEvent({ type: Event.LOAD_POINT_AFTER });
    }

    setPointCloudChunk(id: string, data: any) {
        this.clearDistanceMeasure();
        let points = this.groupPoints.children.find((child) => child.userData.chunkId === id) as Points;
        if (!points) {
            // The preview is replaced once the first high-density chunk arrives.
            if (this.chunkPointIds.size === 0) this.groupPoints.clear();
            points = new Points(this.material);
            points.userData.chunkId = id;
            this.groupPoints.add(points);
            this.chunkPointIds.add(id);
        }
        points.updateData(data);
        this.render();
    }

    clearDistanceMeasure(notify: boolean = true) {
        this.groupMeasure.traverse((object) => {
            const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
            if (geometry) geometry.dispose();
            const material = (object as THREE.Mesh).material as
                | THREE.Material
                | THREE.Material[]
                | undefined;
            if (Array.isArray(material)) material.forEach((item) => item.dispose());
            else material?.dispose();
        });
        this.groupMeasure.clear();
        if (notify) this.dispatchEvent({ type: Event.DISTANCE_MEASURE_CLEAR });
        this.render();
    }

    removePointCloudChunk(id: string) {
        const points = this.groupPoints.children.find((child) => child.userData.chunkId === id) as Points;
        if (!points) return;
        this.groupPoints.remove(points);
        (points.geometry as THREE.BufferGeometry).dispose();
        this.chunkPointIds.delete(id);
        this.render();
    }

    clearPointCloudChunks() {
        if (!this.chunkPointIds.size) return;
        [...this.groupPoints.children].forEach((child) => {
            if (child.userData.chunkId) {
                this.groupPoints.remove(child);
                ((child as THREE.Points).geometry as THREE.BufferGeometry).dispose();
            }
        });
        this.chunkPointIds.clear();
    }

    getVisibleChunkIds(chunks: Array<{ id: string; bounds: number[] }>): string[] {
        const view = this.renderViews.find((item: any) => item.camera && item.renderer) as any;
        if (!view) return chunks.map((chunk) => chunk.id);
        view.camera.updateMatrixWorld();
        const frustum = new THREE.Frustum().setFromProjectionMatrix(
            new THREE.Matrix4().multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse),
        );
        const visible = chunks.filter((chunk) => {
            const b = chunk.bounds;
            return Array.isArray(b) && b.length === 6 && frustum.intersectsBox(
                new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5])),
            );
        }).map((chunk) => chunk.id);
        // Never leave a valid manifest blank merely because the camera is outside its bounds.
        return visible.length ? visible : chunks.slice(0, 1).map((chunk) => chunk.id);
    }
    loadPointCloud(url: string, onProgress?: (percent: number) => void) {
        let points;
        if (this.groupPoints.children.length === 0) {
            // debugger;
            points = new Points(this.material);
            points.addEventListener(Event.POINTS_CHANGE, () => {
                this.dispatchEvent({ type: Event.POINTS_CHANGE });
                this.render();
            });
            this.groupPoints.add(points);
        } else {
            points = this.groupPoints.children[0] as Points;
        }
        return points.loadUrl(url, onProgress);
    }

    // render
    _render() {
        this.dispatchEvent({ type: Event.RENDER_BEFORE });
        this.renderViews.forEach((view) => {
            view.render();
        });
        this.renderTimer = 0;
        this.dispatchEvent({ type: Event.RENDER_AFTER });
    }

    render() {
        if (this.renderTimer) return;
        this.renderTimer = requestAnimationFrame(this._render.bind(this));
    }

    destroy(): void {
        if (this.tweenAnimationId) {
            cancelAnimationFrame(this.tweenAnimationId);
            this.tweenAnimationId = 0;
        }
        if (this.renderTimer) {
            cancelAnimationFrame(this.renderTimer);
            this.renderTimer = 0;
        }
        [...this.renderViews].forEach((view) => this.removeRenderView(view));
        const geometries = new Set<THREE.BufferGeometry>();
        const materials = new Set<THREE.Material>();
        this.scene.traverse((object) => {
            const renderObject = object as THREE.Mesh;
            if (renderObject.geometry instanceof THREE.BufferGeometry) {
                geometries.add(renderObject.geometry);
            }
            const objectMaterial = renderObject.material;
            if (Array.isArray(objectMaterial)) {
                objectMaterial.forEach((material) => materials.add(material));
            } else if (objectMaterial instanceof THREE.Material) {
                materials.add(objectMaterial);
            }
        });
        geometries.forEach((geometry) => geometry.dispose());
        materials.forEach((material) => material.dispose());
        this.scene.clear();
        this.annotate2D = [];
        this.selection = [];
        this.selectionMap = {};
    }
}
