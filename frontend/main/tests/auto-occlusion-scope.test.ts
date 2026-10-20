import {
  parseSelectedDataIds,
  toEnsureRequest,
} from '../src/views/autoOcclusion/scope';

describe('auto-occlusion scope', () => {
  test('parses positive numeric data ids and removes duplicates', () => {
    expect(parseSelectedDataIds('12, 5,12')).toEqual([12, 5]);
  });

  test('rejects non-positive or non-numeric data ids', () => {
    expect(() => parseSelectedDataIds('12, abc, 0')).toThrow(
      '自定义帧必须是以逗号分隔的正整数 dataId。',
    );
  });

  test('builds a current-frame ensure request', () => {
    expect(toEnsureRequest(8, 9, 'current', [10])).toEqual({
      datasetId: 8,
      sceneId: 9,
      selectedDataIds: [10],
    });
  });
});
