import { IObject, IFrame, IModelResult } from '../type';
import { AnnotateObject, Box } from 'pc-render';
import Editor from '../Editor';
// import * as api from '../api';
import * as utils from '../utils';
import { Const, ICmdName, IFilter, IUserData } from '../type';
import { utils as baseUtils } from 'pc-editor';

// Predictions of the same class overlapping an already-annotated box by at least this
// much BEV IoU are treated as duplicates of the human annotation and dropped.
const DUPLICATE_IOU_THRESHOLD = 0.3;

export default class ModelManager {
    editor: Editor;
    modelMap: Map<string, IObject[]> = new Map();
    constructor(editor: Editor) {
        this.editor = editor;
    }

    // model
    getModelResult(frameId: string) {
        return this.modelMap.get(frameId);
    }
    clearModelResult(frameId: string) {
        this.modelMap.delete(frameId);
    }

    clear(): void {
        this.modelMap.clear();
    }

    addModelData() {
        let { frameIndex, frames } = this.editor.state;
        let frame = this.editor.getCurrentFrame();
        let objects = this.getModelResult(frame.id) || [];

        if (objects.length === 0) return;

        // let oldAnnotate = this.dataManager.getDataObject(dataInfo.dataId);
        let annotates = utils.convertObject2Annotate(objects, this.editor);

        // Don't re-add a predicted box that already overlaps a human-annotated box of
        // the same class in this frame, so re-running the model on annotated frames
        // doesn't clutter the scene with redundant duplicates.
        let existingBoxes = (this.editor.dataManager.getFrameObject(frame.id) || []).filter(
            (object) => object instanceof Box && !object.userData.invisibleFlag,
        ) as Box[];
        if (existingBoxes.length > 0) {
            annotates = annotates.filter((object) => {
                if (!(object instanceof Box)) return true;
                let classId = (object.userData as IUserData).classId;
                return !existingBoxes.some(
                    (existing) =>
                        existing.userData.classId === classId &&
                        utils.computeBevIoU(object, existing) >= DUPLICATE_IOU_THRESHOLD,
                );
            });
        }

        if (annotates.length === 0) {
            frame.model = undefined;
            this.editor.frameChange(frame);
            this.clearModelResult(frame.id);
            return;
        }

        let newTracks = [] as Partial<IObject>[];

        annotates.forEach((object) => {
            let userData = object.userData as IUserData;
            // userData.resultStatus = Const.Predicted;

            utils.setIdInfo(this.editor, userData);

            // let trackId = userData.trackId as string;
            // let trackName = userData.trackName as string;
            // let resultType = userData.resultType;

            // if (!this.editor.trackManager.hasTrackObject(trackId)) {
            //     newTracks.push({ trackId, trackName, resultType, classType: '' });
            // }
        });

        this.editor.needUpdateFilter = true;
        this.editor.cmdManager.execute('add-object', annotates);
        // this.editor.cmdManager.withGroup(() => {
        //     this.editor.cmdManager.execute('add-track', newTracks);
        //     this.editor.cmdManager.execute('add-object', annotates);
        // });

        // this.updateDataId();
        // this.dataManager.setDataObject(dataInfo.dataId, [...oldAnnotate, ...annotates]);

        frame.model = undefined;

        this.editor.frameChange(frame);
        this.clearModelResult(frame.id);
    }

    addModelTrackData(objectsMap: Record<string, IObject[]>) {
        baseUtils.addModelTrackData(this.editor, objectsMap);
    }
}
