import MainRenderView from '../renderView/MainRenderView';
import Action from './Action';
import * as THREE from 'three';
import { ViewHelper, UIElement, viewType } from '../common/ViewHelper';
import OrbitControlsAction from './OrbitControlsAction';
import { Event } from '../config';

export default class ViewHelperAction extends Action {
    static actionName: string = 'view-helper';
    private listener: () => void;
    private panel: HTMLDivElement;
    private pointerUpHandler: (event: PointerEvent) => void;
    private pointerDownHandler: (event: PointerEvent) => void;
    renderView: MainRenderView;
    viewHelper: ViewHelper;
    constructor(renderView: MainRenderView) {
        super();
        this.enabled = true;
        this.renderView = renderView;
        const controls = (renderView.actionMap['orbit-control'] as OrbitControlsAction).control;
        let viewHelper = new ViewHelper(renderView, controls);

        const dom = document.createElement('div');
        dom.style.cssText = 'position:absolute;right:0px;bottom:0px;height:128px;width:128px;';
        const panel = new UIElement(dom);
        panel.setId('viewHelper');
        this.pointerUpHandler = (event: PointerEvent): void => {
            event.stopPropagation();
            viewHelper.handleClick(event);
        };
        this.pointerDownHandler = (event: PointerEvent): void => {
            event.stopPropagation();
        };
        panel.dom.addEventListener('pointerup', this.pointerUpHandler);
        panel.dom.addEventListener('pointerdown', this.pointerDownHandler);

        renderView.container.appendChild(panel.dom);
        this.panel = panel.dom;
        this.listener = () => {
            viewHelper.render(renderView.renderer);
        };
        this.viewHelper = viewHelper;
    }
    view(type: viewType): Promise<boolean> {
        return this.viewHelper.view(type);
    }
    destroy(): void {
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.listener);
        this.panel.removeEventListener('pointerup', this.pointerUpHandler);
        this.panel.removeEventListener('pointerdown', this.pointerDownHandler);
        this.panel.remove();

        const geometries = new Set<THREE.BufferGeometry>();
        const materials = new Set<THREE.Material>();
        this.viewHelper.traverse((object) => {
            const renderObject = object as THREE.Mesh;
            if (renderObject.geometry instanceof THREE.BufferGeometry) {
                geometries.add(renderObject.geometry);
            }
            const material = renderObject.material;
            if (Array.isArray(material)) {
                material.forEach((item) => materials.add(item));
            } else if (material instanceof THREE.Material) {
                materials.add(material);
            }
        });
        geometries.forEach((geometry) => geometry.dispose());
        materials.forEach((material) => {
            if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
            material.dispose();
        });
        this.viewHelper.clear();
    }
    init() {
        let renderView = this.renderView;
        renderView.addEventListener(Event.RENDER_AFTER, this.listener);
    }
}
