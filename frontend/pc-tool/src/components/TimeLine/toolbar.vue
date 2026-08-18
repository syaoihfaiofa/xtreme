<template>
    <div class="i-toolbar-container">
        <div class="bar-left">
            <span style="display: inline-block; padding-right: 10px; min-width: 60px">{{
                editor.lang('autoLoad')
            }}</span>
            <a-tooltip placement="top">
                <template #title>{{ editor.lang('autoLoad') }}</template>
                <span @keydown.capture="(e) => e.stopPropagation()">
                    <a-switch
                        ref="autoLoadSwitch"
                        :checked="config.autoLoad"
                        @change="onAutoLoadHandle"
                        style="margin-right: 10px"
                    />
                </span>
            </a-tooltip>
            <a-popover
                v-model:open="autoLoadSettingsOpen"
                trigger="click"
                placement="topLeft"
                overlayClassName="autoload-settings-popover"
            >
                <template #content>
                    <div class="autoload-settings-content">
                        <div class="autoload-settings-title">
                            {{ editor.lang('autoLoadSettings') }}
                        </div>
                        <div class="autoload-settings-total">
                            {{ editor.lang('autoLoadTotalFrames', { n: total }) }}
                        </div>
                        <div class="autoload-settings-row">
                            <label>{{ editor.lang('autoLoadStartFrame') }}</label>
                            <a-input-number
                                v-model:value="autoLoadStartFrame"
                                :min="1"
                                :max="total"
                                :precision="0"
                                size="small"
                            />
                        </div>
                        <div class="autoload-settings-row">
                            <label>{{ editor.lang('autoLoadEndFrame') }}</label>
                            <a-input-number
                                v-model:value="autoLoadEndFrame"
                                :min="1"
                                :max="total"
                                :precision="0"
                                size="small"
                            />
                        </div>
                        <div class="autoload-settings-row">
                            <label>{{ editor.lang('autoLoadMaxFrames') }}</label>
                            <a-input-number
                                v-model:value="autoLoadMaxFrames"
                                :min="1"
                                :max="total"
                                :precision="0"
                                size="small"
                            />
                        </div>
                        <a-button type="primary" size="small" block @click="applyAutoLoadSettings">
                            {{ editor.lang('autoLoadApply') }}
                        </a-button>
                    </div>
                </template>
                <a-tooltip placement="top">
                    <template #title>{{ editor.lang('autoLoadSettings') }}</template>
                    <a-button class="autoload-settings-button" size="small">
                        <template #icon><SettingOutlined /></template>
                    </a-button>
                </a-tooltip>
            </a-popover>
            <span class="track-frame-filter-label">{{ editor.lang('selectedTrackFrames') }}</span>
            <a-tooltip placement="top">
                <template #title>
                    {{
                        editor.currentTrack
                            ? editor.lang('selectedTrackFramesTip')
                            : editor.lang('selectedTrackFramesNoTarget')
                    }}
                </template>
                <span @keydown.capture="(e) => e.stopPropagation()">
                    <a-switch
                        :checked="config.filterFramesByTrack"
                        @change="onTrackFrameFilterChange"
                        style="margin-right: 10px"
                    />
                </span>
            </a-tooltip>
            <div v-show="disable" class="over-not-allowed"></div>
        </div>
        <div class="bar-center">
            <div style="width: 100%; text-align: center">
                <a-tooltip v-if="canEdit()" placement="top">
                    <template #title>{{ editor.lang('copyLeft1') }}</template>
                    <a-button
                        :disabled="disable"
                        @click="() => onAction('CopyBackward')"
                        style="width: 40px"
                    >
                        <template #icon>
                            <div>
                                <StepBackwardOutlined />
                                <CopyOutlined
                                    style="
                                        margin-left: -4px;
                                        font-size: 14px;
                                        transform: rotateY(180deg);
                                    "
                                />
                            </div>
                        </template>
                    </a-button>
                </a-tooltip>

                <a-tooltip placement="top">
                    <template #title>{{
                        editor.lang('speedDown', {
                            n: state.playSpeed,
                        })
                    }}</template>
                    <a-button
                        :disabled="!canOperate()"
                        v-show="!isCheck()"
                        @click="onChangeSpeed(-1)"
                    >
                        <template #icon>
                            <i class="iconfont icon-zuo-fuzhi" />
                        </template>
                    </a-button>
                </a-tooltip>

                <a-tooltip placement="top">
                    <template #title>{{ editor.lang('replay') }}</template>
                    <a-button
                        :disabled="!canOperate()"
                        v-show="!isCheck()"
                        @click="() => onAction('Replay')"
                    >
                        <template #icon>
                            <i class="iconfont icon-chongxinbofang" />
                        </template>
                    </a-button>
                </a-tooltip>

                <a-tooltip placement="top">
                    <template #title>{{ editor.lang('pre') }}</template>
                    <a-button
                        :disabled="isPreDisabled"
                        @click="() => onAction('PreFrame')"
                        type="default"
                    >
                        <template #icon>
                            <i class="iconfont icon-shouqi" />
                        </template>
                    </a-button>
                </a-tooltip>
                <!-- @change="changeFrameIndex" -->
                <a-input-number
                    style="width: 80px"
                    :disabled="disable"
                    v-model:value="iState.frameIndex"
                    :precision="0"
                    @blur="() => changeFrameIndex('Input')"
                    @pressEnter="() => changeFrameIndex('Input')"
                    :min="1"
                    :max="total"
                    size="small"
                />
                <span class="i-span">/ {{ total }}</span>

                <a-tooltip placement="top">
                    <template #title>{{ editor.lang('next') }}</template>
                    <a-button
                        :disabled="isNextDisabled"
                        @click="() => onAction('NextFrame')"
                        type="default"
                    >
                        <template #icon>
                            <i class="iconfont icon-zhankai1" />
                        </template>
                    </a-button>
                </a-tooltip>

                <a-tooltip placement="top">
                    <template #title>{{
                        state.play
                            ? editor.lang('pause')
                            : editor.lang('play', { n: state.playSpeed })
                    }}</template>
                    <a-button
                        v-show="!isCheck()"
                        :disabled="!canOperate()"
                        @click="() => onAction(state.play ? 'Stop' : 'Play')"
                        type="default"
                    >
                        <template #icon>
                            <i class="iconfont icon-guaqi" v-if="state.play" />
                            <i class="iconfont icon-bofang" v-else />
                        </template>
                    </a-button>
                </a-tooltip>

                <a-tooltip placement="top">
                    <template #title>{{ editor.lang('speedUp', { n: state.playSpeed }) }}</template>
                    <a-button
                        :disabled="!canOperate()"
                        v-show="!isCheck()"
                        @click="onChangeSpeed(1)"
                    >
                        <template #icon>
                            <i class="iconfont icon-right-fuzhi" />
                        </template>
                    </a-button>
                </a-tooltip>

                <a-tooltip v-if="canEdit()" placement="top">
                    <template #title>{{ editor.lang('copyRight1') }}</template>
                    <a-button
                        :disabled="disable"
                        @click="() => onAction('CopyForward')"
                        style="width: 40px"
                    >
                        <template #icon>
                            <div>
                                <CopyOutlined style="margin-right: -4px; font-size: 14px" />
                                <StepForwardOutlined />
                            </div>
                        </template>
                    </a-button>
                </a-tooltip>
            </div>
        </div>
        <div class="bar-right" v-show="!isCheck()" v-if="canEdit()">
            <toolTipTrack :state="state" />
            <div class="divide-line"></div>
            <toolTipMerge :state="state" @action="onTrackAction" />
            <toolTipSplit :state="state" @action="onTrackAction" />
            <a-tooltip placement="top">
                <template #title>{{ editor.lang('delete') }}</template>
                <a-button @click="() => onTrackAction('Delete')">
                    <template #icon>
                        <i class="iconfont icon-shanchuicon" />
                    </template>
                </a-button>
            </a-tooltip>
            <div v-show="disable" class="over-not-allowed"></div>
        </div>
    </div>
