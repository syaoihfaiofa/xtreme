import * as THREE from 'three';
import * as _ from 'lodash';

import { Event } from '../config';
import MainRenderView from '../renderView/MainRenderView';
import Action from './Action';
import OrbitControlsAction from './OrbitControlsAction';

interface Point {
    x: number;
    y: number;
}

type ICallback = (data: any) => void;

const TypePoints = {
    'points-1': 1,
    'points-3': 3,
    'points-4': 4,
    polyline: Infinity,
    'box-2': 4,
    box: 2,
};

type DrawType = keyof typeof TypePoints;

interface IStartOption {
    type: DrawType;
    trackLine?: boolean;
    startClick?: boolean;
    startMouseDown?: boolean;
    endOnDoubleClick?: boolean;
    pointSpace?: 'canvas' | 'ground';
}

export default class CreateAction extends Action {
    static actionName: string = 'create-obj';
    renderView: MainRenderView;
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    points: Point[] = [];
    raycaster: THREE.Raycaster;
    drawType: DrawType = 'points-3';
    startClick: boolean = true;
    startMouseDown: boolean = false;
    trackLine: boolean = false;
    endOnDoubleClick: boolean = false;
    callback: ICallback | undefined | null = null;
    onChange: ICallback | undefined | null = null;
    pointSpace: 'canvas' | 'ground' = 'canvas';
    private pendingClick?: { event: MouseEvent; timer: number };
    private readonly worldPoints: THREE.Vector3[] = [];
    private lastPointer: Point | null = null;
    private rightDragStart: THREE.Vector2 | null = null;
    private rightDragMoved: boolean = false;
    private readonly rightDragThreshold: number = 4;
    private readonly onRender = (): void => {
        if (
            this.pointSpace === 'ground' &&
            this.canvas.style.display === 'block' &&
            this.lastPointer
        ) {
            this.drawPoint3(this.lastPointer);
        }
    };

    constructor(renderView: MainRenderView) {
        super();

        this.renderView = renderView;
        this.raycaster = new THREE.Raycaster();

        let canvas = document.createElement('canvas');
        canvas.className = 'create-obj';
        canvas.style.position = 'absolute';
        canvas.style.left = '0px';
        canvas.style.top = '0px';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'none';
        canvas.style.cursor = 'crosshair';

        let context = canvas.getContext('2d') as any;

        this.canvas = canvas;
        this.context = context;

        this.onClick = this.onClick.bind(this);
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onDoubleClick = this.onDoubleClick.bind(this);
        this.onContextMenu = this.onContextMenu.bind(this);

        this.drawBox = _.throttle(this.drawBox.bind(this), 30);
        this.drawPoint3 = _.throttle(this.drawPoint3.bind(this), 30);
        // this.toggle(false);
    }

    init() {
        let dom = this.renderView.container;
        dom.appendChild(this.canvas);
        // this.start();
        this.canvas.addEventListener('click', this.onClick);
        this.canvas.addEventListener('mousedown', this.onMouseDown);
        this.canvas.addEventListener('mouseup', this.onMouseUp);
        this.canvas.addEventListener('mousemove', this.onMouseMove);
        this.canvas.addEventListener('dblclick', this.onDoubleClick);
        this.canvas.addEventListener('contextmenu', this.onContextMenu);
        this.renderView.addEventListener(Event.RENDER_AFTER, this.onRender);
    }

    destroy() {
        this.canvas.removeEventListener('click', this.onClick);
        this.canvas.removeEventListener('mousedown', this.onMouseDown);
        this.canvas.removeEventListener('mouseup', this.onMouseUp);
        this.canvas.removeEventListener('mousemove', this.onMouseMove);
        this.canvas.removeEventListener('dblclick', this.onDoubleClick);
        this.canvas.removeEventListener('contextmenu', this.onContextMenu);
        this.renderView.removeEventListener(Event.RENDER_AFTER, this.onRender);
    }

