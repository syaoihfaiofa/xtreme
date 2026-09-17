<template>
    <div class="merge-model-runs">
        <a-spin :spinning="loading">
            <a-alert
                v-if="errorMessage"
                type="error"
                :message="errorMessage"
                show-icon
            />
            <a-checkbox-group v-model:value="selectedRunIds" class="run-list">
                <a-checkbox
                    v-for="run in runs"
                    :key="run.recordId"
                    :value="run.recordId"
                    class="run-item"
                >
                    <span>{{ run.modelName }}</span>
                    <span class="run-meta">
                        {{ run.frameCount }} 帧 / {{ run.objectCount }} 个对象
                    </span>
                </a-checkbox>
            </a-checkbox-group>
            <a-empty v-if="!loading && runs.length === 0" description="当前场景没有已完成的模型结果" />
            <div class="hint">
                转换成功后会删除当前场景中所选 Run 的原始预测标签，其他场景和 Ground Truth 不受影响。
            </div>
            <div class="mode-row">
                <span>写入方式</span>
                <a-radio-group v-model:value="mode">
                    <a-radio value="APPEND">追加</a-radio>
                    <a-radio value="REPLACE">替换（先备份当前标签）</a-radio>
                </a-radio-group>
            </div>
            <div class="actions">
                <a-button @click="emit('cancel')">取消</a-button>
                <a-button
                    type="primary"
                    :disabled="selectedRunIds.length === 0"
                    @click="emit('ok')"
                >
                    转换为 Ground Truth
                </a-button>
            </div>
        </a-spin>
    </div>
</template>

<script setup lang="ts">
    import { onMounted, ref } from 'vue';

    import {
        CompletedSceneModelRun,
        getCompletedSceneModelRuns,
    } from '../../../api/model';

    interface ModalData {
        sceneId: string;
    }

    interface MergeSelection {
        modelRunRecordIds: number[];
        mode: 'APPEND' | 'REPLACE';
    }

    const props = defineProps<{ data: ModalData }>();
    const emit = defineEmits(['ok', 'cancel']);
    const loading = ref(false);
    const errorMessage = ref('');
    const runs = ref<CompletedSceneModelRun[]>([]);
    const selectedRunIds = ref<number[]>([]);
    const mode = ref<'APPEND' | 'REPLACE'>('APPEND');

    onMounted(async (): Promise<void> => {
        loading.value = true;
        try {
            runs.value = await getCompletedSceneModelRuns(props.data.sceneId);
        } catch (error: unknown) {
            errorMessage.value =
                error instanceof Error ? error.message : '加载模型结果失败';
        } finally {
            loading.value = false;
        }
    });

    async function valid(): Promise<boolean> {
        return !loading.value && selectedRunIds.value.length > 0;
    }

    function getData(): MergeSelection {
        return {
            modelRunRecordIds: [...selectedRunIds.value],
            mode: mode.value,
        };
    }

    defineExpose({ valid, getData });
</script>

<style scoped lang="less">
    .merge-model-runs {
        min-height: 180px;
    }

    .run-list {
        display: flex;
        max-height: 300px;
        flex-direction: column;
        overflow-y: auto;
    }

    .run-item {
        margin: 0;
        padding: 10px 0;
    }

    .run-meta {
        margin-left: 12px;
        color: #8c8c8c;
    }

    .hint {
        margin-top: 12px;
        color: #8c8c8c;
        font-size: 12px;
        line-height: 1.5;
    }

    .mode-row {
        display: flex;
        margin-top: 16px;
        gap: 16px;
    }

    .actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 20px;
        gap: 8px;
    }
</style>
