import Editor from '../../Editor';
import * as Actions from './action';
import { IAction } from './type';
import { StatusType } from '../../type';
import { Box } from 'pc-render';

export type IActionName = keyof typeof Actions;

Object.keys(Actions).forEach((name) => {
    Actions[name as IActionName].name = name;
});

export let AllActions = Object.keys(Actions) as IActionName[];

const FRAME_NAVIGATION_ACTIONS: IActionName[] = ['nextFrame', 'preFrame'];
const GROUND_CORRECTION_TOOL_ACTIONS: IActionName[] = [
    'editGroundCorrectionPolygon',
    'editGroundCorrectionBrush',
    'editGroundCorrectionEraser',
    'editGroundCorrectionCluster',
];

interface IActionArgs {
    createAnnotation: { object: Box };
    projectObject2D: { updateFlag?: boolean; createFlag?: boolean; selectFlag?: boolean };
    [key: string]: any;
}

export default class ActionManager {
    // static Actions = Actions;
    editor: Editor;
    actions: Record<string, IAction>;
    currentAction: IAction | null = null;
    private currentRunId = 0;
    constructor(editor: Editor) {
        this.editor = editor;
        this.actions = { ...Actions };
    }

    registryAction(name: string, action: IAction) {
        this.actions[name] = action;
    }

    async execute<T extends IActionName>(name: T | T[], args?: IActionArgs[T]): Promise<any> {
        let action = null;
        if (Array.isArray(name)) {
            action = this.getEnableAction(name);
        } else {
            action = this.actions[name] as IAction;
        }

        if (!action) return;

        const interruptedTool = this.getFrameInterruptibleTool(action);
        if (interruptedTool) {
            this.stopCurrentAction();
            const result = await action.execute(this.editor, args);
            void this.execute(interruptedTool);
            return result;
        }

        if (this.isBlocked()) {
            console.log(`action ${name} blocked`);
            return;
        }

        let result;
        if (action.valid(this.editor)) {
            console.log('action start:', action.name);

            this.currentAction = action;
            const runId = ++this.currentRunId;
            try {
                result = await action.execute(this.editor, args);
            } catch (e) {
                console.error('action error:', name);
                console.error(e);
            }
            // A run stopped via stopCurrentAction already ended; another action may be running now.
            if (this.currentRunId === runId && this.currentAction === action) {
                this.currentAction = null;
                action.end(this.editor);
                (this.editor as any).parkingDensityManager?.refresh();
            }
            console.log('action end:', name);
        }

        return result;
    }

    /**
     * Ground correction tools stay active until the user exits them, so frame navigation
     * suspends the running tool (dropping an unfinished polygon) and resumes it afterwards.
     */
    private getFrameInterruptibleTool(action: IAction): IActionName | undefined {
        const tool = this.currentAction?.name as IActionName | undefined;
        if (
            !tool ||
            !FRAME_NAVIGATION_ACTIONS.includes(action.name as IActionName) ||
            !GROUND_CORRECTION_TOOL_ACTIONS.includes(tool) ||
            this.editor.state.status !== StatusType.Default
        ) {
            return undefined;
        }
        return tool;
    }

    isBlocked() {
        return this.currentAction || this.editor.state.status !== StatusType.Default;
    }

    getEnableAction(names: IActionName[]) {
        let config = this.editor.state.modeConfig;
        for (let i = 0; i < names.length; i++) {
            let name = names[i];
            let action = this.actions[name] as IAction;
            if (action && config.actions[name] && action.valid(this.editor)) return action;
        }

        return null;
    }

    stopCurrentAction() {
        if (!this.currentAction) return;

        const action = this.currentAction;
        this.currentAction = null;
        this.currentRunId++;
        action.end(this.editor);
        console.log(`stop action: ${action.name}`);

        (this.editor as any).parkingDensityManager?.refresh();
    }

    handleEsc() {
        const measureAction = this.editor.viewManager
            .getMainView()
            ?.getAction('distance-measure');
        if (this.editor.state.config.pointDistanceMeasure && measureAction?.isEnable()) {
            this.editor.state.config.pointDistanceMeasure = false;
            this.editor.pc.renderViews.forEach((view) => view.getAction('distance-measure')?.toggle(false));
        } else if (this.currentAction) {
            this.stopCurrentAction();
        } else if (this.editor.getSelectedGroundPolylineVertex()) {
            this.editor.clearSelectedGroundPolylineVertex();
            this.editor.pc.render();
        } else if (this.editor.getSelectedGroundPolygonVertex()) {
            // P annotation: the first Esc leaves vertex-edit mode but keeps the
            // parking-slot target selected; a following Esc deselects the target.
            this.editor.clearSelectedGroundPolygonVertex();
            this.editor.pc.render();
        } else if (this.editor.getSelectedIrregularWallVertex()) {
            this.editor.clearSelectedIrregularWallVertex();
        } else if (this.editor.pc.selection.length > 0) {
            // this.editor.cmdManager.execute('select-object');
            this.editor.selectObject();
        } else if (this.editor.currentTrack) {
            this.editor.setCurrentTrack(undefined, '');
        }
    }

    handleTab() {
        let createActions: IActionName[] = [
            'create2DBox',
            'create2DRect',
            'createAnnotation',
            'createObjectWith3',
        ];

        let config = this.editor.state.config;
        if (this.currentAction) {
            let action = this.currentAction;
            let actionName = action.name as IActionName;

            if (createActions.indexOf(actionName) < 0) return;

            this.stopCurrentAction();

            switch (actionName) {
                case 'create2DBox':
                    config.active2DBox = false;
                case 'create2DRect':
                    config.activeRect = false;
                case 'createAnnotation':
                    config.activeAnnotation = false;
                case 'createObjectWith3':
                    config.active3DBox = false;
            }
        }
    }

    isActionValid(name: IActionName) {
        let action = this.actions[name] as IAction;
        if (!action) return false;

        return action.valid(this.editor);
    }
}
