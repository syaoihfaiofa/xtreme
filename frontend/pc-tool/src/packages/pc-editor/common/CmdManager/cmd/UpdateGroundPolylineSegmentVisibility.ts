import CmdBase from '../CmdBase';
import { GroundPolyline } from 'pc-render';
import type { ICmdOption } from './index';
import { refreshGroundPolylineBevDisplay } from '../../../utils/groundPolylineVisibility';

export default class UpdateGroundPolylineSegmentVisibility extends CmdBase<
    ICmdOption['update-ground-polyline-segment-visibility'],
    Record<string, boolean[]>
> {
    redo(): void {
        const { object, viewKey, segmentVisible } = this.data;
        if (!this.undoData) {
            this.undoData = JSON.parse(JSON.stringify(object.segmentVisibleByView));
        }
        object.setSegmentVisibleForView(viewKey, segmentVisible);
        refreshGroundPolylineBevDisplay(this.editor, object);
        const frame = (object as { frame?: import('../../type').IFrame }).frame;
        this.editor.dataManager.onAnnotatesChange([object], frame, { type: 'userData' });
    }

    undo(): void {
        if (!this.undoData) return;
        this.data.object.setSegmentVisibleByView(this.undoData);
        refreshGroundPolylineBevDisplay(this.editor, this.data.object);
        const frame = (this.data.object as { frame?: import('../../type').IFrame }).frame;
        this.editor.dataManager.onAnnotatesChange([this.data.object], frame, { type: 'userData' });
    }

    canMerge(cmd: CmdBase): boolean {
        return (
            cmd instanceof UpdateGroundPolylineSegmentVisibility &&
            this.data.object === cmd.data.object &&
            this.data.viewKey === cmd.data.viewKey &&
            Math.abs(this.updateTime - cmd.updateTime) < 500
        );
    }

    merge(cmd: UpdateGroundPolylineSegmentVisibility): void {
        this.data.segmentVisible = cmd.data.segmentVisible;
        this.updateTime = new Date().getTime();
    }
}