    start(option: IStartOption, callback: ICallback, onChange?: ICallback): void {
        if (this.canvas.style.display === 'block') return;

        let {
            type = 'points-3',
            trackLine = false,
            startClick = true,
            startMouseDown = false,
            endOnDoubleClick = false,
            pointSpace = 'canvas',
        } = option;

        this.drawType = type;
        this.trackLine = trackLine;
        this.startClick = startClick;
        this.startMouseDown = startMouseDown;
        this.endOnDoubleClick = endOnDoubleClick;
        this.pointSpace = pointSpace;
        // this.toggle(true);
        this.callback = callback;
        this.onChange = onChange;

        this.canvas.style.display = 'block';
        this.points = [];
        this.worldPoints.splice(0);
        this.lastPointer = null;
        this.rightDragStart = null;
        this.rightDragMoved = false;
        this.clearPendingClick();
        if (this.pointSpace === 'ground') {
            const orbit = this.renderView.getAction('orbit-control') as OrbitControlsAction;
            orbit.useDrawingElement(this.canvas);
        }

        this.clear();
    }

    end(): void {
        this.clearPendingClick();
        if (this.pointSpace === 'ground' && this.canvas.style.display === 'block') {
            const orbit = this.renderView.getAction('orbit-control') as OrbitControlsAction;
            orbit.restoreRenderElement();
        }
        this.lastPointer = null;
        this.rightDragStart = null;
        this.rightDragMoved = false;
        this.canvas.style.display = 'none';
    }

    setStyle() {
        let context = this.context;
        context.setLineDash([]);
        context.lineWidth = 1;

        context.strokeStyle = '#fcff4b';
        context.fillStyle = '#fcff4b';

        // switch (this.drawType) {
        //     case 'points-3':
        //         context.strokeStyle = '#fcff4b';
        //         context.fillStyle = '#fcff4b';
        //         break;
        //     case 'box':
        //         context.strokeStyle = '#fcff4b';
        //         context.fillStyle = '#fcff4b';
        //         break;
        // }
    }

