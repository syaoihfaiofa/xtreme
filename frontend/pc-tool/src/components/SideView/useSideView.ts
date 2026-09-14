import { onMounted, onBeforeUnmount, reactive, toRefs, computed, Ref } from 'vue';
import * as THREE from 'three';
import {
    GroundPolygon,
    GroundPolyline,
    IrregularWall,
    SideRenderView,
    PointCloud,
    axisType,
    Event,
    ResizeTransAction,
} from 'pc-render';
import { IActionName } from 'pc-editor';
import { useInjectEditor } from '../../state';
import * as locale from './lang';

interface SideViewProps {
    axis: axisType;
}

export default function useSideView(dom: Ref<HTMLDivElement | null>, props: SideViewProps) {
    let view = {} as SideRenderView;
    let editor = useInjectEditor();
    let $$ = editor.bindLocale(locale);
    let pc = editor.pc;
    let actionName = '' as IActionName;
    let actionTimer = -1 as any;

    let state = reactive({
        axis: props.axis,
        size: new THREE.Vector3(),
        groundShapeMetrics: {
            visible: false,
            parkingSlot: false,
            lineLength: 0,
            height: 0,
            length: 0,
            width: 0,
            area: 0,
            irregularWall: false,
        },
        // title: titleMap[props.axis as axisType],
    });

    let title = computed(() => {
        let title = '';
        switch (props.axis) {
            case 'z':
                title = $$('side_overhead');
                break;
            case '-y':
                title = $$('side_side');
                break;
            case '-x':
                title = $$('side_near');
                break;
        }
        return title;
    });

    //**************life hook******************
    onMounted(() => {
        if (dom.value) {
            view = new SideRenderView(dom.value, pc, {
                axis: state.axis,
            });

            // let action = view.getAction('resize-translate') as ResizeTransAction;
            // if (action && (state.axis === '-y' || state.axis === '-x')) action.rotatable = false;

            pc.addRenderView(view);
        }

        view.addEventListener(Event.RENDER_AFTER, onRender);
    });

    onBeforeUnmount(() => {
        clearAction();
        view.removeEventListener(Event.RENDER_AFTER, onRender);
        pc.removeRenderView(view);
    });
    // ************************************

    function onRender() {
        if (!view.object) {
            state.size.set(0, 0, 0);
            state.groundShapeMetrics.visible = false;
            return;
        }
        let box = view.object;
        state.size.copy(box.scale);
        if (box instanceof GroundPolygon) {
            box.updateMatrixWorld();
            const points = box.points3D.map((point) => point.clone().applyMatrix4(box.matrixWorld));
            state.groundShapeMetrics.visible = true;
            state.groundShapeMetrics.parkingSlot = true;
            state.groundShapeMetrics.irregularWall = false;
            // P0-P1/P3-P2 run along the parking space; P0-P3/P1-P2 span its width.
            state.groundShapeMetrics.length = averageEdgeLength(points, 0, 1, 3, 2);
            state.groundShapeMetrics.width = averageEdgeLength(points, 0, 3, 1, 2);
            state.groundShapeMetrics.area = getQuadrilateralArea(points);
        } else if (box instanceof GroundPolyline || box instanceof IrregularWall) {
            box.updateMatrixWorld();
            const bottomPoints = (box instanceof IrregularWall ? box.bottomPoints : box.points3D).map(
                (point) => point.clone().applyMatrix4(box.matrixWorld),
            );
            state.groundShapeMetrics.visible = true;
            state.groundShapeMetrics.parkingSlot = false;
            state.groundShapeMetrics.irregularWall = box instanceof IrregularWall;
            state.groundShapeMetrics.lineLength = getPolylineLength(bottomPoints);
            state.groundShapeMetrics.height =
                box instanceof GroundPolyline
                    ? getWorldHeight(box, box.wallHeight)
                    : getIrregularWallAverageHeight(box);
        } else {
            state.groundShapeMetrics.visible = false;
        }
    }

    function getPolylineLength(points: THREE.Vector3[]): number {
        return points.slice(1).reduce((total, point, index) => total + point.distanceTo(points[index]), 0);
    }

    function averageEdgeLength(
        points: THREE.Vector3[],
        firstStart: number,
        firstEnd: number,
        secondStart: number,
        secondEnd: number,
    ): number {
        return (points[firstStart].distanceTo(points[firstEnd]) + points[secondStart].distanceTo(points[secondEnd])) / 2;
    }

    function getQuadrilateralArea(points: THREE.Vector3[]): number {
        if (points.length !== 4) return 0;
        return (
            new THREE.Triangle(points[0], points[1], points[2]).getArea() +
            new THREE.Triangle(points[0], points[2], points[3]).getArea()
        );
    }

    function getWorldHeight(object: THREE.Object3D, height: number): number {
        const origin = object.getWorldPosition(new THREE.Vector3());
        return new THREE.Vector3(0, 0, height)
            .applyMatrix4(object.matrixWorld)
            .sub(origin)
            .length();
    }

    function getIrregularWallAverageHeight(wall: IrregularWall): number {
        if (wall.topPoints.length < 2 || wall.bottomPoints.length < 2) return 0;
        const averageZ = (points: THREE.Vector3[]) =>
            points.reduce((total, point) => total + point.clone().applyMatrix4(wall.matrixWorld).z, 0) /
            points.length;
        return Math.max(0, averageZ(wall.topPoints) - averageZ(wall.bottomPoints));
    }

    function onDBLclick() {
        view.zoom = 1;
        view.enableFit = true;
        view.fitObject();
        view.render();
    }

    function onAction(name: IActionName) {
        actionName = name;
        handleAction();
        handleInterval();
    }

    function handleAction() {
        editor.actionManager.execute(actionName);
        if (!view.enableFit) {
            onDBLclick();
        }
    }

    function handleInterval() {
        if (actionTimer >= 0) return;

        document.addEventListener('mouseup', onDocMouseUp);
        actionTimer = setInterval(() => {
            handleAction();
        }, 50);
    }

    function onDocMouseUp() {
        if (actionTimer < 0) return;
        document.removeEventListener('mouseup', onDocMouseUp);
        clearInterval(actionTimer);
        actionTimer = -1;
    }

    function clearAction() {
        document.removeEventListener('mouseup', onDocMouseUp);
        if (actionTimer >= 0) {
            clearInterval(actionTimer);
            actionTimer = -1;
        }
    }

    return {
        ...toRefs(state),
        $$,
        title,
        onDBLclick,
        onAction,
        clearAction,
    };
}