</template>
<script lang="ts" setup>
    import * as _ from 'lodash';
    import { ref, computed, watch, reactive } from 'vue';
    import { Event } from 'pc-editor';

    import useUI from '../../hook/useUI';
    import { ITrackAction, IBottomState } from './useTimeLine';

    import {
        StepForwardOutlined,
        StepBackwardOutlined,
        CopyOutlined,
        SettingOutlined,
    } from '@ant-design/icons-vue';
    import { useInjectEditor } from '../../state';
    import toolTipTrack from './toolTipTrack.vue';
    import toolTipMerge from './toolTipMerge.vue';
    import toolTipSplit from './toolTipSplit.vue';
    const props = defineProps<{
        state: IBottomState;
    }>();
    const { canEdit, isCheck, canOperate } = useUI();
    const editor = useInjectEditor();
    const config = editor.state.config;
    const iState = reactive({
        // autoLoad: false,
        frameIndex: editor.state.frameIndex + 1,
    });
    const autoLoadSettingsOpen = ref(false);
    const autoLoadStartFrame = ref(1);
    const autoLoadEndFrame = ref(Math.max(1, editor.state.frames.length));
    const autoLoadMaxFrames = ref(80);
    const autoLoadSwitch = ref<HTMLElement>();
    const emit = defineEmits(['onTrackAction', 'updateTrackLine']);

    watch(
        () => editor.state.frameIndex,
        () => {
            if (iState.frameIndex !== editor.state.frameIndex + 1)
                iState.frameIndex = editor.state.frameIndex + 1;
        },
        { immediate: true },
    );

    const isPreDisabled = computed(() => {
        void props.state.trackTargetLine.trackId;
        return !editor.canNavigateFrame(-1) || disable.value;
    });
    const isNextDisabled = computed(() => {
        void props.state.trackTargetLine.trackId;
        return !editor.canNavigateFrame(1) || disable.value;
    });
    const total = computed(() => {
        return editor.state.frames.length;
    });
    watch(autoLoadSettingsOpen, (open) => {
        if (!open) return;
        const frameTotal = Math.max(1, editor.state.frames.length);
        autoLoadStartFrame.value = Math.max(
            1,
            Math.min(frameTotal, config.autoLoadStartFrame || 1),
        );
        autoLoadEndFrame.value = Math.max(
            autoLoadStartFrame.value,
            Math.min(frameTotal, config.autoLoadEndFrame || frameTotal),
        );
        autoLoadMaxFrames.value = Math.max(
            1,
            Math.min(frameTotal, config.autoLoadMaxFrames || 80),
        );
    });

    type IBarAction =
        | 'CopyForward'
        | 'CopyBackward'
        | 'AutoLoad'
        | 'Replay'
        | 'PreFrame'
        | 'NextFrame'
        | 'Play'
        | 'Stop'
        | 'Check';

    function onChangeSpeed(dir: 1 | -1) {
        const state = props.state;
        const scale = dir === 1 ? 2 : 0.5;
        state.playSpeed *= scale;
        state.playSpeed = Math.max(0.5, Math.min(4, state.playSpeed));
        editor.playManager.interval = Math.round(300 / state.playSpeed);
    }
    function onTrackAction(action: ITrackAction) {
        emit('onTrackAction', action);
    }
    function onAutoLoadHandle() {
        autoLoadSwitch.value?.blur();
        onAction('AutoLoad');
    }
    function applyAutoLoadSettings() {
        const frameTotal = Math.max(1, editor.state.frames.length);
        const start = Math.max(1, Math.min(frameTotal, Math.round(autoLoadStartFrame.value || 1)));
        const end = Math.max(
            start,
            Math.min(frameTotal, Math.round(autoLoadEndFrame.value || frameTotal)),
        );
        autoLoadStartFrame.value = start;
        autoLoadEndFrame.value = end;
        const maxFrames = Math.max(
            1,
            Math.min(end - start + 1, Math.round(autoLoadMaxFrames.value || 80)),
        );
        autoLoadMaxFrames.value = maxFrames;
        config.autoLoadStartFrame = start;
        config.autoLoadEndFrame = end;
        config.autoLoadMaxFrames = maxFrames;
        editor.dataResource.applyAutoLoadConfig();
        autoLoadSettingsOpen.value = false;
        editor.showMsg('success', editor.lang('autoLoadSettingsApplied'));
    }
    function onTrackFrameFilterChange(checked: boolean) {
        config.filterFramesByTrack = checked;
        editor.dispatchEvent({
            type: Event.CURRENT_TRACK_CHANGE,
            data: editor.currentTrack,
        });
        if (config.autoLoad) {
            editor.dataResource.load();
        }
        if (checked && !editor.currentTrack) {
            editor.showMsg('warning', editor.lang('selectedTrackFramesNoTarget'));
        }
    }
    function onAction(action: IBarAction) {
        switch (action) {
            case 'AutoLoad':
                editor.dataResource.setLoadMode(config.autoLoad ? 'near_2' : 'all');
                editor.dataResource.load();
                break;
            case 'CopyForward':
                editor.dataManager.copyForward();
                break;

            case 'CopyBackward':
                editor.dataManager.copyBackWard();
                break;
            case 'Replay':
                rePlay();
                break;
            case 'PreFrame':
                editor.navigateFrame(-1);
                break;
            case 'NextFrame':
                editor.navigateFrame(1);
                break;
            case 'Play':
                play();
                break;
            case 'Stop':
                editor.playManager.stop();
                break;
            case 'Check':
                onCheck();
                break;
        }
    }

    function onCheck() {
        // editor.actionManager.execute('toggleShowCheckView');
    }

    async function rePlay() {
        if (editor.playManager.playing) {
            editor.playManager.stop();
        }
        await editor.loadFrameForNavigation(props.state.playStart, false);
        play();
    }

    function play() {
        const { frames, frameIndex } = editor.state;
        const pState = props.state;
        const nextIndex = editor.getAdjacentFrameIndex(1);
        const nextData = frames[nextIndex];
        if (!nextData || nextData.loadState !== 'complete') {
            editor.showMsg('warning', editor.lang('noPlayData'));
            return;
        }

        pState.play = true;
        pState.playStart = frameIndex;
        editor.playManager.play();
    }

    const changeFrameIndex = _.debounce((method: 'Input' | 'Next' | 'Previous') => {
        const beforeIndex = editor.state.frameIndex;
        if (!iState.frameIndex) iState.frameIndex = 1;
        editor.loadFrameForNavigation(iState.frameIndex - 1).then((loaded) => {
            if (!loaded) iState.frameIndex = editor.state.frameIndex + 1;
        });
        // editor.reportManager.reportChangeFrame(method, beforeIndex + 1);
        // frameIndexChange(iState.frameIndex);
    }, 300);

    const disable = computed(() => {
        return !canOperate() || props.state.play;
    });
