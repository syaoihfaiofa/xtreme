import { filterActiveVisibilityRuns } from '../src/views/autoOcclusion/runs';

describe('auto-occlusion runs', () => {
  test('keeps only queued and running runs', () => {
    expect(filterActiveVisibilityRuns([
      { id: 1, status: 'QUEUED' },
      { id: 2, status: 'RUNNING' },
      { id: 3, status: 'SUCCEEDED' },
      { id: 4, status: 'FAILED' },
    ])).toEqual([
      { id: 1, status: 'QUEUED' },
      { id: 2, status: 'RUNNING' },
    ]);
  });
});
