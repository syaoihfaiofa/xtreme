<template>
    <a-popover
        v-model:open="visible"
        trigger="click"
        placement="top"
        overlayClassName="track-tooltip-popover"
    >
        <template #content>
            <div class="track-tooltip-content" v-if="isPreview">
                <div class="track-tooltip-title">{{ editor.lang('splitConfirm') }}</div>
                <a-button size="small" type="primary" @click="onConfirm">{{ editor.lang('btnConfirm') }}</a-button>
                <a-button size="small" style="margin-left: 8px" @click="onCancel">{{ editor.lang('btnCancelText') }}</a-button>
            </div>
            <div class="track-tooltip-content" v-else>
                <div class="track-tooltip-title">{{ editor.lang('splitTitle') }}</div>
                <a-select
                    v-model:value="splitClassId"
                    style="width: 200px"
                    :placeholder="editor.lang('splitNewClass')"
                    size="small"
                >
                    <a-select-option v-for="item in classTypes" :key="item.id" :value="item.id">
                        {{ item.name }}
                    </a-select-option>
                </a-select>
                <div style="margin-top: 8px">
                    <a-button size="small" :disabled="!splitClassId" @click="onStartSplit">
                        {{ editor.lang('splitBtnTitle') }}
                    </a-button>
                </div>
            </div>
        </template>
        <a-tooltip placement="top">
            <template #title>{{ editor.lang('splitTitle') }}</template>
            <a-button>
                <template #icon>
                    <i class="iconfont icon-chaifen" />
                </template>
            </a-button>
        </a-tooltip>
    </a-popover>
</template>
<script lang="ts" setup>
    import { computed, ref } from 'vue';
    import { useInjectEditor } from '../../state';
    import { IBottomState, ITrackAction } from './useTimeLine';

    const props = defineProps<{
        state: IBottomState;
    }>();
    const emit = defineEmits<{ (e: 'action', action: ITrackAction): void }>();

    const editor = useInjectEditor();
    const visible = ref(false);
    const splitClassId = ref('');

    const isPreview = computed(() => {
        return ['PreSplit', 'Split'].indexOf(props.state.trackAction) >= 0;
    });

    const classTypes = computed(() => editor.state.classTypes);

    function onStartSplit() {
        const trackId = props.state.trackTargetLine.trackId;
        if (!trackId) {
            editor.showMsg('warning', editor.lang('selectObject'));
            return;
        }
        const selection = editor.pc.selection[0];
        if (selection && !splitClassId.value) {
            splitClassId.value = selection.userData.classId;
        }
        props.state.trackSplitClass = splitClassId.value;
        props.state.trackSplitTrackId = '';
        emit('action', 'PreSplit');
    }

    function onConfirm() {
        emit('action', 'Split');
        visible.value = false;
    }

    function onCancel() {
        emit('action', 'Cancel');
        visible.value = false;
    }
</script>
