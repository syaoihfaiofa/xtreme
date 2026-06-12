import { IObject, IFrame, IModelResult, IUserData } from 'pc-editor';
import Editor from './Editor';
import * as api from '../api';
import { DataManager as BaseDataManager, Const } from 'pc-editor';
import * as bsUtils from '../utils';
import { AnnotateObject } from 'pc-render';
import { pollModelTrack } from '../utils/model';

export default class DataManager extends BaseDataManager {
    editor: Editor;
    constructor(editor: Editor) {
        super(editor);

        this.editor = editor;
    }

    async pollDataModelResult() {
        let _this = this;
        let editor = this.editor;
        let modelMap = {} as Record<string, IFrame[]>;

        let dataList = this.editor.state.frames;
        dataList.forEach((data) => {
            if (data.model && data.model.state !== 'complete') {
                let id = data.model.recordId;
                modelMap[id] = modelMap[id] || [];
                modelMap[id].push(data);
            }
        });

        if (Object.keys(modelMap).length === 0) return;

        let requests = [] as Promise<any>[];
        Object.keys(modelMap).forEach((recordId) => {
            requests.push(createRequest(recordId, modelMap[recordId]));
        });

        await Promise.all(requests);

        setTimeout(this.pollDataModelResult.bind(this), 1500);

        function createRequest(recordId: string, dataInfos: IFrame[]) {
            let ids = dataInfos.map((e) => e.id);
            let request = api
                .getModelResult(ids, recordId)
                .then((data) => {
                    let { frameIndex, frames } = _this.editor.state;
                    let curData = dataList[frameIndex];
                    // return;
                    data = data.data || {};
                    let resultList = data.modelDataResults;
                    if (!resultList) return;

                    let resultMap = {} as Record<string, any>;
                    resultList.forEach((e: any) => {
                        resultMap[e.dataId] = e;
                    });

                    dataInfos.forEach((dataMeta) => {
                        let info = resultMap[dataMeta.id];
                        let model = dataMeta.model as IModelResult;

                        if (info) {
                            let modelResult = info.modelResult;
                            let objects = (modelResult.objects || []) as IObject[];

                            const code = modelResult.code;
                            const resultOk =
                                code == null ||
                                code === '' ||
                                code === 'OK';
                            if (!resultOk) {
                                dataMeta.model = undefined;
                                if (dataMeta.id === curData.id)
                                    editor.showMsg('error', editor.lang('model-run-error'));
                                return;
                            }

                            if (objects.length > 0) {
                                model.state = 'complete';
                                // Keep objects when confidence is missing (e.g. tracking); only drop low scores when present.
                                objects = objects.filter((e) => {
                                    const c = (e as any).confidence;
                                    if (c == null || c === '') return true;
                                    return Number(c) >= 0.5;
                                });
                                editor.modelManager.modelMap.set(dataMeta.id, objects);
                            } else {
                                dataMeta.model = undefined;
                                if (dataMeta.id === curData.id)
                                    editor.showMsg('warning', editor.lang('model-run-no-data'));
                            }
                        } else {
                            dataMeta.model = undefined;
                            if (dataMeta.id === curData.id)
                                editor.showMsg('warning', editor.lang('model-run-no-data'));
                        }
                    });

                    // data.forEach((info: any) => {
                })
                .catch(() => {});

            return request;
        }
    }
    async runModelTrack(
        curId: string,
        toIds: string[],
        direction: 'BACKWARD' | 'FORWARD',
        targetObjects: any[],
        _trackIdName: Record<string, string>,
        onComplete?: () => void,
    ) {
        let editor = this.editor;
        let bsState = editor.bsState;
        let trackingModel = editor.state.models.find((m) => m.code === 'LIDAR_TRACKING');
        if (!trackingModel) {
            editor.showMsg('warning', editor.lang('load-model-error'));
            return;
        }

        editor.showLoading({ type: 'track', content: editor.lang('load-track') });

        let config = {
            datasetId: bsState.datasetId,
            dataIds: toIds.map((id) => +id),
            modelId: +trackingModel.id,
            modelVersion: trackingModel.version,
            operateItemType: 'SINGLE_DATA',
            modelCode: 'LIDAR_TRACKING',
            resultFilterParam: {
                sourceDataId: +curId,
                direction,
                objects: targetObjects.map((o) => ({
                    trackingId: o.trackingId,
                    center3D: { x: o.center3D.x, y: o.center3D.y, z: o.center3D.z },
                    rotation3D: { x: o.rotation3D.x, y: o.rotation3D.y, z: o.rotation3D.z },
                    size3D: { x: o.size3D.x, y: o.size3D.y, z: o.size3D.z },
                    modelClass: o.modelClass,
                    confidence: o.confidence,
                })),
            },
        };

        try {
            let result = await api.runModel(config);
            if (!result.data) throw new Error('track error');
            let recordId = String(result.data);
            pollModelTrack(
                recordId,
                toIds,
                (objectsMap) => {
                    editor.showLoading(false);
                    if (Object.keys(objectsMap).length === 0) {
                        editor.showMsg('warning', editor.lang('track-no-data'));
                        return;
                    }
                    editor.modelManager.addModelTrackData(objectsMap);
                    editor.showMsg('success', editor.lang('track-ok'));
                    onComplete && onComplete();
                },
                () => {
                    editor.showLoading(false);
                    editor.showMsg('error', editor.lang('track-error'));
                },
            );
        } catch (error) {
            editor.showLoading(false);
            editor.showMsg('error', editor.lang('track-error'));
        }
    }

    onAnnotatesAdd(objects: AnnotateObject[], frame?: IFrame | undefined): void {
        let { user } = this.editor.bsState;

        console.log('onAnnotatesAdd');
        //
        if (user.id) {
            objects.forEach((object) => {
                let bsObj = object as any;
                if (!bsObj.createdAt) {
                    bsObj.lastTime = Date.now();
                    bsObj.updateTime = bsObj.lastTime;
                    bsObj.createdAt = bsUtils.formatTimeUTC(bsObj.lastTime);
                }
                if (!bsObj.createdBy) {
                    bsObj.createdBy = user.id;
                }
            });
        }
        super.onAnnotatesAdd(objects, frame);
    }
}
