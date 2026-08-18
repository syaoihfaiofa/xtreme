import { Box, MainRenderView, TransformControlsAction } from 'pc-render';
import { define } from '../define';
import Editor from '../../../Editor';

export const nextFrame = define({
    // valid(editor: Editor) {
    //     return editor.state.isSeriesFrame;
    // },
    execute(editor: Editor) {
        editor.navigateFrame(1);
    },
});
export const preFrame = define({
    // valid(editor: Editor) {
    //     return editor.state.isSeriesFrame;
    // },
    execute(editor: Editor) {
        editor.navigateFrame(-1);
    },
});
