import { IObject, IFrame, IModelResult, IUserData } from 'pc-editor';
import Editor from './Editor';
import * as api from '../api';
import { DataManager as BaseDataManager, Const } from 'pc-editor';
import * as bsUtils from '../utils';
import { AnnotateObject } from 'pc-render';
import { pollModelTrack } from '../utils/model';
import { IInferenceTask } from '../type';

const INFERENCE_POLL_INTERVAL_MS = 1500;
const INFERENCE_STATUS_MAX_RETRIES = 3;

export default class DataManager extends BaseDataManager {
    editor: Editor;
    private modelPollTimer?: number;
    private modelPolling: boolean = false;
    private destroyed: boolean = false;
    private trackingPollStops: Set<() => void> = new Set();
    private inferencePollTimer?: number;
    private inferenceStatusRetries = 0;

    constructor(editor: Editor) {
        super(editor);

        this.editor = editor;
    }

    isInferenceRunning(): boolean {
        const task = this.editor.bsState.inferenceTask;
        return (
            this.editor.bsState.inferenceMode &&
            (this.editor.bsState.inferenceEnsuring ||
                task?.status === 'QUEUED' ||
                task?.status === 'RUNNING')
        );
    }

    async ensureDatasetInference(): Promise<void> {
        if (this.destroyed || !this.editor.bsState.inferenceMode) return;
        this.clearInferencePollTimer();
        this.editor.bsState.inferenceRequestError = '';
        this.inferenceStatusRetries = 0;
        this.editor.bsState.inferenceEnsuring = true;
        try {
            const task = await api.ensureInference(this.editor.bsState.recordId);
            await this.handleInferenceTask(task);
        } finally {
            this.editor.bsState.inferenceEnsuring = false;
        }
    }

    private async pollInferenceStatus(taskId: string): Promise<void> {
        if (this.destroyed) return;
        try {
            const task = await api.getInferenceStatus(taskId);
            this.inferenceStatusRetries = 0;
            this.editor.bsState.inferenceRequestError = '';
            await this.handleInferenceTask(task);
        } catch (error) {
            if (this.destroyed) return;
            this.inferenceStatusRetries += 1;
            const errorMessage = this.getErrorMessage(error);
            if (this.inferenceStatusRetries < INFERENCE_STATUS_MAX_RETRIES) {
                this.editor.showMsg(
                    'warning',
                    `Failed to query dataset inference status (${this.inferenceStatusRetries}/${INFERENCE_STATUS_MAX_RETRIES}): ${errorMessage}`,
                );
                const retryDelay =
                    INFERENCE_POLL_INTERVAL_MS * Math.pow(2, this.inferenceStatusRetries - 1);
                this.scheduleInferencePoll(taskId, retryDelay);
                return;
            }
            this.editor.bsState.inferenceRequestError =
                `Failed to query dataset inference status after ${INFERENCE_STATUS_MAX_RETRIES} attempts: ${errorMessage}`;
            this.editor.handleErr(error, this.editor.bsState.inferenceRequestError);
        }
    }

    private async handleInferenceTask(task: IInferenceTask): Promise<void> {
        if (this.destroyed) return;
        this.editor.bsState.inferenceTask = task;
        if (task.status === 'QUEUED' || task.status === 'RUNNING') {
            this.scheduleInferencePoll(task.id, INFERENCE_POLL_INTERVAL_MS);
            return;
        }
        this.clearInferencePollTimer();
        if (task.status === 'FAILED') {
            this.editor.showMsg(
                'error',
                `Dataset inference failed: ${task.errorMessage || 'No error message was returned'}`,
                8,
            );
            return;
        }
        await this.refreshInferenceData(task.affectedDataIds);
        if (!this.destroyed) {
            this.editor.showMsg('success', 'Dataset inference completed');
        }
    }

