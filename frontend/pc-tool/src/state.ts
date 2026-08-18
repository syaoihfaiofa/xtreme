import { provide, inject, onBeforeUnmount, reactive } from 'vue';
import { IBSState } from './type';
import Editor from './common/Editor';
import { initRegistry } from './registry';
import { IState } from 'pc-editor';

// global state
export const bsContext = Symbol('pc-tool-editor');
export const stateContext = Symbol('pc-tool-editor-state');

export function useProvideEditor() {
    let editor = new Editor();
    // @ts-ignore
    window.editor = editor;

    editor.state = reactive(editor.state);
    editor.bsState = reactive(editor.bsState);

    initRegistry(editor);

    provide(bsContext, editor);
    provide(stateContext, editor.state);
    onBeforeUnmount(() => {
        editor.destroy();
        // @ts-ignore
        if (window.editor === editor) window.editor = undefined;
    });

    return editor;
}

export function useInjectEditor(): Editor {
    return inject(bsContext) as Editor;
}

export function useInjectState(): IState {
    return inject(stateContext) as IState;
}

export function getDefault(): IBSState {
    return {
        query: {},
        // flow
        saving: false,
        validing: false,
        submitting: false,
        modifying: false,
        //
        // user
        user: {
            id: '',
            nickname: '',
        },
        datasetName: '',
        datasetType: '',
        syncMode: false,
        inferenceMode: false,
        inferenceConfig: null,
        inferenceEnsuring: false,
        inferenceTask: null,
        inferenceRequestError: '',
        reviewMode: false,
        datasetId: '',
        recordId: '',
    };
}
