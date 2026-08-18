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
                        <a-radio-button value="FORWARD" :disabled="forwardFrameN === 0">{{
                            editor.lang('trackForward')
                        }}</a-radio-button>
                        <a-radio-button value="BACKWARD" :disabled="backwardFrameN === 0">{{
                            editor.lang('trackBackward')
                        }}</a-radio-button>
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
                <div class="track-tooltip-row" v-if="method === 'model' && !noModelTrack">
                    <label>{{ editor.lang('trackUseZ') }}</label>
                    <a-checkbox v-model:checked="useZ" />
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
                <span class="track-tooltip-button-text">{{ editor.lang('trackTitle') }}</span>
            </a-button>
        </a-tooltip>
    </a-popover>
</template>
<script lang="ts" setup>
    import { computed, ref, watch } from 'vue';
    import { useInjectEditor } from '../../state';
    import { IBottomState } from './useTimeLine';

    const props = defineProps<{
        state: IBottomState;
    }>();

    const editor = useInjectEditor();
    const visible = ref(false);
    const direction = ref<'FORWARD' | 'BACKWARD'>('FORWARD');
    const frameN = ref(1);
    const noModelTrack = computed(() => !!props.state._config.noModelTrack);
    // Model tracking (location.txt-compensated propagation) is the primary workflow, so
    // default to it whenever it's available instead of making the user switch every time.
    const method = ref<'copy' | 'model'>(noModelTrack.value ? 'copy' : 'model');
    const useZ = ref(true);

    const forwardFrameN = computed(() => {
        const { frameIndex, frames } = editor.state;
        return Math.max(0, frames.length - frameIndex - 1);
    });
    const backwardFrameN = computed(() => Math.max(0, editor.state.frameIndex));
    const maxFrameN = computed(() =>
        direction.value === 'FORWARD' ? forwardFrameN.value : backwardFrameN.value,
    );

    watch(visible, (open) => {
        if (!open) return;
        if (direction.value === 'FORWARD' && forwardFrameN.value === 0) {
            direction.value = 'BACKWARD';
        } else if (direction.value === 'BACKWARD' && backwardFrameN.value === 0) {
            direction.value = 'FORWARD';
        }
        frameN.value = Math.max(1, Math.min(frameN.value, maxFrameN.value));
    });

    watch(maxFrameN, (maximum) => {
        if (maximum > 0 && frameN.value > maximum) frameN.value = maximum;
    });

    function onRun() {
        if (maxFrameN.value === 0) {
            editor.showMsg('warning', editor.lang('track-no-data'));
            return;
        }
        const object = editor.pc.selection.length > 0 ? 'select' : 'all';
        editor.dataManager.track({
            method: method.value,
            object,
            direction: direction.value,
            frameN: frameN.value,
            useZ: useZ.value,
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

    .track-tooltip-button-text {
        margin-left: 4px;
        font-size: 12px;
    }
</style>
