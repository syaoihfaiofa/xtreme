import { IState } from 'pc-editor';
import Editor from '../../common/Editor';
import { BsUIType as UIType } from '../../config/ui';
import { Component } from 'vue';
import ToolTip from './modelConfig.vue';
import SetBox from './setBox.vue';
import SetHelper2D from './setHelper2D.vue';
import { ILocale } from './lang/type';
import { isGroundCorrectionMaskBevActive } from '../../packages/pc-editor/utils/groundCorrectionMaskEditing';
export interface IItemConfig {
    action: string;
    label?: string;
    title: ($$: (name: keyof ILocale, args?: Record<string, any>) => string) => string;
    getStyle?: (editor: Editor) => any;
    extra?: () => Component;
    hasMsg?: (editor: Editor) => boolean;
    getIcon: (editor: Editor) => string;
    isDisplay: (editor: Editor) => boolean;
    isActive: (editor: Editor) => boolean;
}
export const allItems: IItemConfig[] = [
    {
        action: 'createRect',
        // label: 'Rect',
        title: ($$) => $$('title_rect'),
        getIcon: function (editor: Editor) {
            return 'iconfont icon-biaozhunkuang';
        },
        isDisplay: function (editor: Editor) {
            let state = editor.state;
            return (
                state.modeConfig.ui[UIType.create2dRect] &&
                state.config.showSingleImgView &&
                state.config.projectPoint4
            );
        },
        isActive: function (editor: Editor) {
            // return state.config.activeRect;
            return false;
        },
    },
    {
        action: 'create2DBox',
        title: ($$) => $$('title_create2DBox'),
        getIcon: function (editor: Editor) {
            return 'iconfont icon-biaozhunkuang';
        },
        isDisplay: function (editor: Editor) {
            let state = editor.state;
            return (
                state.modeConfig.ui[UIType.create2dBox] &&
                state.config.showSingleImgView &&
                state.config.projectPoint8
            );
        },
        isActive: function (editor: Editor) {
            // return state.config.active2DBox;
            return false;
        },
    },
    {
        action: 'create3DBox',
        title: ($$) => $$('title_create3DBox'),
        getIcon: function (editor: Editor) {
            const { config } = editor.state;
            const classMap = {
                AI: 'iconfont icon-a-aikuang',
                STANDARD: 'iconfont icon-biaozhunkuang',
            };
            return classMap[config.boxMethod] || classMap['STANDARD'];
        },
        getStyle: function (editor: Editor) {
            return {
                'margin-bottom': 0,
                'border-bottom-right-radius': 0,
                'border-bottom-left-radius': 0,
                'padding-bottom': 0,
            };
        },
        extra: () => SetBox,
        isDisplay: function (editor: Editor) {
            let state = editor.state;
            return state.modeConfig.ui[UIType.create3dBox] && !state.config.showSingleImgView;
        },
        isActive: function (editor: Editor) {
            // return state.config.active3DBox;
            return false;
        },
    },
    {
        action: 'createParkingSlot',
        title: () => '停车位四点标注 (P)',
        getIcon: function () {
            return 'iconfont icon-biaozhunkuang';
        },
        isDisplay: function (editor: Editor) {
            const state = editor.state;
            return state.modeConfig.actions['createParkingSlot'] && !state.config.showSingleImgView;
        },
        isActive: function () {
            return false;
        },
    },
    {
        action: 'createGroundPolyline',
        title: () => '地面折线标注 (L)',
        getIcon: function () {
            return 'iconfont icon-biaozhunkuang';
        },
        isDisplay: function (editor: Editor) {
            const state = editor.state;
            return state.modeConfig.actions['createGroundPolyline'] && !state.config.showSingleImgView;
        },
        isActive: function () {
            return false;
        },
    },
    {
        action: 'createIrregularWall',
        title: () => '不规则的路沿标注 (I)',
        getIcon: function () {
            return 'iconfont icon-polygon1';
        },
        isDisplay: function (editor: Editor) {
            const state = editor.state;
            return state.modeConfig.actions['createIrregularWall'] && !state.config.showSingleImgView;
        },
        isActive: function () {
            return false;
        },
    },
    {
        action: 'splitGroundShape',
        label: '截断',
        title: () => '截断整条 Track：选择对象后，点击线段上的截断位置',
        getIcon: function () {
            return 'iconfont icon-jiancha';
        },
        isDisplay: function (editor: Editor) {
            const state = editor.state;
            return state.modeConfig.actions['deleteObject'] && !state.config.showSingleImgView;
        },
        isActive: function (editor: Editor) {
            return editor.state.config.groundShapeSplitEdit;
        },
    },
    {
        action: 'groundCorrectionPolygon',
        label: '地面纠正区域',
        title: () => '地面纠正区域：BEV 点击顶点，双击或 Enter 提交，Esc 取消',
        getIcon: function () {
            return 'iconfont icon-polygon1';
        },
        isDisplay: function (editor: Editor) {
            return editor.state.modeConfig.actions['deleteObject'] && isGroundCorrectionMaskBevActive(editor);
        },
        isActive: function (editor: Editor) {
            return editor.actionManager.currentAction?.name === 'editGroundCorrectionPolygon';
        },
    },
    {
        action: 'groundCorrectionBrush',
        label: '地面纠正笔刷',
        title: () => '地面纠正笔刷：在 BEV 拖动采样，松开鼠标提交',
        getIcon: function () {
            return 'iconfont icon-biaozhunkuang';
        },
        isDisplay: function (editor: Editor) {
            return editor.state.modeConfig.actions['deleteObject'] && isGroundCorrectionMaskBevActive(editor);
        },
        isActive: function (editor: Editor) {
            return editor.actionManager.currentAction?.name === 'editGroundCorrectionBrush';
        },
    },
    {
        action: 'deleteGroundCorrectionOperation',
        label: '删除纠正',
        title: () => '删除当前帧最后一条地面纠正操作',
        getIcon: function () {
            return 'iconfont icon-shanchuicon';
        },
        isDisplay: function (editor: Editor) {
            return editor.state.modeConfig.actions['deleteObject'] && isGroundCorrectionMaskBevActive(editor);
        },
        isActive: function () {
            return false;
        },
    },
    {
        action: 'propagateGroundCorrectionMask',
        label: '应用纠正',
        title: () => '应用当前帧地面纠正到前后 N 帧',
        getIcon: function () {
            return 'iconfont icon-fuzhuxian';
        },
        isDisplay: function (editor: Editor) {
            return editor.state.modeConfig.actions['deleteObject'] && isGroundCorrectionMaskBevActive(editor);
        },
        isActive: function () {
            return false;
        },
    },
    {
        action: 'pointDistanceMeasure',
        label: '测距',
        title: ($$) => $$('point_distance_measure'),
        getIcon: function () {
            return 'iconfont icon-fuzhuxian';
        },
        isDisplay: function (editor: Editor) {
            return (
                editor.state.modeConfig.actions['togglePointDistanceMeasure'] &&
                !editor.state.config.showSingleImgView
            );
        },
        isActive: function (editor: Editor) {
            return editor.state.config.pointDistanceMeasure;
        },
    },
    {
        action: 'translate',
        title: ($$) => $$('title_translate'),
        getIcon: function (editor: Editor) {
            return 'iconfont icon-yidong';
        },
        isDisplay: function (editor: Editor) {
            let state = editor.state;
            return state.modeConfig.ui[UIType.translate] && !state.config.showSingleImgView;
        },
        isActive: function (editor: Editor) {
            let state = editor.state;
            return state.config.activeTranslate;
        },
    },
    {
        action: 'projection',
        title: () => 'Projection',
        getIcon: function (editor: Editor) {
            return 'iconfont icon-yingshe';
        },
        isDisplay: function (editor: Editor) {
            let state = editor.state;
            return state.modeConfig.ui[UIType.project] && state.imgViews.length > 0;
        },
        isActive: function (editor: Editor) {
            return false;
        },
    },
    {
        action: 'reProjection',
        title: () => 'Re-Projection',
        getIcon: function (editor: Editor) {
            return 'iconfont icon-xuanzhuan';
        },
        isDisplay: function (editor: Editor) {
            let state = editor.state;
            return state.modeConfig.ui[UIType.reProject] && state.imgViews.length > 0;
        },
        isActive: function (editor: Editor) {
            return false;
        },
    },
    {
        action: 'track',
        title: ($$) => $$('title_track'),
        getIcon: function (editor: Editor) {
            return 'iconfont icon-fuzhuxian';
        },
        getStyle: function (editor: Editor) {
            return {
                'margin-bottom': 0,
                'border-bottom-right-radius': 0,
                'border-bottom-left-radius': 0,
                'padding-bottom': 0,
            };
        },
        extra: () => SetHelper2D,
        isDisplay: function (editor: Editor) {
            let state = editor.state;
            return state.modeConfig.ui[UIType.track] && state.config.showSingleImgView;
        },
        isActive: function (editor: Editor) {
            let state = editor.state;
            return state.config.activeTrack;
        },
    },
    // {
    //     action: 'filter2D',
    //     // label: 'filter2D',
    //     title: ($$) => $$('title_filter2D'),
    //     getIcon: function (editor: Editor) {
    //         return 'iconfont icon-shaixuan';
    //     },
    //     isDisplay: function (editor: Editor) {
    //         let state = editor.state;
    //         return state.modeConfig.ui[UIType.filter2D];
    //     },
    //     isActive: function (editor: Editor) {
    //         let state = editor.state;
    //         return state.config.filter2DByTrack;
    //     },
    // },
    {
        action: 'model',
        // label: 'Model',
        title: ($$) => $$('title_model'),
        hasMsg: function (editor: Editor) {
            let state = editor.state;
            let dataInfo = state.frames[state.frameIndex];
            return dataInfo && !!dataInfo.model && dataInfo.model.state === 'complete';
        },
        extra: () => ToolTip,
        getStyle: function (editor: Editor) {
            return {
                'margin-bottom': 0,
                'border-bottom-right-radius': 0,
                'border-bottom-left-radius': 0,
                'padding-bottom': 0,
            };
        },
        getIcon: function (editor: Editor) {
            let state = editor.state;
            let dataInfo = state.frames[state.frameIndex];
            return dataInfo && !!dataInfo.model && dataInfo.model.state === 'loading'
                ? 'iconfont icon-loading loading'
                : 'iconfont icon-Vector';
        },
        isDisplay: function (editor: Editor) {
            let state = editor.state;
            return (
                state.modeConfig.ui[UIType.rumModel] &&
                !state.config.showSingleImgView
            );
        },
        isActive: function (editor: Editor) {
            let state = editor.state;
            let dataInfo = state.frames[state.frameIndex];
            return dataInfo && !!dataInfo.model && dataInfo.model.state === 'loading';
        },
    },
    {
        action: 'deleteProjections',
        title: ($$) => $$('title_delete_projections'),
        getIcon: function () {
            return 'iconfont icon-shanchuicon';
        },
        isDisplay: function (editor: Editor) {
            const state = editor.state;
            return (
                state.modeConfig.ui[UIType.rumModel] &&
                !state.config.showSingleImgView &&
                state.imgViews.length > 0
            );
        },
        isActive: function () {
            return false;
        },
    },
];
