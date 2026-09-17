<template>
  <div class="label-source-manager">
    <div class="font-bold mb-2">标签管理</div>
    <div v-if="datasetId === null" class="empty">选中一个数据集以管理标签来源</div>
    <Spin v-else :spinning="loading">
      <template v-if="sources">
        <div class="section">
          <div class="section-title">当前 Ground Truth</div>
          <div>{{ sources.current.objectCount }} 个对象</div>
        </div>
        <div class="section">
          <div class="section-title">标签备份</div>
          <div v-if="sources.snapshots.length === 0" class="empty">暂无备份</div>
          <div v-for="snapshot in sources.snapshots" :key="snapshot.id" class="source-row">
            <div>
              <div>{{ snapshot.name }}</div>
              <div class="meta">场景 {{ snapshot.sceneId }} · {{ snapshot.objectCount }} 个对象</div>
            </div>
            <div class="actions">
              <Button size="small" @click="restore(snapshot.id)">恢复</Button>
              <Button size="small" danger @click="remove(snapshot.id)">删除</Button>
            </div>
          </div>
        </div>
        <div class="section">
          <div class="section-title">Model Runs</div>
          <div v-if="sources.modelRuns.length === 0" class="empty">暂无模型结果</div>
          <div v-for="run in sources.modelRuns" :key="run.recordId" class="source-row">
            <div>
              <div>{{ run.modelName }}</div>
              <div class="meta">{{ run.status }} · {{ run.objectCount }} 个对象</div>
            </div>
          </div>
        </div>
      </template>
    </Spin>
  </div>
</template>

<script lang="ts" setup>
  import { ref, watch } from 'vue';
  import { Button, message, Modal, Spin } from 'ant-design-vue';

  import {
    DatasetLabelSources,
    deleteDatasetLabelSnapshot,
    getDatasetLabelSources,
    restoreDatasetLabelSnapshot,
  } from '/@/api/business/dataset';

  const props = defineProps<{ datasetId: number | null }>();
  const loading = ref(false);
  const sources = ref<DatasetLabelSources | null>(null);

  watch(
    () => props.datasetId,
    async () => {
      await load();
    },
    { immediate: true },
  );

  async function load(): Promise<void> {
    if (props.datasetId === null) {
      sources.value = null;
      return;
    }
    loading.value = true;
    try {
      sources.value = await getDatasetLabelSources(props.datasetId);
    } catch (error: unknown) {
      message.error(error instanceof Error ? error.message : '加载标签来源失败');
    } finally {
      loading.value = false;
    }
  }

  function restore(snapshotId: number): void {
    if (props.datasetId === null) return;
    const datasetId = props.datasetId;
    Modal.confirm({
      title: '恢复标签备份',
      content: '当前场景 Ground Truth 会先备份，再由所选备份覆盖。',
      async onOk(): Promise<void> {
        await restoreDatasetLabelSnapshot(datasetId, snapshotId);
        message.success('标签备份已恢复');
        await load();
      },
    });
  }

  function remove(snapshotId: number): void {
    if (props.datasetId === null) return;
    const datasetId = props.datasetId;
    Modal.confirm({
      title: '删除标签备份',
      content: '只删除该备份，不影响当前 Ground Truth 和 Model Run。',
      async onOk(): Promise<void> {
        await deleteDatasetLabelSnapshot(datasetId, snapshotId);
        message.success('标签备份已删除');
        await load();
      },
    });
  }
</script>

<style lang="less" scoped>
  .label-source-manager {
    margin-top: 20px;
  }

  .section {
    padding: 10px 0;
    border-top: 1px solid #eee;
  }

  .section-title {
    margin-bottom: 8px;
    font-weight: 600;
  }

  .source-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
    gap: 8px;
  }

  .actions {
    display: flex;
    gap: 4px;
  }

  .meta,
  .empty {
    color: #999;
    font-size: 12px;
  }
</style>