</script>
<style lang="less">
    .i-toolbar-container {
        display: flex;
        position: relative;
        align-items: center;
        overflow-x: auto;
        overflow-y: hidden;
        height: 32px;
        background-color: #1e1f22;
        white-space: nowrap;
        flex-direction: row;

        .iconfont {
            font-size: 14px;
        }

        .bar-left {
            display: flex;
            position: relative;
            align-items: center;
            height: 100%;
        }

        .track-frame-filter-label {
            display: inline-block;
            padding-right: 8px;
        }

        .autoload-settings-button {
            margin-right: 10px;
            padding: 0 6px;
        }

        .bar-right {
            display: flex;
            position: relative;
            align-items: center;
            height: 100%;
        }

        .bar-center {
            display: flex;
            position: relative;
            align-items: center;
            height: 100%;
            flex: 1;
        }

        &::-webkit-scrollbar {
            // display: none;
            position: absolute;
            height: 2px;
        }

        .i-margin-right {
            margin-right: 1px;
        }

        .ant-input-number-handler-wrap {
            display: none;
        }

        .ant-input-number {
            margin-left: 2px;
        }

        .ant-input-number-input {
            background-color: white;
            text-align: center;
            color: black;
        }

        .empty-space {
            display: inline-block;
            width: 80px;
            height: 20px;
        }

        .divide-line {
            display: inline-block;
            margin: 0 10px;
            width: 1px;
            height: 20px;
            border-left: 1px solid white;
        }

        .ant-btn {
            border: none;
        }

        .i-span {
            display: inline-block;
            user-select: none;
            margin: 0 4px;
        }

        .item {
            display: inline-block;
            margin-left: 10px;
            cursor: pointer;

            &.icon {
                margin-right: 5px;
                margin-left: 8px;
            }
        }
    }

    .autoload-settings-popover {
        .autoload-settings-content {
            width: 220px;
        }

        .autoload-settings-title {
            margin-bottom: 2px;
            font-weight: 600;
        }

        .autoload-settings-total {
            margin-bottom: 10px;
            color: #8c8c8c;
            font-size: 12px;
        }

        .autoload-settings-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;

            > label {
                margin-right: 8px;
                font-size: 12px;
            }

            .ant-input-number {
                width: 92px;
            }
        }
    }

    .frame-setting {
        width: 220px;

        .wrap {
            margin-top: 10px;
            padding-right: 4px;
            padding-left: 6px;
        }

        .title {
            font-size: 14px;
            text-align: center;
            line-height: 32px;
        }

        .title1 {
            font-size: 12px;
            text-align: left;
            // padding-bottom: 8px;
            line-height: 32px;
        }

        .title2 {
            display: flex;
            font-size: 12px;
            color: white;
            line-height: 32px;

            .ant-input-number-input {
                text-align: center;
            }

            > label {
                display: inline-block;
                padding: 0 8px 0 0;
                min-width: 70px;
                text-align: left;
                line-height: 32px;
            }
        }
    }
</style>
