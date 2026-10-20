export type AutoOcclusionScope = 'current' | 'scene' | 'custom';

export interface VisibilityEnsureRequest {
  datasetId: number;
  sceneId: number;
  selectedDataIds?: number[];
}

export function parseSelectedDataIds(value: string): number[] {
  const tokens = value.split(',').map((token) => token.trim()).filter(Boolean);
  const ids = tokens.map((token) => Number(token));
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('自定义帧必须是以逗号分隔的正整数 dataId。');
  }
  return [...new Set(ids)];
}

export function parseFrameRanges(value: string, maxFrameIndex: number): number[] {
  if (!Number.isSafeInteger(maxFrameIndex) || maxFrameIndex <= 0) {
    throw new Error('场景帧列表尚未加载完成。');
  }
  const tokens = value.split(',').map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) {
    throw new Error('请输入帧序号或范围，例如：13-20。');
  }
  const indexes: number[] = [];
  for (const token of tokens) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) {
      throw new Error(`无效帧范围：${token}。请使用 13 或 13-20。`);
    }
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) {
      throw new Error(`无效帧范围：${token}。帧序号从 1 开始。`);
    }
    if (end > maxFrameIndex) {
      throw new Error(`帧范围超出场景：${token}，有效范围为 1-${maxFrameIndex}。`);
    }
    for (let index = start; index <= end; index++) indexes.push(index);
  }
  return [...new Set(indexes)].sort((left, right) => left - right);
}

export function toEnsureRequest(
  datasetId: number,
  sceneId: number,
  scope: AutoOcclusionScope,
  selectedDataIds: number[],
): VisibilityEnsureRequest {
  return {
    datasetId,
    sceneId,
    ...(scope === 'scene' ? {} : { selectedDataIds }),
  };
}
