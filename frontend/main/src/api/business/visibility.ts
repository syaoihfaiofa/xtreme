import { defHttp } from '/@/utils/http/axios';

export interface VisibilityEnsureParams {
  datasetId: number;
  sceneId: number;
  selectedDataIds?: number[];
}

export type VisibilityTaskType = 'OCC' | 'VISIBILITY';

export interface VisibilityRun {
  id: number;
  datasetId: number;
  sceneId: number;
  taskType: VisibilityTaskType;
  occRunId?: number;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'STALE';
  stage: 'QUEUED' | 'PREPARING' | 'OCC_GENERATION' | 'LIDAR_VISIBILITY' | 'ANNOTATION_VISIBILITY' | 'WRITING' | 'COMPLETED' | 'FAILED';
  progress: number;
  totalFrames: number;
  completedFrames: number;
  error?: string;
}

export const ensureVisibilityApi = (params: VisibilityEnsureParams) =>
  defHttp.post<VisibilityRun>({
    url: '/annotate/visibility/ensure',
    params,
  });

export const forceVisibilityApi = (params: VisibilityEnsureParams) =>
  defHttp.post<VisibilityRun>({
    url: '/annotate/visibility/force',
    params,
  });

export const getVisibilityRunApi = (runId: number) =>
  defHttp.get<VisibilityRun>({
    url: `/annotate/visibility/status/${runId}`,
  });

export const getVisibilityRunsApi = (datasetId: number, sceneId: number) =>
  defHttp.get<VisibilityRun[]>({
    url: '/annotate/visibility/runs',
    params: { datasetId, sceneId },
  });

export const cancelVisibilityRunApi = (runId: number) =>
  defHttp.post<VisibilityRun>({
    url: `/annotate/visibility/runs/${runId}/cancel`,
  });

export const deleteOccRunApi = (runId: number) =>
  defHttp.delete<void>({
    url: `/annotate/visibility/runs/${runId}`,
  });

export const createVisibilityTaskApi = (occRunId: number, selectedDataIds: number[]) =>
  defHttp.post<VisibilityRun>({
    url: '/annotate/visibility/tasks/visibility',
    params: { occRunId, selectedDataIds },
  });

export const getSceneVisibilityFrameIdsApi = (datasetId: number, sceneId: number) =>
  defHttp.get<number[]>({
    url: `/annotate/visibility/scene/${sceneId}/frames`,
    params: { datasetId },
  });
