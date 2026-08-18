import { datasetTypeEnum } from './datasetModel';
import { BasicPageParams, BasicFetchResult } from '/@/api/model/baseModel';

/** Models List Start */
export enum ModelType {
  DETECTION = 'DETECTION',
  TRACKING = 'TRACKING',
}

/** list item */
export interface ModelListItem {
  id: number;
  teamId: Nullable<string>;
  name: string;
  runNo: Nullable<number>;
  runCount: number;
  isDeleted: boolean;
  enable: boolean;
  description: Nullable<string>;
  scenario: Nullable<string>;
  classes: Nullable<ModelClassItem[]>;
  createdAt: Date;
  createdBy: string | number;
  creatorName: string;
  datasetType: datasetTypeEnum;
  modelType: ModelType;
  isInteractive: boolean;
  img: string;
}

export interface ModelClassItem {
  name: string;
  code: string;
}
/** list request params */
export interface GetModelParams extends BasicPageParams {
  datasetType?: datasetTypeEnum;
  isInteractive?: 0 | 1;
}

/** list response params */
export type ResponseModelParams = BasicFetchResult<ModelListItem>;

/** add Models */
export interface SaveModelParams {
  name: string;
}
/** Models List End */

/** Runs Start */
/** status Enum */
export enum statusEnum {
  started = 'STARTED',
  running = 'RUNNING',
  success = 'SUCCESS',
  failure = 'FAILURE',
  SUCCESS_WITH_ERROR = 'SUCCESS_WITH_ERROR',
}
/** run table ite, */
export interface ModelRunItem {
  id: number;
  teamId: number;
  modelId: number;
  datasetId: number;
  datasetName: string;
  createdAt: Date;
  status: statusEnum;
  runNo: string;
  errorReason: Nullable<string>;
  parameter: string;
}
/** table request params */
export interface GetModelRunParams extends BasicPageParams {
  modelId?: number;
}

/** table response params */
export type ResponseModelRunParams = BasicFetchResult<ModelRunItem>;

/** PreModel params */
export interface DataModelParam {
  dataCountRatio: number;
  isExcludeModelData: boolean;
  splitType?: string;
  annotationStatus?: string;
  sceneIds?: number[];
}
export interface ResultsModelParam {
  minConfidence: number;
  maxConfidence: number;
  classes: string[];
}

/** model run params */
export interface runModelRunParams {
  datasetId: number;
  modelId: number;
  resultFilterParam: Nullable<ResultsModelParam>;
  dataFilterParam: Nullable<DataModelParam>;
}

export type InferenceMotionMode =
  | 'STATIC'
  | 'DYNAMIC_FIXED_SIZE'
  | 'DYNAMIC_VARIABLE_SIZE';

export interface InferenceClassMapping {
  modelClassCode: string;
  datasetClassId: number;
  motionMode: InferenceMotionMode;
}

export interface InferenceRunParams {
  datasetId: number;
  modelId: number;
  sceneIds: number[];
  startFrameNo?: number;
  endFrameNo?: number;
  syncDistance: number;
  maxOutsideFrames: number;
  associationIou: number;
  minConfidence: number;
  useZ: boolean;
  classMappings: InferenceClassMapping[];
}

export type SceneInferenceRunStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED';

export interface SceneInferenceRunItem {
  id: number;
  datasetId: number;
  sceneId: number;
  startFrameNo?: number;
  endFrameNo?: number;
  sceneName?: string;
  configHash: string;
  configSnapshot: Omit<InferenceRunParams, 'datasetId' | 'sceneIds'>;
  status: SceneInferenceRunStatus;
  progress: number;
  totalFrames: number;
  completedFrames: number;
  error: Nullable<string>;
  affectedDataIds: number[];
  createdAt: string;
  updatedAt: string;
}
/** Runs End */

export interface modelQuotaResponse {
  totalQuota: string;
  usedQuota: string;
  expireDate: string;
}

export interface editParams {
  id: number;
  name?: string;
  description?: string;
  url?: string;
}

export interface testModelUrlConnectioParams {
  modelId: Number;
  url: string;
}
export interface modelClassList {
  name: string;
  code: string;
}

export interface setClassParams {
  modelId: number;
  modelClassList: Array<modelClassList>;
}

export interface ModelDataCountParams {
  datasetId: number;
  modelId: number;
  dataCountRatio?: number;
  isExcludeModelData: boolean;
  splitType?: string;
  annotationStatus?: string;
  sceneIds?: string;
}
