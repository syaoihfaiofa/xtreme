import CmdBase from '../CmdBase';
import type { ICmdOption } from './index';
import { refreshGroundPolylineBevDisplay } from '../../../utils/groundPolylineVisibility';

interface IUndoData {
    byView: Record<string, boolean[]>;
}

export default class UpdateGroundPolylineVisibilityRange extends CmdBase<
    ICmdOption['update-ground-polyline-visibility-range'],
    IUndoData
> {
    redo(): void {
        const { object, byView } = this.data;
        if (!this.undoData) {
            this.undoData = {
                byView: JSON.parse(JSON.stringify(object.segmentVisibleByView)),
            };
        }
        object.setSegmentVisibleByView(byView);
        refreshGroundPolylineBevDisplay(this.editor, object);
        const frame = (object as { frame?: import('../../type').IFrame }).frame;
        this.editor.dataManager.onAnnotatesChange([object], frame, { type: 'userData' });
    }

    undo(): void {
        if (!this.undoData) return;
        this.data.object.setSegmentVisibleByView(this.undoData.byView);
        refreshGroundPolylineBevDisplay(this.editor, this.data.object);
        const frame = (this.data.object as { frame?: import('../../type').IFrame }).frame;
        this.editor.dataManager.onAnnotatesChange([this.data.object], frame, { type: 'userData' });
    }

    canMerge(): boolean {
        return false;
    }
}
