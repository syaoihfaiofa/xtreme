export interface VisibilityRunStatus {
  status: string;
}

export function filterActiveVisibilityRuns<T extends VisibilityRunStatus>(runs: T[]): T[] {
  return runs.filter((run) => run.status === 'QUEUED' || run.status === 'RUNNING');
}
