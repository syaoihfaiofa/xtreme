<template>
    <a-popover
        v-model:open="visible"
        trigger="click"
        placement="top"
        overlayClassName="track-tooltip-popover"
    >
        <template #content>
            <div class="track-tooltip-content">
                <div class="track-tooltip-title">{{ editor.lang('trackTitle') }}</div>
                <div class="track-tooltip-row">
                    <label>{{ editor.lang('trackDirection') }}</label>
                    <a-radio-group v-model:value="direction" size="small">
                        <a-radio-button value="FORWARD">{{ editor.lang('trackForward') }}</a-radio-button>
                        <a-radio-button value="BACKWARD">{{ editor.lang('trackBackward') }}</a-radio-button>
                    </a-radio-group>
                </div>
                <div class="track-tooltip-row">
                    <label>{{ editor.lang('trackFrameN') }}</label>
                    <a-input-number v-model:value="frameN" :min="1" :max="maxFrameN" size="small" />
                </div>
                <div class="track-tooltip-row">
                    <label>{{ editor.lang('trackMethod') }}</label>
                    <a-radio-group v-model:value="method" size="small">
                        <a-radio-button value="copy">{{ editor.lang('trackCopy') }}</a-radio-button>
                        <a-radio-button v-if="!noModelTrack" value="model">{{ editor.lang('trackModel') }}</a-radio-button>
                    </a-radio-group>
                </div>
                <a-button size="small" type="primary" block style="margin-top: 8px" @click="onRun">
                    {{ editor.lang('trackRun') }}
                </a-button>
            </div>
        </template>
        <a-tooltip placement="top">
            <template #title>{{ editor.lang('trackTitle') }}</template>
            <a-button>
                <template #icon>
                    <i class="iconfont icon-guiji" />
                </template>
            </a-button>
        </a-tooltip>
    </a-popover>
</template>
<script lang="ts" setup>
    import { computed, ref } from 'vue';
    import { useInjectEditor } from '../../state';
    import { IBottomState } from './useTimeLine';

    const props = defineProps<{
        state: IBottomState;
    }>();

    const editor = useInjectEditor();
    const visible = ref(false);
    const direction = ref<'FORWARD' | 'BACKWARD'>('FORWARD');
    const frameN = ref(1);
    const method = ref<'copy' | 'model'>('copy');

    const noModelTrack = computed(() => !!props.state._config.noModelTrack);

    const maxFrameN = computed(() => {
        const { frameIndex, frames } = editor.state;
        if (direction.value === 'FORWARD') {
            return frames.length - frameIndex - 1;
        }
        return frameIndex;
    });

    function onRun() {
        const object = editor.pc.selection.length > 0 ? 'select' : 'all';
        editor.dataManager.track({
            method: method.value,
            object,
            direction: direction.value,
            frameN: frameN.value,
        });
        visible.value = false;
    }
</script>
<style lang="less">
    .track-tooltip-popover {
        .track-tooltip-row {
            display: flex;
            align-items: center;
            margin-bottom: 8px;
            font-size: 12px;

            > label {
                min-width: 60px;
                margin-right: 8px;
            }
        }
    }
</style>
