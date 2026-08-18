<template>
    <div class="pc-flow">
        <div class="item-wrap">
            <span :class="blocking ? 'close disable' : 'close'" @click="blocking ? null : onClose()"
                ><CloseOutlined /><span style="margin-left: 4px">{{ $$('btn-close') }}</span></span
            >
            <div class="task-header-info">
                <span :title="iState.dataName || ''" class="task-header-name">{{
                    iState.dataName || ''
                }}</span>
                <i class="iconfont icon-a-Jobinformation task-header-icon"></i>
            </div>
        </div>
        <div class="item-wrap data-index" v-if="!state.isSeriesFrame && state.frames.length > 0">
            <LeftOutlined
                :class="canNavigateFrame(-1) && !blocking ? 'icon' : 'icon disable'"
                @click="canNavigateFrame(-1) && !blocking ? onPre() : null"
            />
            <a-input-number
                :disabled="blocking"
                v-model:value="dataIndex"
                size="small"
                :min="1"
                :step="1"
                @change="onIndexChange"
                @blur="onIndexBlur"
                :max="state.frames.length"
                style="width: 50px; text-align: center; font-size: 18px"
            />
            <span class="text">
                <span style="margin-right: 4px">/</span>{{ state.frames.length }}
            </span>
            <RightOutlined
                :class="
                    canNavigateFrame(1) && !blocking
                        ? 'icon'
                        : 'icon disable'
                "
                @click="canNavigateFrame(1) && !blocking ? onNext() : null"
            />
        </div>
        <div class="review-color-legend">
            <span class="legend-item">
                <i style="background-color: #ff9f00"></i>
                正常
            </span>
            <span class="legend-item">
                <i :style="{ backgroundColor: utils.SYNC_DIRTY_OBJECT_COLOR }"></i>
                未同步
            </span>
            <span class="legend-item">
                <i :style="{ backgroundColor: utils.OCCLUDED_OBJECT_COLOR }"></i>
                遮挡
            </span>
            <span class="legend-item">
                <i :style="{ backgroundColor: utils.REVIEWED_CORRECT_OBJECT_COLOR }"></i>
                审阅正确
            </span>
        </div>
        <div
            v-if="
                bsState.inferenceMode &&
                (bsState.inferenceEnsuring || bsState.inferenceTask || bsState.inferenceRequestError)
            "
            class="inference-status"
            :class="{ failed: !!bsState.inferenceRequestError || bsState.inferenceTask?.status === 'FAILED' }"
            :title="inferenceStatusText"
        >
            {{ inferenceStatusText }}
        </div>
        <div class="item-wrap">
            <!-- Save -->
            <a-button
                v-if="has(BsUIType.reviewMode)"
                class="basic-btn review-mode"
                :type="bsState.reviewMode ? 'primary' : 'default'"
                :disabled="blocking"
                size="large"
                @click="onToggleReviewMode"
            >
                <template #icon><CheckCircleOutlined /></template>
                <div class="title">Review Mode</div>
            </a-button>
            <a-button
                v-if="bsState.reviewMode"
                class="basic-btn review-correct"
                :disabled="blocking"
                size="large"
                @click="onMarkTrackCorrect"
            >
                <template #icon><CheckCircleOutlined /></template>
                <div class="title">Mark Correct (R)</div>
            </a-button>
            <a-button
                class="basic-btn"
                v-if="has(BsUIType.flowSave)"
                :disabled="blocking || inferenceRunning"
                size="large"
                :loading="bsState.saving"
                @click="onSave"
            >
                <template #icon><SaveOutlined /></template>
                <div class="title">{{ $$('btn-save') }}</div>
            </a-button>
            <!-- shortcut -->
            <a-button class="basic-btn" size="large" :disabled="blocking" @click="onHelp">
                <template #icon
                    ><i style="font-size: 16px" class="iconfont icon-help"></i
                ></template>
                <div class="title">{{ $$('btn-shortcut') }}</div>
            </a-button>
            <!-- full screen -->
            <a-button class="basic-btn" size="large" @click="onFullScreen">
                <template #icon>
                    <i
                        style="font-size: 16px"
                        class="iconfont"
                        :class="[iState.fullScreen ? 'icon-tuichuquanping' : 'icon-a-Fullscreen']"
                    ></i
                ></template>
                <div class="title">{{
                    iState.fullScreen ? $$('btn-full-exit') : $$('btn-full')
                }}</div>
            </a-button>
            <a-divider type="vertical" style="height: 32px; background-color: #57575c" />
            <template v-if="editor.state.frameIndex >= 0">
                <a-button
                    class="basic modify"
                    :disabled="blocking"
                    :loading="bsState.modifying"
                    v-show="!canEdit() && editor.state.modeConfig.name !== 'discussion'"
                    @click="onModify"
                >
                    {{ $$('btn-modify') }}
                </a-button>
                <a-button
                    :class="
                        currentFrame.dataStatus === 'VALID'
                            ? 'basic mark-invalid'
                            : 'basic mark-valid'
                    "
                    v-show="canEdit()"
                    :disabled="blocking"
                    :loading="bsState.validing"
                    @click="onToggleValid"
                >
                    {{ currentFrame.dataStatus === 'VALID' ? $$('btn-invalid') : $$('btn-valid') }}
                </a-button>
                <a-button
                    class="basic skip"
                    v-show="canEdit() && !state.isSeriesFrame"
                    @click="onToggleSkip"
                    :disabled="blocking"
                >
                    {{ $$('btn-skip') }}
                </a-button>
                <a-button
                    class="basic submit"
                    v-show="canEdit()"
                    :loading="bsState.submitting"
                    :disabled="blocking || inferenceRunning"
                    @click="onSubmit"
                >
                    <template #icon><SaveOutlined /></template>
                    {{
                        currentFrame.annotationStatus === 'ANNOTATED'
                            ? $$('btn-update')
                            : $$('btn-submit')
                    }}
                </a-button>
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
    // import { PointCloud } from '../lib';
    import { computed, onMounted } from 'vue';
    import {
        RightOutlined,
        LeftOutlined,
        SaveOutlined,
        CloseOutlined,
        CheckCircleOutlined,
    } from '@ant-design/icons-vue';
    import { useInjectEditor } from '../../state';
    import useHeader from './useHeader';
    import useFlow from '../../hook/useFlow';
    import useUI from '../../hook/useUI';
    import * as _ from 'lodash';
    import { BsUIType } from '../../config/ui';
    import { utils } from 'pc-editor';

    let {
        $$,
        onFullScreen,
        iState,
        blocking,
        currentFrame,
        dataIndex,
        onIndexChange,
        onHelp,
        onIndexBlur,
        onSave,
        onPre,
        onNext,
        onClose,
        onToggleValid,
        onToggleSkip,
        onSubmit,
        onModify,
        onToggleReviewMode,
        onMarkTrackCorrect,
    } = useHeader();
    let { has, canEdit } = useUI();
    let { init } = useFlow();
    let editor = useInjectEditor();
    let { state, bsState } = editor;
    const inferenceRunning = computed(() => editor.dataManager.isInferenceRunning());
    const inferenceStatusText = computed(() => {
        if (bsState.inferenceRequestError) return bsState.inferenceRequestError;
        if (bsState.inferenceEnsuring) return 'Starting dataset inference';
        const task = bsState.inferenceTask;
        if (!task) return '';
        if (task.status === 'FAILED') {
            return `Dataset inference failed: ${task.errorMessage || 'No error message was returned'}`;
        }
        if (task.status === 'SUCCESS') return 'Dataset inference completed';
        const progress = Number.isFinite(task.progress) ? Math.round(task.progress) : 0;
        return `Dataset inference ${task.status.toLowerCase()}: ${task.completedFrames}/${task.totalFrames} (${progress}%)`;
    });

    onMounted(() => {
        init();
    });
