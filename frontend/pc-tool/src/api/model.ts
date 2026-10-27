import { get, post } from './base';
import { IModel } from 'pc-editor';
import { utils } from 'pc-editor';

const FUSION_ONLY_MODEL_CODES = ['IMAGE_KEYPOINT_LIFTED_DETECTION', 'IMAGE_ROD_DETECTION'];
const LIDAR_FUSION = 'LIDAR_FUSION';

export interface CompletedSceneModelRun {
    recordId: number;
    modelId: number;
    modelName: string;
    modelCode: string;
    createdAt?: string;
    frameCount: number;
    objectCount: number;
}

export interface MergeModelRunsRequest {
    datasetId: number;
    sceneId: number;
    modelRunRecordIds: number[];
    mode: 'APPEND' | 'REPLACE';
}

export interface MergeModelRunsResult {
    writtenObjectCount: number;
    frameCount: number;
    skippedFrames: number[];
    snapshotId?: number;
}

interface ApiResponse<T> {
    data: T;
}

export async function getModelList(datasetType?: string) {
    let url = '/api/model/list';
    let data = await get(url);
    data = data.data || [];

    let models = [] as IModel[];
    data.forEach((e: any) => {
        if (e.isInteractive || e.datasetType === 'IMAGE') return;
        if (
            FUSION_ONLY_MODEL_CODES.includes(e.modelCode) &&
            datasetType !== LIDAR_FUSION
        ) {
            return;
        }
        // let classes = JSON.parse(e.classes || '[]');
        let classes = (e.classes || []).map((e: any) => {
            return { label: e.name, value: e.code };
        });
        models.push({
            id: e.id + '',
            name: e.name,
            version: e.version,
            code: e.modelCode,
            classes,
        });
    });

    return models;
}

export async function clearModel(dataIds: number[], recordId: string) {
    let url = `/api/data/removeModelDataResult`;
    let data = await post(url, { serialNo: recordId, dataIds });
}

export async function getModelResult(dataIds: string[], recordId: string) {
    let url = '/api/data/modelAnnotationResult';
    const query = utils.queryStr({
        serialNo: recordId,
        dataIds: dataIds,
    });
    return await get(`${url}?${query}`);
}

export async function runModel(config: any) {
    let url = '/api/data/modelAnnotate';
    return await post(url, config);
}

export async function getCompletedSceneModelRuns(
    sceneId: string,
): Promise<CompletedSceneModelRun[]> {
    const response = await get<ApiResponse<CompletedSceneModelRun[]>>(
        `/api/data/scene/${sceneId}/completedModelRuns`,
    );
    return response.data || [];
}

export async function mergeModelRunsToGt(
    request: MergeModelRunsRequest,
): Promise<MergeModelRunsResult> {
    const response = await post<ApiResponse<MergeModelRunsResult>>(
        '/api/data/mergeModelRunsToGt',
        request,
    );
    return response.data;
}