    clear() {
        let context = this.context;

        if (
            this.canvas.width !== this.canvas.clientWidth ||
            this.canvas.height !== this.canvas.clientHeight
        ) {
            this.canvas.width = this.canvas.clientWidth;
            this.canvas.height = this.canvas.clientHeight;
        }

        context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    drawTrackLine(pos: Point) {
        let context = this.context;
        let { width, height } = this.canvas;

        // context.beginPath();
        context.fillStyle = 'red';
        context.strokeStyle = 'red';
        context.lineWidth = 1;
        context.beginPath();
        context.setLineDash([2, 2]);

        context.moveTo(0, pos.y);
        context.lineTo(width, pos.y);

        context.moveTo(pos.x, 0);
        context.lineTo(pos.x, height);
        context.stroke();

        context.setLineDash([]);
    }

    drawPoint3(pos: Point): void {
        let context = this.context;
        this.lastPointer = { x: pos.x, y: pos.y };

        this.clear();

        if (this.trackLine) this.drawTrackLine(pos);

        context.beginPath();
        this.setStyle();

        const previewPoints = this.getPreviewPoints();
        previewPoints.forEach((p, index) => {
            if (index === 0) context.moveTo(p.x, p.y);
            else context.lineTo(p.x, p.y);
        });

        if (previewPoints.length > 0) context.lineTo(pos.x, pos.y);
        else {
            this.drawPointer(pos);
        }

        context.stroke();
    }

    drawBox(pos: Point) {
        let context = this.context;

        this.clear();
        if (this.trackLine) this.drawTrackLine(pos);

        context.beginPath();
        this.setStyle();

        if (this.points.length > 0) {
            let point = this.points[0];
            this.context.strokeRect(pos.x, pos.y, point.x - pos.x, point.y - pos.y);
        } else {
            this.drawPointer(pos);
        }

        context.stroke();
    }

    drawBox2(pos: Point) {
        let context = this.context;

        this.clear();
        if (this.trackLine) this.drawTrackLine(pos);

        context.beginPath();
        this.setStyle();
        let len = this.points.length;
        if (len > 0) {
            if (len >= 2) {
                let p1 = this.points[0];
                let p2 = this.points[1];
                this.context.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
            }

            if (len === 1 || len === 3) {
                let point = len === 1 ? this.points[0] : this.points[2];
                this.context.strokeRect(pos.x, pos.y, point.x - pos.x, point.y - pos.y);
            }
        }

        if (len === 0 || len === 2) {
            this.drawPointer(pos);
        }

        context.stroke();
    }

    drawPointer(pos: Point) {
        this.context.fillRect(pos.x - 3, pos.y - 3, 6, 6);
    }

    onMouseMove(event: MouseEvent): void {
        event.stopPropagation();
        if (this.rightDragStart) {
            const distance = this.rightDragStart.distanceTo(
                new THREE.Vector2(event.clientX, event.clientY),
            );
            if (distance > this.rightDragThreshold) this.rightDragMoved = true;
        }
        const canvasPoint = this.canvasEventPoint(event);
        let pos = { x: canvasPoint.x, y: canvasPoint.y };
        switch (this.drawType) {
            case 'points-1':
            case 'points-3':
            case 'points-4':
            case 'polyline':
                // console.time('test-3');

                this.drawPoint3(pos);
                // console.timeEnd('test-3');

                break;
            case 'box':
                // console.time('test-box');

                this.drawBox(pos);
                // console.timeEnd('test-box');

                break;
            case 'box-2':
                // console.time('test-box');

                this.drawBox2(pos);
                // console.timeEnd('test-box');

                break;
        }
    }

    handleCallback(): void {
        if (this.callback) {
            this.callback(
                this.pointSpace === 'ground'
                    ? this.worldPoints.map((point) => point.clone())
                    : this.points,
            );
        }
    }

    onMouseUp(event: MouseEvent): void {
        event.stopPropagation();
        if (!this.enabled || !this.startMouseDown) return;
        this.handleMouse(event);
    }

    onMouseDown(event: MouseEvent): void {
        event.stopPropagation();
        if (event.button === 2 && this.pointSpace === 'ground') {
            this.rightDragStart = new THREE.Vector2(event.clientX, event.clientY);
            this.rightDragMoved = false;
        }
        if (!this.enabled || !this.startMouseDown) return;
        this.handleMouse(event);
    }

    onClick(event: MouseEvent): void {
        event.stopPropagation();
        if (!this.enabled || !this.startClick) return;
        if (this.endOnDoubleClick) {
            if (event.detail > 1) return;
            this.commitPendingClick();
            const timer = window.setTimeout(() => {
                if (this.pendingClick?.event === event) {
                    this.handleMouse(event);
                    this.pendingClick = undefined;
                }
            }, 250);
            this.pendingClick = { event, timer };
            return;
        }
        this.handleMouse(event);
    }
    onDoubleClick(event: MouseEvent): void {
        event.stopPropagation();
        if (!this.enabled || !this.endOnDoubleClick) return;
        this.clearPendingClick();
        if (this.getPointCount() < 2) return;
        this.end();
        this.handleCallback();
    }
    onContextMenu(event: MouseEvent): void {
        if (!this.enabled || !this.endOnDoubleClick) return;
        event.preventDefault();
        event.stopPropagation();
        this.commitPendingClick();
        if (this.rightDragMoved || this.getPointCount() < 2) return;
        this.end();
        this.handleCallback();
    }

    handleMouse(event: MouseEvent): void {
        this.addPoint(event);

        if (this.onChange) {
            this.onChange(this.pointSpace === 'ground' ? this.worldPoints : this.points);
        }

        if (this.getPointCount() >= TypePoints[this.drawType]) {
            this.end();
            this.handleCallback();
        }
    }

    private commitPendingClick(): void {
        if (!this.pendingClick) return;
        window.clearTimeout(this.pendingClick.timer);
        this.handleMouse(this.pendingClick.event);
        this.pendingClick = undefined;
    }

    private clearPendingClick(): void {
        if (!this.pendingClick) return;
        window.clearTimeout(this.pendingClick.timer);
        this.pendingClick = undefined;
    }

    private canvasEventPoint(event: MouseEvent): THREE.Vector2 {
        const rect = this.canvas.getBoundingClientRect();
        return new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
    }

    private addPoint(event: MouseEvent): void {
        const canvasPoint = this.canvasEventPoint(event);
        if (this.pointSpace === 'ground') {
            const worldPoint = this.renderView.canvasToWorld(canvasPoint);
            worldPoint.z = this.renderView.pointCloud.ground.plane.constant;
            this.worldPoints.push(worldPoint);
            return;
        }
        this.points.push({ x: canvasPoint.x, y: canvasPoint.y });
    }

    private getPreviewPoints(): Point[] {
        if (this.pointSpace !== 'ground') return this.points;
        return this.worldPoints.map((worldPoint) => {
            const projected = worldPoint.clone().project(this.renderView.camera);
            return {
                x: ((projected.x + 1) / 2) * this.canvas.clientWidth,
                y: (1 - (projected.y + 1) / 2) * this.canvas.clientHeight,
            };
        });
    }

    private getPointCount(): number {
        return this.pointSpace === 'ground' ? this.worldPoints.length : this.points.length;
    }
}
