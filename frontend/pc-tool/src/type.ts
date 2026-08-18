export interface IUser {
    id: string;
    nickname: string;
    email?: string;
    status?: string;
    username?: string;
}

export type IInferenceStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export type IInferenceMotionMode =
    | 'STATIC'
    | 'DYNAMIC_FIXED_SIZE'
    | 'DYNAMIC_VARIABLE_SIZE';

export interface IInferenceClassMapping {
    modelClassCode: string;
    datasetClassId: number;
    motionMode: IInferenceMotionMode;
}

export interface IInferenceConfig {
    modelId: number;
    syncDistance: number;
    maxOutsideFrames: number;
    associationIou: number;
    minConfidence: number;
    classMappings: IInferenceClassMapping[];
}

export interface IInferenceTask {
    id: string;
    status: IInferenceStatus;
    totalFrames: number;
    completedFrames: number;
    progress: number;
    errorMessage: string | null;
    affectedDataIds: string[];
}

export interface IDataSetInfo {
    name: string;
    type: string;
    syncMode: boolean;
    inferenceMode: boolean;
    inferenceConfig: IInferenceConfig | null;
}

export interface IBSState {
    query: Record<string, string>;
    // flow
    saving: boolean;
    validing: boolean;
    submitting: boolean;
    modifying: boolean;
    recordId: string;
    // dataset info
    datasetId: string;
    datasetName: string;
    datasetType: string;
    syncMode: boolean;
    inferenceMode: boolean;
    inferenceConfig: IInferenceConfig | null;
    inferenceEnsuring: boolean;
    inferenceTask: IInferenceTask | null;
    inferenceRequestError: string;
    reviewMode: boolean;
    seriesFrameId?: string;
    //
    user: IUser;
}

export type IAction = 'save' | 'close';

export interface IOption {
    label: string;
    value: string;
}

export interface IPageHandler {
    init: () => void;
    onAction: (e: IAction) => void;
}