    private async refreshInferenceData(affectedDataIds: string[]): Promise<void> {
        if (this.destroyed || affectedDataIds.length === 0) return;
        const affectedIds = new Set(affectedDataIds);
        affectedIds.forEach((dataId) => {
            const frameKey = String(dataId);
            this.dataMap.delete(frameKey);
            this.hasMap.delete(frameKey);
            const frame = this.editor.getFrame(dataId);
            if (frame) frame.needSave = false;
        });

        const { frameIndex, frames } = this.editor.state;
        const currentFrame = frames[frameIndex];
        if (currentFrame && affectedIds.has(currentFrame.id)) {
            await this.editor.loadFrame(frameIndex, true, true);
        } else {
            this.editor.loadManager.updateTrackMap();
            this.loadDataFromManager();
        }
    }

    private scheduleInferencePoll(taskId: string, delay: number): void {
        this.clearInferencePollTimer();
        if (this.destroyed) return;
        this.inferencePollTimer = window.setTimeout(() => {
            this.inferencePollTimer = undefined;
            void this.pollInferenceStatus(taskId);
        }, delay);
    }

    private clearInferencePollTimer(): void {
        if (this.inferencePollTimer !== undefined) {
            window.clearTimeout(this.inferencePollTimer);
            this.inferencePollTimer = undefined;
        }
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    async pollDataModelResult(): Promise<void> {
        if (this.destroyed || this.modelPolling) return;
        if (this.modelPollTimer !== undefined) {
            window.clearTimeout(this.modelPollTimer);
            this.modelPollTimer = undefined;
        }
        this.modelPolling = true;
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

        if (Object.keys(modelMap).length === 0) {
            this.modelPolling = false;
            return;
        }

        let requests: Promise<void>[] = [];
        Object.keys(modelMap).forEach((recordId) => {
            requests.push(createRequest(recordId, modelMap[recordId]));
        });

        try {
            await Promise.all(requests);
            if (!this.destroyed) {
                this.modelPollTimer = window.setTimeout(() => {
                    this.modelPollTimer = undefined;
                    void this.pollDataModelResult();
                }, 1500);
            }
        } finally {
            this.modelPolling = false;
        }

        function createRequest(recordId: string, dataInfos: IFrame[]): Promise<void> {
            let ids = dataInfos.map((e) => e.id);
            let request = api
                .getModelResult(ids, recordId)
                .then((data) => {
                    if (_this.destroyed) return;
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

    destroy(): void {
        this.destroyed = true;
        this.clearInferencePollTimer();
        if (this.modelPollTimer !== undefined) {
            window.clearTimeout(this.modelPollTimer);
            this.modelPollTimer = undefined;
        }
        this.trackingPollStops.forEach((stop) => stop());
        this.trackingPollStops.clear();
        super.destroy();
    }

    async runModelTrack(
        curId: string,
        toIds: string[],
        direction: 'BACKWARD' | 'FORWARD',
        targetObjects: any[],
        _trackIdName: Record<string, string>,
        onComplete?: () => void,
        useZ = true,
    ): Promise<void> {
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
                useZ,
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
            let stopPolling: (() => void) | undefined;
            const releasePolling = (): void => {
                if (stopPolling) this.trackingPollStops.delete(stopPolling);
            };
            stopPolling = pollModelTrack(
                recordId,
                toIds,
                (objectsMap) => {
                    releasePolling();
                    if (this.destroyed) return;
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
                    releasePolling();
                    if (this.destroyed) return;
                    editor.showLoading(false);
                    editor.showMsg('error', editor.lang('track-error'));
                },
            );
            if (this.destroyed) {
                stopPolling();
            } else {
                this.trackingPollStops.add(stopPolling);
            }
        } catch (error) {
            if (!this.destroyed) {
                editor.showLoading(false);
                editor.showMsg('error', editor.lang('track-error'));
            }
        }
    }

    onAnnotatesAdd(objects: AnnotateObject[], frame?: IFrame | undefined): void {
        let { user } = this.editor.bsState;

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
