<template>
    <a-popover
        v-model:open="visible"
        trigger="click"
        placement="top"
        overlayClassName="track-tooltip-popover"
    >
        <template #content>
            <div class="track-tooltip-content" v-if="isPreview">
                <div class="track-tooltip-title">{{ editor.lang('mergeConfirm') }}</div>
                <a-button size="small" type="primary" @click="onConfirm">{{ editor.lang('btnConfirm') }}</a-button>
                <a-button size="small" style="margin-left: 8px" @click="onCancel">{{ editor.lang('btnCancelText') }}</a-button>
            </div>
            <div class="track-tooltip-content" v-else>
                <div class="track-tooltip-title">{{ editor.lang('mergeTo') }} / {{ editor.lang('mergeFrom') }}</div>
                <a-select
                    v-model:value="selectedTrackId"
                    style="width: 200px"
                    :placeholder="editor.lang('selectTrack')"
                    size="small"
                >
                    <a-select-option
                        v-for="item in trackOptions"
                        :key="item.trackId"
                        :value="item.trackId"
                    >
                        {{ item.label }}
                    </a-select-option>
                </a-select>
                <div style="margin-top: 8px">
                    <a-button size="small" :disabled="!selectedTrackId" @click="() => startMerge('MergeTo')">
                        {{ editor.lang('mergeTo') }}
                    </a-button>
                    <a-button
                        size="small"
                        style="margin-left: 8px"
                        :disabled="!selectedTrackId"
                        @click="() => startMerge('MergeFrom')"
                    >
                        {{ editor.lang('mergeFrom') }}
                    </a-button>
                </div>
            </div>
        </template>
        <a-tooltip placement="top">
            <template #title>{{ editor.lang('mergeTitle') }}</template>
            <a-button>
                <template #icon>
                    <i class="iconfont icon-hebing" />
                </template>
            </a-button>
        </a-tooltip>
    </a-popover>
</template>
<script lang="ts" setup>
    import { computed, ref, watch } from 'vue';
    import { useInjectEditor } from '../../state';
    import { IBottomState, ITrackAction } from './useTimeLine';

    const props = defineProps<{
        state: IBottomState;
    }>();
    const emit = defineEmits<{ (e: 'action', action: ITrackAction): void }>();

    const editor = useInjectEditor();
    const visible = ref(false);
    const selectedTrackId = ref('');

    const isPreview = computed(() => {
        return ['PreMergeTo', 'PreMergeFrom'].indexOf(props.state.trackAction) >= 0;
    });

    const trackOptions = computed(() => {
        const currentId = props.state.trackTargetLine.trackId;
        const options: { trackId: string; label: string }[] = [];
        editor.trackManager.trackMap.forEach((track, trackId) => {
            if (trackId === currentId) return;
            const name = track.trackName || '';
            options.push({ trackId, label: `${name}(${trackId})` });
        });
        return options;
    });

    watch(
        () => props.state.trackAction,
        (action) => {
            if (['PreMergeTo', 'PreMergeFrom', 'MergeTo', 'MergeFrom'].indexOf(action) < 0) {
                selectedTrackId.value = '';
            }
        },
    );

    function startMerge(action: 'MergeTo' | 'MergeFrom') {
        const track = editor.trackManager.trackMap.get(selectedTrackId.value);
        if (!track) return;
        Object.assign(props.state.trackMergeResult, {
            trackId: selectedTrackId.value,
            trackName: track.trackName || '',
        });
        emit('action', action === 'MergeTo' ? 'PreMergeTo' : 'PreMergeFrom');
    }

    function onConfirm() {
        if (props.state.trackAction === 'PreMergeTo') {
            emit('action', 'MergeTo');
        } else if (props.state.trackAction === 'PreMergeFrom') {
            emit('action', 'MergeFrom');
        }
        visible.value = false;
    }

    function onCancel() {
        emit('action', 'Cancel');
        visible.value = false;
    }
</script>
<style lang="less">
    .track-tooltip-popover {
        .track-tooltip-content {
            min-width: 220px;
        }

        .track-tooltip-title {
            margin-bottom: 8px;
            font-size: 12px;
        }
    }
</style>
