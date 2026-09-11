import { reactive, toRefs, watch } from 'vue';
import { useInjectEditor } from '../../state';
import { allItems } from './item';
import { IActionName } from 'pc-editor';
import {
    Image2DRenderView,
    CreateAction,
    Box,
    GroundPolygon,
    GroundPolyline,
    IrregularWall,
    Object2D,
    SplitGroundShapeAction,
} from 'pc-render';
import { IModelResult, IModel } from 'pc-editor';
import * as api from '../../api';
import * as locale from './lang';

let createActions: IActionName[] = [
    'create2DBox',
    'create2DRect',
    'createObjectWith3',
    'createParkingSlot',
    'createGroundPolyline',
    'createIrregularWall',
    'pickObject',
];

export interface IConfig {
    noUtility?: boolean;
    noAnnotate?: boolean;
}

export interface IClass {
    label: string;
    value: string;
    selected: boolean;
}
export default function useTool() {
    let editor = useInjectEditor();
    const $$ = editor.bindLocale(locale);
    let innerState = reactive({
        tools: allItems,
    });
    function onTool(name: string) {
        let config = editor.state.config;
        if (name !== 'splitGroundShape' && config.groundShapeSplitEdit) {
            stopGroundShapeSplit();
        }
        switch (name) {
            case 'create2DBox':
                stopOtherCreateAction('create2DBox');
                editor.actionManager.execute('create2DBox');

                break;
            case 'create3DBox':
                stopOtherCreateAction('createObjectWith3');
                editor.actionManager.execute('createObjectWith3');

                break;
            case 'createParkingSlot':
                stopOtherCreateAction('createParkingSlot');
                editor.actionManager.execute('createParkingSlot');
                editor.parkingDensityManager?.refresh();
                break;
            case 'createGroundPolyline':
                stopOtherCreateAction('createGroundPolyline');
                editor.actionManager.execute('createGroundPolyline');
                break;
            case 'createIrregularWall':
                stopOtherCreateAction('createIrregularWall');
                editor.actionManager.execute('createIrregularWall');
                break;
            case 'groundPolylineVisibility':
                startGroundPolylineVisibility();
                break;
            case 'splitGroundShape':
                startGroundShapeSplit();
                break;
            case 'createRect':
                stopOtherCreateAction('create2DRect');
                editor.actionManager.execute('create2DRect');

                break;
            case 'translate':
                editor.actionManager.execute('toggleTranslate');
                break;
            case 'reProjection':
                reProject();
                break;
            case 'projection':
                project();
                break;
            case 'track':
                config.activeTrack = !config.activeTrack;
                break;
            case 'model':
                onModel();
                break;
            case 'deleteProjections':
                deleteProjections();
                break;
            case 'filter2D':
                onFilter2D();
                break;
        }
    }

    function startGroundPolylineVisibility(): void {
        stopGroundShapeSplit();
        stopOtherCreateAction('groundPolylineVisibility');
        const config = editor.state.config;
        config.groundPolylineVisibilityEdit = !config.groundPolylineVisibilityEdit;
        editor.pc.renderViews.forEach((view) => {
            const visibilityAction = view.getAction('edit-ground-polyline-visibility-2d') as
                | { clearPending?: () => void; toggle?: (enabled: boolean) => void }
                | undefined;
            visibilityAction?.clearPending?.();
            visibilityAction?.toggle?.(config.groundPolylineVisibilityEdit);
            if (config.groundPolylineVisibilityEdit) {
                view.disableAction(['edit-2d', 'select']);
            } else {
                view.enableAction(['edit-2d', 'select']);
            }
        });
        if (config.groundPolylineVisibilityEdit) {
            editor.showMsg(
                'warning',
                '请在相机图的折线上依次点击两个点，两点之间将设为不可见',
                5,
            );
        } else {
            editor.showMsg('success', '已退出遮挡标注', 2);
        }
        editor.pc.render();
    }

    function startGroundShapeSplit(): void {
        const view = editor.viewManager.getMainView();
        const action = view?.getAction('split-ground-shape') as SplitGroundShapeAction | undefined;
        const selected = editor.pc.selection.find(
            (object) => object instanceof GroundPolyline || object instanceof IrregularWall,
        );
        if (!action || !selected) {
            editor.showMsg('warning', '请先选中需要截断的 curb、wall 或不规则墙');
            return;
        }
        if (!selected.userData?.trackId) {
            editor.showMsg('warning', '该对象没有 Track ID，无法执行整条 Track 截断');
            return;
        }
        if (
            selected instanceof IrregularWall &&
            (selected.bottomPoints.length < 2 || selected.topPoints.length < 2)
        ) {
            editor.showMsg('warning', '不规则墙需要完整的顶边和底边后才能截断');
            return;
        }
        if (editor.state.config.groundPolylineVisibilityEdit) {
            startGroundPolylineVisibility();
        }
        const enabled = !editor.state.config.groundShapeSplitEdit;
        editor.state.config.groundShapeSplitEdit = enabled;
        action.onMiss = () => editor.showMsg('warning', '请点击选中对象的线段', 2);
        action.onCancel = () => {
            editor.state.config.groundShapeSplitEdit = false;
            editor.pc.render();
        };
        action.onPick = async (pick) => {
            stopGroundShapeSplit();
            await editor.splitGroundShapeTrack(pick);
        };
        action.toggle(enabled);
        editor.showMsg(
            'warning',
            enabled ? '截断模式：在线段任意位置点击，Esc 退出' : '已退出截断模式',
            3,
        );
        editor.pc.render();
    }

    function stopGroundShapeSplit(): void {
        if (!editor.state.config.groundShapeSplitEdit) return;
        editor.state.config.groundShapeSplitEdit = false;
        const action = editor.viewManager
            .getMainView()
            ?.getAction('split-ground-shape') as SplitGroundShapeAction | undefined;
        action?.toggle(false);
        editor.pc.render();
    }

    function deleteProjections() {
        const frame = editor.getCurrentFrame();
        const projections = (editor.dataManager.getFrameObject(frame.id) || []).filter(
            (object) => object instanceof Object2D && object.userData?.isProjection === true,
        );
        if (projections.length === 0) {
            editor.showMsg('warning', $$('delete_projections_empty'));
            return;
        }
        editor.cmdManager.execute('delete-object', [{ objects: projections, frame }]);
        editor.showMsg(
            'success',
            $$('delete_projections_success', { n: projections.length }),
        );
    }

    function onFilter2D() {
        let config = editor.state.config;
        config.filter2DByTrack = !config.filter2DByTrack;
        editor.pc.render();
    }

    function project() {
        let selection = editor.pc.selection;

        if (selection.length > 0) {
            let object3D = selection.filter(
                (e) => e instanceof Box || e instanceof GroundPolygon || e instanceof GroundPolyline || e instanceof IrregularWall,
            );
            if (object3D.length === 0) {
                editor.showMsg('warning', 'Please Select a 3D Result');
                return;
            }
            editor.actionManager.execute('projectObject2D', {
                createFlag: true,
                updateFlag: false,
                selectFlag: true,
            });
        } else {
            editor.actionManager.execute('projectObject2D', {
                createFlag: true,
                updateFlag: false,
            });
        }
    }

    function reProject() {
        let selection = editor.pc.selection;
        let object3D = selection.filter(
            (e) => e instanceof Box || e instanceof GroundPolygon || e instanceof GroundPolyline || e instanceof IrregularWall,
        );
        if (object3D.length === 0) {
            editor.showMsg('warning', 'Please Select a 3D Result');
            return;
        }

        editor.actionManager.execute('projectObject2D', {
            createFlag: true,
            updateFlag: true,
            selectFlag: true,
        });
    }

    async function runModel() {
        const modelConfig = editor.state.modelConfig;
        if (!modelConfig.model) {
            editor.showMsg('warning', 'Please choose Model');
            return;
        }
        let toolState = editor.state;
        let bsState = editor.bsState;
        let data = toolState.frames[toolState.frameIndex];
        let model = toolState.models.find((e) => e.name === modelConfig.model) as IModel;
        if (!model) {
            editor.showMsg('warning', 'Please choose Model');
            return;
        }
        const resultFilterParam = {
            minConfidence: 0.5,
            maxConfidence: 1,
            classes: model?.classes.map((e) => e.value),
        };
        if (!modelConfig.predict) {
            const selectedClasses = (modelConfig.classes[modelConfig.model] || []).reduce(
                (classes, item) => {
                    if (item.selected) {
                        classes.push(item.value);
                    }
                    return classes;
                },
                [] as string[],
            );
            if (selectedClasses.length <= 0) {
                editor.showMsg('warning', 'Select at least one Class!');
                return;
            }
            resultFilterParam.minConfidence = modelConfig.confidence[0];
            resultFilterParam.maxConfidence = modelConfig.confidence[1];
            resultFilterParam.classes = selectedClasses;
        }
        if (model.code === 'LIDAR_TRACKING') {
            editor.showMsg('warning', editor.lang('trackFromTimelineTip'));
            return;
        }
        let config = {
            datasetId: bsState.datasetId,
            dataIds: [+data.id],
            modelId: Number(model.id),
            modelVersion: model?.version,
            dataType: 'SINGLE_DATA',
            modelCode: model.code,
            // annotationRecordId: +toolState.recordId,
            resultFilterParam,
        };
        // modelConfig.loading = true;
        try {
            let result = await api.runModel(config);
            if (!result.data) throw new Error('Model Run Error');
            data.model = {
                recordId: result.data,
                id: model.id,
                version: model.version,
                code: model.code,
                state: 'loading',
            };
        } catch (error: any) {
            editor.showMsg('error', error.message || 'Model Run Error');
        }
        // modelConfig.loading = false;
        editor.dataManager.pollDataModelResult();
    }
    function onModel() {
        let toolState = editor.state;
        let dataInfo = toolState.frames[toolState.frameIndex];

        if (dataInfo.model && dataInfo.model.state === 'loading') return;

        // if (dataInfo.model) {
        if (dataInfo.model && dataInfo.model.state === 'complete') {
            let model = dataInfo.model as IModelResult;
            // editor.showConfirm({ title: 'Model Results', subTitle: 'Add Results?' }).then(
            //     async () => {
            //     },
            //     () => {},
            // );
            api.clearModel([+dataInfo.id], model.recordId);
            editor.modelManager.addModelData();
        } else {
            runModel();
            // editor.showModal('modelRun', { title: 'AI Annotation', data: {} });
        }
    }

    function stopOtherCreateAction(name: string) {
        if (editor.actionManager.currentAction) {
            let action = editor.actionManager.currentAction;
            if (action.name === name) return;
            if (createActions.indexOf(action.name as IActionName) >= 0) {
                editor.actionManager.stopCurrentAction();
            }
        }
    }

    return {
        ...toRefs(innerState),
        runModel,
        onModel,
        onTool,
    };
}
