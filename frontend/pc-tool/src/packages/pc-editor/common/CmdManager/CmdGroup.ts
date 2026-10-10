import Editor from '../../Editor';
import CmdBase from './CmdBase';

export default class CmdGroup extends CmdBase {
    cmds: CmdBase[] = [];
    constructor(editor: Editor) {
        super(editor, null);
    }
    redo() {
        try {
            this.cmds.forEach((e) => {
                e.redo();
            });
        } catch (error) {
            console.error(error);
        }
    }
    undo() {
        try {
            for (let index = this.cmds.length - 1; index >= 0; index--) {
                this.cmds[index].undo();
            }
        } catch (error) {
            console.error(error);
        }
    }
}
