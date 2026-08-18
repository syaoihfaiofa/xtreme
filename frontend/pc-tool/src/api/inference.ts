import { IInferenceStatus, IInferenceTask } from '../type';
import { get, post } from './base';

interface IInferenceTaskResponse {
    id: string | number;
    status: IInferenceStatus;
    totalFrames: number;
    completedFrames: number;
    progress: number;
    error?: string | null;
    errorMessage?: string | null;
    affectedDataIds?: Array<string | number>;
}

interface IApiResponse<T> {
    data: T;
}

function normalizeInferenceTask(task: IInferenceTaskResponse): IInferenceTask {
    if (!task || task.id === undefined || !task.status) {
        throw new Error('Inference API returned an invalid task response');
    }
    return {
        id: String(task.id),
        status: task.status,
        totalFrames: task.totalFrames,
        completedFrames: task.completedFrames,
        progress: task.progress,
        errorMessage: task.errorMessage || task.error || null,
        affectedDataIds: (task.affectedDataIds || []).map(String),
    };
}

export async function ensureInference(recordId: string): Promise<IInferenceTask> {
    const response = await post<IApiResponse<IInferenceTaskResponse>>(
        '/api/annotate/inference/ensure',
        { recordId },
    );
    return normalizeInferenceTask(response.data);
}

export async function getInferenceStatus(id: string): Promise<IInferenceTask> {
    const response = await get<IApiResponse<IInferenceTaskResponse>>(
        `/api/annotate/inference/status/${id}`,
    );
    return normalizeInferenceTask(response.data);
}
