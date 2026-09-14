import {
    Box,
    DistanceMeasureAction,
    Image2DRenderView,
    MainRenderView,
    TransformControlsAction,
} from 'pc-render';
import { define } from '../define';
import Editor from '../../../Editor';
import { IAnnotationInfo, StatusType } from '../../../type';
import { CreateAction } from 'pc-render';
import Event from '../../../config/event';
// import * as THREE from 'three';

export const toggleTranslate = define({
    valid(editor: Editor) {
        return true;
    },
    execute(editor: Editor) {
        let selection = editor.pc.selection;
        let config = editor.state.config;
        let object = selection.find((annotate) => annotate instanceof Box);

        if (object) {
            if (config.activeTranslate) {
                editor.toggleTranslate(false);
            } else {
                editor.toggleTranslate(true, object as any);
            }
        }
        config.activeTranslate = !config.activeTranslate;
    },
});

export const focusObject = define({
    valid(editor: Editor) {
        let box = editor.pc.selection.find((annotate) => annotate instanceof Box);
        return !!box;
    },
    execute(editor: Editor) {
        editor.focusObject(editor.pc.selection.find((annotate) => annotate instanceof Box) as Box);
    },
});

export const deleteObject = define({
    valid(editor: Editor) {
        return editor.pc.selection.length > 0;
    },
    execute(editor: Editor) {
        // A selected polyline vertex is a more specific target than the selected
        // annotation.  Handle it first so Delete removes only that vertex; the
        // whole polyline is deleted only after the vertex selection is cleared.
        const selectedVertex = editor.getSelectedGroundPolylineVertex();
        if (selectedVertex) {
            const { object, index } = selectedVertex;
            if (object.points3D.length <= 2) {
                editor.showMsg('warning', '折线至少需要保留两个点；取消点选后可删除整条线');
                return;
            }
            const points = object.points3D.map((point) => point.clone());
            points.splice(index, 1);
            editor.cmdManager.execute('update-ground-polyline-points', { object, points });
            // Do not leave a stale index selected: a second Delete must not
            // unexpectedly fall through and remove the whole annotation.
            editor.clearSelectedGroundPolylineVertex();
            return;
        }

        const selectedWallVertex = editor.getSelectedIrregularWallVertex();
        if (selectedWallVertex) {
            const { object, side, index } = selectedWallVertex;
            const sourcePoints = side === 'bottom' ? object.bottomPoints : object.topPoints;
            if (sourcePoints.length <= 2) {
                editor.showMsg(
                    'warning',
                    `${side === 'bottom' ? '底边' : '顶边'}至少需要保留两个点；取消点选后可删除整条不规则的路沿`,
                );
                return;
            }
            const points = sourcePoints.map((point) => point.clone());
            points.splice(index, 1);
            editor.cmdManager.execute('update-irregular-wall-points', {
                object,
                side,
                points,
            });
            editor.clearSelectedIrregularWallVertex();
            return;
        }

        let object = editor.pc.selection[0];
        editor.cmdManager.execute('delete-object', object);
    },
});

export const copyObject = define({
    valid(editor: Editor) {
        return editor.pc.selection.length > 0;
    },
    execute(editor: Editor) {
        const count = editor.copySelectedAnnotations();
        if (count > 0) editor.showMsg('success', `已复制 ${count} 个目标`);
    },
});

export const pasteObject = define({
    valid(editor: Editor) {
        return !!editor.state.modeConfig.actions['pasteObject'];
    },
    execute(editor: Editor) {
        const objects = editor.pasteCopiedAnnotations();
        if (objects.length > 0) editor.showMsg('success', `已粘贴 ${objects.length} 个目标`);
    },
});

export const toggleShowAnnotation = define({
    valid(editor: Editor) {
        return true;
    },
    execute(editor: Editor) {
        // let config = editor.state.config;
        // config.showAnnotation = !config.showAnnotation;
        // editor.pc.render();
    },
});

export const toggleShowLabel = define({
    valid(editor: Editor) {
        return true;
    },
    execute(editor: Editor) {
        let config = editor.state.config;
        config.showLabel = !config.showLabel;
        editor.pc.render();
    },
});
export const toggleShowMeasure = define({
    valid(editor: Editor) {
        return true;
    },
    execute(editor: Editor) {
        let groupTrack = editor.pc.groupTrack;
        groupTrack.visible = !groupTrack.visible;
        editor.pc.render();
    },
});

export const togglePointDistanceMeasure = define({
    valid(editor: Editor) {
        return !!editor.viewManager.getMainView();
    },
    execute(editor: Editor) {
        const view = editor.viewManager.getMainView();
        const action = view?.getAction('distance-measure') as DistanceMeasureAction | undefined;
        if (!action) return;
        const enabled = !editor.state.config.pointDistanceMeasure;
        if (enabled && editor.state.config.groundShapeSplitEdit) {
            editor.state.config.groundShapeSplitEdit = false;
            view?.getAction('split-ground-shape')?.toggle(false);
        }
        editor.state.config.pointDistanceMeasure = enabled;
        editor.pc.renderViews.forEach((renderView) => {
            const distanceAction = renderView.getAction(
                'distance-measure',
            ) as DistanceMeasureAction | undefined;
            if (!distanceAction) return;
            distanceAction.onMiss = () => editor.showMsg('warning', '请点击可拾取的点云点', 2);
            distanceAction.toggle(enabled);
        });
        editor.showMsg('warning', enabled ? '距离测量：依次点击两个点云点，Esc 退出' : '已退出距离测量', 3);
        editor.pc.render();
    },
});
export const pickObject = define({
    valid(editor: Editor) {
        return true;
    },
    end(editor: Editor) {
        let view = editor.viewManager.getMainView();
        let action = view.getAction('create-obj') as CreateAction;
        action.end();
        editor.state.status = StatusType.Default;
    },
    execute(editor: Editor) {
        let view = editor.viewManager.getMainView();
        editor.state.status = StatusType.Pick;

        if (view) {
            return new Promise<any>(async (resolve) => {
                let action = view.getAction('create-obj') as CreateAction;
                this.action = action;

                action.start(
                    { type: 'points-1', trackLine: false },
                    async (data: THREE.Vector2[]) => {
                        let obj = view.getObjectByCanvas(data[0]);
                        // editor.state.status = StatusType.Default;
                        resolve(obj);
                    },
                );
            });
        }
    },
});
export const copyForward = define({
    valid(editor: Editor) {
        return editor.state.isSeriesFrame;
    },
    execute(editor: Editor) {
        editor.dataManager.copyForward();
    },
});
export const copyBackWard = define({
    valid(editor: Editor) {
        return editor.state.isSeriesFrame;
    },
    execute(editor: Editor) {
        editor.dataManager.copyBackWard();
    },
});

export const resultExpandToggle = define({
    execute(editor: Editor) {
        editor.dispatchEvent({ type: Event.RESULT_EXPAND_TOGGLE });
    },
});

export const filter2DByTrack = define({
    execute(editor: Editor) {
        let config = editor.state.config;
        config.filter2DByTrack = !config.filter2DByTrack;
        editor.pc.render();
    },
});
