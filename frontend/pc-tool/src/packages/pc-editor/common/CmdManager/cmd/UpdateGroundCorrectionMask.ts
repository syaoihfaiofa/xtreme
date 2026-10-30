import CmdBase from '../CmdBase';
import type { AnnotateObject } from 'pc-render';
import type { IFrame, GroundCorrectionMask } from '../../../type';
import type { ICmdOption } from './index';

export interface IUpdateGroundCorrectionMaskOption {
    object: AnnotateObject;
    frame: IFrame;
    mask: GroundCorrectionMask;
}

export default class UpdateGroundCorrectionMask extends CmdBase<
    ICmdOption['update-ground-correction-mask'],
    GroundCorrectionMask
> {
    redo(): void {
        if (!this.undoData) {
            this.undoData = cloneMask(this.data.object.userData.groundCorrectionMask);
        }
        this.editor.dataManager.setAnnotatesUserData(
            this.data.object,
            { groundCorrectionMask: cloneMask(this.data.mask) },
            this.data.frame,
        );
    }

    undo(): void {
        if (!this.undoData) return;
        this.editor.dataManager.setAnnotatesUserData(
            this.data.object,
            { groundCorrectionMask: cloneMask(this.undoData) },
            this.data.frame,
        );
    }
}

function cloneMask(mask: GroundCorrectionMask | undefined): GroundCorrectionMask {
    if (!mask) return { version: 1, operations: [] };
    return {
        version: 1,
        operations: mask.operations.map((operation) => {
            if (operation.type === 'polygon') {
                return {
                    type: 'polygon',
                    vertices: operation.vertices.map((point) => ({ ...point })),
                    ...(operation.heightRange
                        ? { heightRange: { ...operation.heightRange } }
                        : {}),
                };
            }
            if (operation.type === 'cluster') {
                return {
                    type: 'cluster',
                    points: operation.points.map((point) => ({ ...point })),
                    radius: operation.radius,
                };
            }
            return {
                type: 'brush',
                ...(operation.samples
                    ? { samples: operation.samples.map((point) => ({ ...point })) }
                    : { center: { ...operation.center! } }),
                radius: operation.radius,
                ...(operation.heightRange ? { heightRange: { ...operation.heightRange } } : {}),
                ...(operation.erase ? { erase: true as const } : {}),
            };
        }),
    };
}