</script>

<style lang="less">
    .pc-flow {
        height: 100%;
        display: flex;
        position: relative;
        justify-content: space-between;

        .review-color-legend {
            position: absolute;
            top: 16px;
            left: 42%;
            z-index: 1;
            display: flex;
            gap: 8px;
            color: #cdd3da;
            font-size: 12px;
            line-height: 16px;
            transform: translateX(-50%);

            .legend-item {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                white-space: nowrap;

                i {
                    display: inline-block;
                    width: 12px;
                    height: 8px;
                    border-radius: 2px;
                }
            }
        }

        .inference-status {
            position: absolute;
            top: 4px;
            left: 50%;
            z-index: 2;
            max-width: 420px;
            transform: translateX(-50%);
            overflow: hidden;
            color: #91caff;
            font-size: 12px;
            line-height: 20px;
            text-overflow: ellipsis;
            white-space: nowrap;

            &.failed {
                color: #ff7875;
            }
        }

        .task-header-info {
            border-radius: 16px;
            height: 28px;
            padding: 2px 15px;
            background: rgba(58, 58, 62, 0.39);
            border: 1px solid rgba(58, 58, 62, 0.39);
            display: flex;
            align-items: center;
            margin-left: 12px;

            .task-header-name {
                font-size: 14px;
                line-height: 18px;
                color: #bec1ca;
                padding-right: 12px;
                border-right: 1px solid #57575c;
                max-width: 120px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .task-header-icon {
                margin-left: 10px;
                cursor: pointer;
            }
        }
        .item-wrap {
            // min-width: 100px;
            display: flex;
            align-items: center;
            .basic-btn {
                padding: 0 8px;
                border: none;
                .anticon {
                    font-size: 16px;
                }
                .title {
                    font-size: 14px;
                    margin-top: -4px;
                }
                &.ant-btn:hover,
                &.ant-btn:focus {
                    color: white;
                    border-color: #434343;
                }
            }
            .header-info {
                background-color: #3a393e;
                border-radius: 16px;
                margin-left: 20px;
                padding: 5px 15px;
                color: #bec1ca;
                display: flex;
            }

            .icon {
                font-size: 20px;
                margin: 0px 4px;
                cursor: pointer;
            }

            .icon.disable {
                cursor: not-allowed;
                color: #5a5a5a;
            }

            .text {
                font-size: 18px;
                margin-left: 4px;
            }
        }

        .close {
            font-size: 20px;
            margin-left: 10px;
            cursor: pointer;

            &.disable {
                cursor: not-allowed;
                color: #5a5a5a;
            }
        }

        .data-index {
            .ant-input-number-handler-wrap {
                display: none;
            }
            .ant-input-number-sm input {
                text-align: center;
            }
        }

        .basic {
            // font-size: 18px;
            margin-right: 10px;
            // cursor: pointer;
            // padding: 4px;
            border-radius: 30px;
            // background: #3a393e;

            &.mark-invalid {
                background-color: #fcb17a;
            }
            &.mark-valid {
                background-color: #49aa19;
            }
            &.skip {
                background-color: #98b0d2;
            }
            &.skipped,
            &.modify {
                background-color: #ff6906;
            }
            &.submit {
                background-color: #60a9fe99;
                padding-left: 15px !important;
                .anticon {
                    background: #60a9fe;
                    height: 30px;
                    margin-top: -4px;
                    width: 32px;
                    margin-left: -16px;
                    border-radius: 16px;
                    padding-top: 5px;
                }
            }
            .anticon {
                font-size: 20px;
                vertical-align: middle;
            }

            &.ant-btn:hover,
            &.ant-btn:focus {
                color: white;
                border-color: #434343;
            }

            // &:hover {
            //     background: #3a393e;
            // }
        }

        .dataset-name {
            display: inline-block;
            max-width: 100px;
        }
    }
</style>
