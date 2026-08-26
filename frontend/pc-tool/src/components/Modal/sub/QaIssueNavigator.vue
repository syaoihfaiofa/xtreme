<template>
    <div class="qa-issue-navigator">
        <div class="qa-issue-navigator__summary">
            共 {{ issues.length }} 个问题
            <span v-if="currentIndex >= 0">，当前第 {{ currentIndex + 1 }} 个</span>
        </div>
        <div class="qa-issue-navigator__filters">
            <a-button
                v-for="group in filterGroups"
                :key="group.id"
                size="small"
                :type="activeFilter === group.id ? 'primary' : 'default'"
                @click="activeFilter = group.id"
            >
                {{ group.label }} ({{ countByFilter(group.id) }})
            </a-button>
        </div>
        <div class="qa-issue-navigator__jump">
            <span>跳转到第</span>
            <a-input-number
                v-model:value="jumpIndex"
                :min="1"
                :max="filteredIndices.length || 1"
                size="small"
                style="width: 72px"
            />
            <span>个（当前筛选）</span>
            <a-button size="small" type="primary" :disabled="filteredIndices.length === 0" @click="onJump">
                跳转
            </a-button>
        </div>
        <div class="qa-issue-navigator__list">
            <div
                v-for="entry in visibleEntries"
                :key="entry.globalIndex"
                class="qa-issue-item"
                :class="{ active: entry.globalIndex === currentIndex }"
                @click="onSelect(entry.globalIndex)"
            >
                <div class="qa-issue-item__head">
                    <span class="qa-issue-item__index">#{{ entry.globalIndex + 1 }}</span>
                    <span class="qa-issue-item__type">{{ entry.typeLabel }}</span>
                    <span class="qa-issue-item__frame">{{ entry.frameName }}</span>
                </div>
                <div class="qa-issue-item__message">{{ entry.message }}</div>
            </div>
            <div v-if="visibleEntries.length === 0" class="qa-issue-navigator__empty">当前筛选下没有问题</div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import { computed, ref } from 'vue';

    import {
        QA_ISSUE_FILTER_GROUPS,
        getQaIssueCodeLabel,
        matchQaIssueFilter,
    } from '../../../common/qaIssue';
    import { useInjectEditor } from '../../../state';

    const emit = defineEmits(['cancel']);
    const editor = useInjectEditor();
    const filterGroups = QA_ISSUE_FILTER_GROUPS;
    const activeFilter = ref('ALL');
    const jumpIndex = ref(1);

    const issues = computed(() => editor.getQaIssues());
    const currentIndex = computed(() => editor.getQaIssueGlobalIndex());

    const filteredIndices = computed(() =>
        issues.value
            .map((issue, globalIndex) => ({ issue, globalIndex }))
            .filter(({ issue }) => matchQaIssueFilter(issue, activeFilter.value))
            .map(({ globalIndex }) => globalIndex),
    );

    const visibleEntries = computed(() =>
        filteredIndices.value.map((globalIndex) => {
            const issue = issues.value[globalIndex];
            return {
                globalIndex,
                frameName: issue.frameName,
                message: issue.message,
                typeLabel: getQaIssueCodeLabel(issue.code),
            };
        }),
    );

    function countByFilter(filterId: string): number {
        return issues.value.filter((issue) => matchQaIssueFilter(issue, filterId)).length;
    }

    async function onSelect(globalIndex: number): Promise<void> {
        await editor.focusQaIssueAt(globalIndex);
        emit('cancel');
    }

    async function onJump(): Promise<void> {
        const listIndex = Number(jumpIndex.value) - 1;
        const globalIndex = filteredIndices.value[listIndex];
        if (globalIndex == null) {
            editor.showMsg('warning', '跳转序号超出范围');
            return;
        }
        await onSelect(globalIndex);
    }
</script>

<style lang="less" scoped>
    .qa-issue-navigator {
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-height: 60vh;
    }

    .qa-issue-navigator__summary {
        color: #bec1ca;
        font-size: 13px;
    }

    .qa-issue-navigator__filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }

    .qa-issue-navigator__jump {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #bec1ca;
        font-size: 13px;
    }

    .qa-issue-navigator__list {
        overflow: auto;
        border: 1px solid #434343;
        border-radius: 6px;
        max-height: 42vh;
    }

    .qa-issue-item {
        padding: 10px 12px;
        border-bottom: 1px solid #34343a;
        cursor: pointer;

        &:hover,
        &.active {
            background: rgba(96, 169, 254, 0.12);
        }

        &__head {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 4px;
            font-size: 12px;
        }

        &__index {
            color: #91caff;
            font-weight: 600;
        }

        &__type {
            color: #ffd666;
        }

        &__frame {
            color: #8c8c8c;
        }

        &__message {
            color: #e8e8e8;
            font-size: 13px;
            line-height: 1.4;
            word-break: break-word;
        }
    }

    .qa-issue-navigator__empty {
        padding: 24px;
        text-align: center;
        color: #8c8c8c;
    }
</style>
