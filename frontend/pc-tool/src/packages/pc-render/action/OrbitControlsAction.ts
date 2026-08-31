import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import * as THREE from 'three';

import MainRenderView from '../renderView/MainRenderView';
import Action from './Action';

export default class OrbitControlsAction extends Action {
    static actionName: string = 'orbit-control';
    renderView: MainRenderView;
    control: OrbitControls;

    constructor(renderView: MainRenderView) {
        super();

        this.renderView = renderView;
        this.controlChange = this.controlChange.bind(this);
        this.control = this.createControl(
            renderView.renderer.domElement,
            new THREE.Vector3(),
            true,
        );
    }

    init(): void {
        // this.renderView.pointCloud.addEventListener(Event.SELECT, this.selectChange);
        // this.renderView.pointCloud.addEventListener(Event.OBJECT_TRANSFORM, this.transformChange);
    }

    transformChange(data: any) {
        let object = data.object as THREE.Object3D;
        this.focus(object.position);
    }

    selectChange() {
        let { selection } = this.renderView.pointCloud;
        if (selection.length === 1 || selection[0] instanceof THREE.Object3D) {
            let object = selection[0] as THREE.Object3D;
            this.focus(object.position);
        } else {
            this.focus();
        }
    }

    focus(pos?: THREE.Vector3) {
        if (pos) {
            this.control.target.copy(pos);
        } else {
            this.control.target.set(0, 0, 0);
        }

        // this.control.update();
    }

    toggle(enabled: boolean) {
        this.control.enabled = enabled;
    }

    useDrawingElement(domElement: HTMLElement): void {
        this.replaceControl(domElement, true);
    }

    restoreRenderElement(): void {
        this.replaceControl(this.renderView.renderer.domElement, false);
    }

    controlChange() {
        this.renderView.render();
        this.renderView.pointCloud.dispatchEvent({ type: 'point-cloud-view-change' });
    }

    destroy(): void {
        this.control.removeEventListener('change', this.controlChange);
        this.control.dispose();
    }

    private createControl(
        domElement: HTMLElement,
        target: THREE.Vector3,
        enabled: boolean,
    ): OrbitControls {
        const control = new OrbitControls(this.renderView.camera, domElement);
        control.maxDistance = 1000;
        control.minDistance = 10;
        control.target.copy(target);
        control.enabled = enabled;
        control.addEventListener('change', this.controlChange);
        return control;
    }

    private replaceControl(domElement: HTMLElement, drawing: boolean): void {
        const target = this.control.target.clone();
        const enabled = this.control.enabled;
        this.control.removeEventListener('change', this.controlChange);
        this.control.dispose();
        this.control = this.createControl(domElement, target, enabled);
        if (drawing) {
            this.control.mouseButtons.LEFT = -1 as THREE.MOUSE;
            this.control.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
            this.control.mouseButtons.RIGHT = THREE.MOUSE.PAN;
        }
        this.control.update();
    }
}
