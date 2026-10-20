<template>
  <main class="auto-occlusion">
    <section class="auto-occlusion__card">
      <header class="auto-occlusion__hero">
        <span class="auto-occlusion__eyebrow">OCC workspace</span>
        <h1>生成 OCC</h1>
        <p>结果保存为独立 sidecar，不会修改原始标注；可见性可在只读 PC 工具中按需计算。</p>
      </header>
      <p v-if="errorMessage" class="auto-occlusion__error">{{ errorMessage }}</p>
      <template v-else>
        <section class="auto-occlusion__scene">
          <div><span>场景</span><strong>#{{ sceneId }}</strong></div>
          <div><span>入口数据</span><strong>#{{ dataId }}</strong></div>
          <div><span>场景首帧</span><strong v-if="currentFrameId">第 1 帧 · {{ currentFrameId }}</strong><strong v-else>不可用</strong></div>
        </section>

        <section class="auto-occlusion__section">
          <div class="auto-occlusion__section-title">
            <h2>生成范围</h2>
            <span>选择需要生成 OCC 的帧</span>
          </div>
          <div class="auto-occlusion__scope-grid">
            <label :class="{ active: scope === 'current' }">
              <input v-model="scope" type="radio" value="current" />
              <strong>场景首帧</strong>
              <small>第 1 帧</small>
            </label>
            <label :class="{ active: scope === 'scene' }">
              <input v-model="scope" type="radio" value="scene" />
              <strong>整个场景</strong>
              <small>全部场景帧</small>
            </label>
            <label :class="{ active: scope === 'custom' }">
              <input v-model="scope" type="radio" value="custom" />
              <strong>自定义范围</strong>
              <small>按帧序号选择</small>
            </label>
          </div>
          <div v-if="scope === 'custom'" class="auto-occlusion__custom">
            <label for="frame-range">帧序号范围</label>
            <input
              id="frame-range"
              v-model="customFrameRange"
              placeholder="例如：13-20 或 1-5,13,20-22"
            />
            <p class="auto-occlusion__hint">帧序号从 1 开始；范围会自动转换为场景内对应的 dataId。</p>
            <p v-if="customFrameError" class="auto-occlusion__error">{{ customFrameError }}</p>
            <p v-else-if="customFrameSummary" class="auto-occlusion__summary">{{ customFrameSummary }}</p>
          </div>
          <p v-if="scope === 'current' && !currentFrameId" class="auto-occlusion__error">
            入口未提供场景首帧 dataId；请选择整个场景或自定义范围。
          </p>
        </section>

        <div class="auto-occlusion__actions">
          <button class="auto-occlusion__primary" :disabled="isActionDisabled" @click="startRun">
            {{ isStarting ? '正在提交…' : '生成 OCC' }}
          </button>
          <button class="auto-occlusion__secondary" :disabled="isActionDisabled" @click="forceRun">
            强制重新生成
          </button>
        </div>
        <div v-if="run" class="auto-occlusion__status">
          <p>OCC 运行 #{{ run.id }}：{{ statusText }}</p>
          <p>阶段：{{ stageText }}</p>
          <p>进度：{{ progressText }}（{{ run.completedFrames }}/{{ run.totalFrames }} 帧）</p>
          <p v-if="run.error" class="auto-occlusion__error">{{ run.error }}</p>
          <button v-if="run.status === 'SUCCEEDED' && openDataId" @click="openTool">
            打开只读 PC 工具
          </button>
        </div>
        <section class="auto-occlusion__runs">
          <h2>运行中的任务</h2>
          <p v-if="isLoadingRuns && !activeRuns.length">正在读取运行任务…</p>
          <p v-else-if="!isLoadingRuns && !activeRuns.length">
            当前场景没有排队或运行中的任务。
          </p>
          <ul v-else>
            <li v-for="activeRun in activeRuns" :key="activeRun.id">
              <div>
                <strong>Run ID：{{ activeRun.id }}</strong>
                <p>状态：{{ getStatusText(activeRun.status) }}</p>
                <p>阶段：{{ getStageText(activeRun.stage) }}</p>
                <p>
                  进度：{{ Math.round(activeRun.progress * 100) }}%
                  （{{ activeRun.completedFrames }}/{{ activeRun.totalFrames }} 帧）
                </p>
              </div>
              <button
                :disabled="cancellingRunIds.has(activeRun.id)"
                @click="cancelRun(activeRun.id)"
              >
                {{ cancellingRunIds.has(activeRun.id) ? '正在停止…' : '停止' }}
              </button>
            </li>
          </ul>
        </section>
        <section class="auto-occlusion__runs">
          <h2>已生成的整场景 OCC</h2>
          <p v-if="isLoadingRuns && !completedSceneOccRuns.length">正在读取已生成结果…</p>
          <p v-else-if="!completedSceneOccRuns.length">暂无可直接复用的整场景 OCC。</p>
          <ul v-else>
            <li v-for="completedRun in completedSceneOccRuns" :key="completedRun.id">
              <div>
                <strong>Run ID：{{ completedRun.id }}</strong>
                <p>已完成 {{ completedRun.completedFrames }}/{{ completedRun.totalFrames }} 帧</p>
              </div>
              <button @click="openExistingSceneOcc(completedRun)">
                打开结果
              </button>
              <button :disabled="isActionDisabled" @click="startVisibility(completedRun)">
                计算遮挡
              </button>
              <button @click="deleteOccRun(completedRun)">
                删除
              </button>
            </li>
          </ul>
        </section>
      </template>
    </section>
  </main>
