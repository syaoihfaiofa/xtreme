<template>
  <section class="insights">
    <div class="summary-grid">
      <div class="summary-card">
        <span class="label">Scenes</span>
        <strong>{{ detail.sceneCount }}</strong>
        <small>{{ detail.totalFrameCount }} frames in total</small>
      </div>
      <div class="summary-card">
        <span class="label">Annotation coverage</span>
        <strong>{{ coverage }}%</strong>
        <small>{{ detail.annotatedFrameCount }} / {{ detail.totalFrameCount }} frames</small>
      </div>
      <div class="summary-card">
        <span class="label">3D positioned objects</span>
        <strong>{{ detail.positionedObjectCount }}</strong>
        <small>3D objects within the displayed distance ranges</small>
      </div>
    </div>

    <div class="detail-grid">
      <div class="panel">
        <div class="panel-title">Object distance distribution</div>
        <div v-if="detail.positionedObjectCount" class="distance-list">
          <div v-for="item in detail.distanceUnits" :key="item.range" class="distance-row">
            <span class="range">{{ item.range }}</span>
            <div class="track"><i :style="{ width: `${percentage(item.objectCount)}%` }" /></div>
            <b>{{ item.objectCount }}</b>
          </div>
        </div>
        <ChartEmpty v-else tip="No 3D position data" class="py-30px" />
      </div>

      <div class="panel">
        <div class="panel-title">Scenes by frame count</div>
        <div v-if="detail.sceneUnits.length" class="scene-list">
          <div v-for="scene in detail.sceneUnits" :key="scene.sceneId" class="scene-row">
            <span :title="scene.name">{{ scene.name }}</span>
            <b>{{ scene.frameCount }} frames</b>
          </div>
        </div>
        <ChartEmpty v-else tip="No scenes" class="py-30px" />
      </div>
    </div>
  </section>
</template>

<script lang="ts" setup>
  import { computed, onMounted, reactive } from 'vue';
  import ChartEmpty from './ChartEmpty.vue';
  import { getOverviewDetailApi } from '/@/api/business/dataset/overview';
  import { IOverviewDetail } from '/@/api/business/dataset/model/overviewModel';

  const props = defineProps<{ datasetId: number }>();
  const detail = reactive<IOverviewDetail>({
    sceneCount: 0,
    annotatedFrameCount: 0,
    totalFrameCount: 0,
    positionedObjectCount: 0,
    distanceUnits: [],
    sceneUnits: [],
  });

  const coverage = computed(() =>
    detail.totalFrameCount ? ((detail.annotatedFrameCount / detail.totalFrameCount) * 100).toFixed(1) : '0.0',
  );
  const percentage = (count: number) =>
    detail.positionedObjectCount ? (count / detail.positionedObjectCount) * 100 : 0;

  onMounted(async () => {
    Object.assign(detail, await getOverviewDetailApi({ datasetId: props.datasetId }));
  });
</script>

<style lang="less" scoped>
  .insights { display: flex; flex-direction: column; gap: 20px; }
  .summary-grid, .detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
  .detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-card, .panel { background: #fff; border-radius: 12px; padding: 20px; }
  .summary-card { display: flex; min-height: 118px; flex-direction: column; gap: 7px; }
  .label, small { color: #888; font-size: 13px; }
  strong { color: #262626; font-size: 28px; font-weight: 600; line-height: 1; }
  .panel { min-height: 210px; }
  .panel-title { color: #333; font-size: 18px; font-weight: 500; margin-bottom: 18px; }
  .distance-list, .scene-list { display: flex; flex-direction: column; gap: 14px; }
  .distance-row { display: grid; grid-template-columns: 65px 1fr 36px; align-items: center; gap: 10px; color: #666; font-size: 13px; }
  .track { height: 8px; overflow: hidden; border-radius: 6px; background: #eef3f8; }
  .track i { display: block; min-width: 2px; height: 100%; border-radius: inherit; background: #60a9fe; }
  .distance-row b, .scene-row b { color: #333; font-weight: 500; text-align: right; }
  .scene-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-bottom: 10px; border-bottom: 1px solid #f0f0f0; color: #555; font-size: 14px; }
  .scene-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 900px) { .summary-grid, .detail-grid { grid-template-columns: 1fr; } }
</style>