</template>

<script lang="ts" setup>
  import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
  import { useRoute } from 'vue-router';

  import {
    cancelVisibilityRunApi,
    createVisibilityTaskApi,
    deleteOccRunApi,
    ensureVisibilityApi,
    forceVisibilityApi,
    getSceneVisibilityFrameIdsApi,
    getVisibilityRunApi,
    getVisibilityRunsApi,
  } from '/@/api/business/visibility';
  import type { VisibilityRun } from '/@/api/business/visibility';
  import { getToolUrl } from '/@/utils/business';
  import { filterActiveVisibilityRuns } from './runs';
  import {
    AutoOcclusionScope,
    parseFrameRanges,
    toEnsureRequest,
  } from './scope';

  const route = useRoute();
  const errorMessage = ref<string>('');
  const scope = ref<AutoOcclusionScope>('current');
  const customFrameRange = ref<string>('');
  const sceneFrameIds = ref<number[]>([]);
  const frameLoadError = ref<string>('');
  const isLoadingFrames = ref<boolean>(false);
  const run = ref<VisibilityRun>();
  const isStarting = ref<boolean>(false);
  const isPolling = ref<boolean>(false);
  const activeRuns = ref<VisibilityRun[]>([]);
  const completedSceneOccRuns = ref<VisibilityRun[]>([]);
  const isLoadingRuns = ref<boolean>(false);
  const cancellingRunIds = ref<Set<number>>(new Set());
  let pollTimer: ReturnType<typeof window.setTimeout> | undefined;
  let activeRunsPollTimer: ReturnType<typeof window.setTimeout> | undefined;

  const getPositiveQueryValue = (value: unknown): number | undefined => {
    const parsed = typeof value === 'string' ? Number(value) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const datasetId = getPositiveQueryValue(route.query.datasetId);
  const sceneId = getPositiveQueryValue(route.query.sceneId);
  const dataId = getPositiveQueryValue(route.query.dataId);
  const currentFrameId = getPositiveQueryValue(route.query.frameDataId);
  const getStatusText = (status: VisibilityRun['status']): string => {
    const labels: Record<VisibilityRun['status'], string> = {
      QUEUED: '排队中',
      RUNNING: '生成中',
      SUCCEEDED: '生成成功',
      FAILED: '生成失败',
      STALE: '已失效',
    };
    return labels[status];
  };
  const getStageText = (stage: VisibilityRun['stage']): string => {
    const labels: Record<VisibilityRun['stage'], string> = {
      QUEUED: '等待执行',
      PREPARING: '准备任务输入',
      OCC_GENERATION: '融合点云并生成 OCC',
      LIDAR_VISIBILITY: '计算 LiDAR 观测区域',
      ANNOTATION_VISIBILITY: '整理 OCC 语义结果',
      WRITING: '写入 OCC 结果',
      COMPLETED: '已完成',
      FAILED: '执行失败',
    };
    return labels[stage];
  };
  const customFrameError = computed(() => {
    if (scope.value !== 'custom') return '';
    if (frameLoadError.value) return frameLoadError.value;
    try {
      resolveCustomDataIds();
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : '自定义帧范围无效。';
    }
  });
  const customFrameSummary = computed(() => {
    if (customFrameError.value || !customFrameRange.value.trim()) return '';
    const indexes = parseFrameRanges(customFrameRange.value, sceneFrameIds.value.length);
    const dataIds = resolveCustomDataIds();
    return `将生成第 ${indexes.join('、')} 帧（${dataIds.length} 帧）。`;
  });
  const isActionDisabled = computed(() =>
    isStarting.value
    || isPolling.value
    || (scope.value === 'current' && !currentFrameId)
    || (scope.value === 'scene' && !sceneFrameIds.value.length)
    || (scope.value === 'custom' && Boolean(customFrameError.value)),
  );
  const openDataId = computed(() =>
    scope.value === 'custom' ? parseOpenDataId() : currentFrameId,
  );
  const statusText = computed(() => {
    const status = run.value?.status;
    return status ? getStatusText(status) : '未知状态';
  });
  const stageText = computed(() => {
    return run.value?.stage ? getStageText(run.value.stage) : '等待状态更新';
  });
  const progressText = computed(() => {
    const progress = run.value?.progress ?? 0;
    return `${Math.round(progress * 100)}%`;
  });

  onMounted((): void => {
    if (!datasetId || !sceneId || !dataId) {
      errorMessage.value = '缺少有效参数：datasetId、sceneId 和 dataId。';
      return;
    }
    void pollActiveRuns();
  });

  onBeforeUnmount((): void => {
    if (pollTimer) window.clearTimeout(pollTimer);
    if (activeRunsPollTimer) window.clearTimeout(activeRunsPollTimer);
  });

  const parseOpenDataId = (): number | undefined => {
    if (scope.value === 'custom') {
      try {
        return resolveCustomDataIds()[0];
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const selectedDataIds = (): number[] => {
    if (scope.value === 'current') return currentFrameId ? [currentFrameId] : [];
    if (scope.value === 'custom') return resolveCustomDataIds();
    return sceneFrameIds.value;
  };

  const resolveCustomDataIds = (): number[] => {
    const indexes = parseFrameRanges(customFrameRange.value, sceneFrameIds.value.length);
    return indexes.map((index) => sceneFrameIds.value[index - 1]);
  };

  const loadSceneFrames = async (): Promise<void> => {
    if (!datasetId || !sceneId) return;
    isLoadingFrames.value = true;
    frameLoadError.value = '';
    try {
      sceneFrameIds.value = await getSceneVisibilityFrameIdsApi(datasetId, sceneId);
    } catch (error) {
      frameLoadError.value = error instanceof Error ? error.message : '场景帧列表读取失败。';
    } finally {
      isLoadingFrames.value = false;
    }
  };

  watch(scope, (nextScope): void => {
    if (
      ['custom', 'scene'].includes(nextScope)
      && !sceneFrameIds.value.length
      && !isLoadingFrames.value
    ) {
      void loadSceneFrames();
    }
  });

  const pollActiveRuns = async (): Promise<void> => {
    if (!datasetId || !sceneId) return;
    isLoadingRuns.value = true;
    try {
      const runs = await getVisibilityRunsApi(datasetId, sceneId);
      activeRuns.value = filterActiveVisibilityRuns(runs);
      completedSceneOccRuns.value = runs.filter(
        (item) =>
          item.taskType === 'OCC'
          && item.status === 'SUCCEEDED'
          && item.totalFrames > 1
          && item.completedFrames === item.totalFrames,
      );
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '查询 OCC 运行任务失败。';
      return;
    } finally {
      isLoadingRuns.value = false;
    }
    if (activeRuns.value.length) {
      activeRunsPollTimer = window.setTimeout(pollActiveRuns, 1500);
    }
  };

  const pollRun = async (): Promise<void> => {
    if (!run.value || ['SUCCEEDED', 'FAILED'].includes(run.value.status)) {
      isPolling.value = false;
      return;
    }
    isPolling.value = true;
    try {
      run.value = await getVisibilityRunApi(run.value.id);
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '查询 OCC 状态失败。';
      isPolling.value = false;
      return;
    }
    pollTimer = window.setTimeout(pollRun, 1500);
  };

  const startRun = async (): Promise<void> => {
    if (!datasetId || !sceneId) return;
    errorMessage.value = '';
    isStarting.value = true;
    try {
      run.value = await ensureVisibilityApi(
        toEnsureRequest(datasetId, sceneId, scope.value, selectedDataIds()),
      );
      void pollActiveRuns();
      await pollRun();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '启动 OCC 生成失败。';
    } finally {
      isStarting.value = false;
    }
  };

  const forceRun = async (): Promise<void> => {
    if (!datasetId || !sceneId) return;
    errorMessage.value = '';
    isStarting.value = true;
    try {
      run.value = await forceVisibilityApi(
        toEnsureRequest(datasetId, sceneId, scope.value, selectedDataIds()),
      );
      void pollActiveRuns();
      await pollRun();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '强制重新生成 OCC 失败。';
    } finally {
      isStarting.value = false;
    }
  };

  const cancelRun = async (runId: number): Promise<void> => {
    cancellingRunIds.value = new Set(cancellingRunIds.value).add(runId);
    try {
      const cancelledRun = await cancelVisibilityRunApi(runId);
      if (run.value?.id === cancelledRun.id) run.value = cancelledRun;
      await pollActiveRuns();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '停止 OCC 运行任务失败。';
    } finally {
      const pendingRunIds = new Set(cancellingRunIds.value);
      pendingRunIds.delete(runId);
      cancellingRunIds.value = pendingRunIds;
    }
  };

  const openTool = (): void => {
    if (!datasetId || !openDataId.value || !run.value) return;
    const opensScene = scope.value === 'scene';
    window.location.assign(getToolUrl({
      datasetId,
      dataId: opensScene ? sceneId : openDataId.value,
      dataType: opensScene ? 'scene' : 'SINGLE_DATA',
      type: 'visibility',
      visibilityRunId: run.value.id,
    }));
  };

  const openExistingSceneOcc = (occRun: VisibilityRun): void => {
    if (!datasetId || !sceneId) return;
    window.location.assign(getToolUrl({
      datasetId,
      dataId: sceneId,
      dataType: 'scene',
      type: 'visibility',
      visibilityRunId: occRun.id,
    }));
  };

  const startVisibility = async (occRun: VisibilityRun): Promise<void> => {
    try {
      run.value = await createVisibilityTaskApi(occRun.id, selectedDataIds());
      await pollRun();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '启动遮挡计算失败。';
    }
  };

  const deleteOccRun = async (occRun: VisibilityRun): Promise<void> => {
    if (!window.confirm(`删除 OCC Run #${occRun.id} 及其关联遮挡结果？`)) return;
    try {
      await deleteOccRunApi(occRun.id);
      await pollActiveRuns();
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '删除 OCC 失败。';
    }
  };
</script>

<style lang="less" scoped>
  .auto-occlusion {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    color: #fff;
    background: #1e1f23;

    &__card {
      width: 480px;
      padding: 28px;
      border-radius: 8px;
      background: #2b2d33;
    }

    label,
    input,
    button {
      display: block;
      width: 100%;
      margin: 12px 0;
    }

    input {
      color: #fff;
      background: #1e1f23;
      border: 1px solid #5b606b;

      &::placeholder {
        color: #9ba1ad;
      }
    }

    &__hero {
      margin-bottom: 24px;

      h1 {
        margin: 4px 0 8px;
        font-size: 28px;
      }

      p {
        margin: 0;
        color: #bac2d0;
        line-height: 1.6;
      }
    }

    &__eyebrow {
      color: #79a9ff;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    &__scene,
    &__scope-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    &__scene {
      margin-bottom: 22px;

      > div {
        padding: 13px;
        border: 1px solid #404755;
        border-radius: 10px;
        background: #20232b;
      }

      span,
      strong {
        display: block;
      }

      span {
        margin-bottom: 5px;
        color: #9ba6b9;
        font-size: 12px;
      }

      strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    &__section {
      padding: 18px;
      border: 1px solid #404755;
      border-radius: 12px;
      background: #20232b;
    }

    &__section-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;

      h2 {
        margin: 0;
        font-size: 16px;
      }

      span {
        color: #9ba6b9;
        font-size: 12px;
      }
    }

    &__scope-grid {
      label {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-height: 72px;
        margin: 0;
        padding: 14px;
        border: 1px solid #4a5262;
        border-radius: 10px;
        cursor: pointer;

        &.active {
          border-color: #4c8dff;
          background: rgba(48, 112, 225, 0.16);
          box-shadow: inset 0 0 0 1px rgba(76, 141, 255, 0.3);
        }

        input {
          position: absolute;
          top: 10px;
          right: 10px;
          width: auto;
          margin: 0;
        }

        strong {
          padding-right: 20px;
          font-size: 14px;
        }

        small {
          color: #aab3c3;
          font-size: 12px;
        }
      }
    }

    &__custom {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid #3d4350;

      > label {
        margin: 0;
        color: #dce2ed;
        font-size: 13px;
      }
    }

    &__actions {
      display: flex;
      gap: 12px;
      margin-top: 18px;

      button {
        flex: 1;
        margin: 0;
        padding: 11px 16px;
        border-radius: 8px;
        font-weight: 600;
        cursor: pointer;
      }
    }

    &__primary {
      color: #fff;
      background: #3478ef;
      border: 1px solid #5693ff;
    }

    &__secondary {
      color: #d9e2f3;
      background: transparent;
      border: 1px solid #5b6578;
    }

    &__error {
      color: #ff7875;
    }

    &__hint {
      color: #b7bbc5;
      font-size: 12px;
    }

    &__status {
      margin-top: 20px;
      padding-top: 12px;
      border-top: 1px solid #4b4e55;
    }

    &__runs {
      margin-top: 20px;
      padding-top: 12px;
      border-top: 1px solid #4b4e55;

      h2 {
        font-size: 16px;
      }

      ul {
        padding: 0;
        list-style: none;
      }

      li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 12px 0;
        border-top: 1px solid #4b4e55;
      }

      p {
        margin: 4px 0;
      }

      button {
        flex: 0 0 auto;
        width: auto;
      }
    }
  }
</style>
