<template>
    <!-- <div class="edit-class-common"> -->
    <div class="edit-class-common" v-show="state.objectId">
        <div class="view-class-wrap" ref="container">
            <a-collapse v-model:activeKey="state.activeTab">
                <a-collapse-panel key="cuboid">
                    <template #header="{ isActive }">
                        <span class="item-header">
                            <span class="title1">{{ 'Cuboid' + ' ' + state.trackName }}</span>
                            <span class="title2" v-if="state.trackId">{{ state.trackId }}</span>
                            <template v-if="!state.isBatch && !state.isInvisible">
                                <EyeInvisibleOutlined
                                    @click.stop="onToggleTrackVisible"
                                    v-if="!state.trackVisible"
                                    class="title-icon"
                                />
                                <EyeOutlined
                                    @click.stop="onToggleTrackVisible"
                                    v-else
                                    class="title-icon"
                                />
                            </template>
                        </span>
                    </template>
                    <div v-show="state.modelClass">
                        <div class="sub-header">{{ $$('predict-class') }}</div>
                        <div>
                            <span class="item limit active"
                                ><FileMarkdownOutlined />{{ state.modelClass }}
                            </span>
                        </div>
                    </div>
                    <div v-if="state.sourceType === 'INFERENCE'" class="inference-source">
                        {{ $$('inference-source') }}
                    </div>
                    <div v-if="!state.isBatch" class="sync-distance-row">
                        <span class="sync-distance-label">{{ $$('sensor-distance') }}</span>
                        <span>{{ state.sensorDistance.toFixed(2) }} m</span>
                    </div>
                    <div class="sync-distance-row">
                        <span class="sync-distance-label">{{ $$('group-id') }}</span>
                        <a-input
                            v-model:value="state.groupId"
                            allow-clear
                            placeholder="group id"
                            @change="onGroupIdChange"
                        />
                    </div>
                    <a-checkbox
                        v-model:checked="state.occluded"
                        style="margin: 8px 0"
                        @change="onOccludedChange"
                    >
                        {{ $$('occluded') }}
                    </a-checkbox>
                    <a-checkbox
                        v-if="editor.bsState.reviewMode"
                        v-model:checked="state.reviewedCorrect"
                        style="margin: 8px 0"
                        @change="onReviewedCorrectChange"
                    >
                        Review Correct (Track)
                    </a-checkbox>
                    <ObjectClass @change="onClassChange" :state="state" />
                </a-collapse-panel>

                <a-collapse-panel v-show="editor.bsState.syncMode" key="motion">
                    <template #header="{ isActive }">
                        <span class="item-header">
                            <span class="title1">{{ $$('motion-mode') }}</span>
                        </span>
                    </template>
                    <a-select
                        v-model:value="state.motionMode"
                        :options="motionModeOptions"
                        style="width: 100%"
                        @change="onMotionModeChange"
                    />
                    <div v-if="isDynamicMotionMode" class="sync-distance-row">
                        <span class="sync-distance-label">{{ $$('dynamic-range-sync') }}</span>
                        <a-switch
                            v-model:checked="state.dynamicRangeSyncEnabled"
                            @change="onDynamicRangeSyncEnabledChange"
                        />
                    </div>
                    <template v-if="isDynamicMotionMode && state.dynamicRangeSyncEnabled">
                        <div class="sync-distance-row">
                            <span class="sync-distance-label">
                                {{ $$('dynamic-sync-previous-frames') }}
                            </span>
                            <a-input-number
                                v-model:value="state.dynamicSyncPreviousFrames"
                                :min="0"
                                :step="1"
                                :precision="0"
                                style="width: 100%"
                                @change="onDynamicSyncPreviousFramesChange"
                            />
                        </div>
                        <div class="sync-distance-row">
                            <span class="sync-distance-label">
                                {{ $$('dynamic-sync-next-frames') }}
                            </span>
                            <a-input-number
                                v-model:value="state.dynamicSyncNextFrames"
                                :min="0"
                                :step="1"
                                :precision="0"
                                style="width: 100%"
                                @change="onDynamicSyncNextFramesChange"
                            />
                        </div>
                    </template>
                    <div v-if="state.motionMode === 'STATIC'" class="sync-distance-row">
                        <span class="sync-distance-label">{{ $$('sync-distance') }}</span>
                        <a-input-number
                            v-model:value="state.syncDistance"
                            :min="0.1"
                            :step="1"
                            :precision="1"
                            addon-after="m"
                            style="width: 100%"
                            @change="onSyncDistanceChange"
                        />
                    </div>
                    <a-checkbox
                        v-if="
                            state.motionMode === 'STATIC' ||
                            (isDynamicMotionMode && state.dynamicRangeSyncEnabled)
                        "
                        v-model:checked="state.syncUseZ"
                        style="margin-top: 8px"
                        @change="onSyncUseZChange"
                    >
                        {{ $$('sync-use-z') }}
                    </a-checkbox>
                    <div v-if="state.motionMode === 'STATIC'" class="sync-distance-row">
                        <span class="sync-distance-label">{{ $$('sync-yaw-offset') }}</span>
                        <a-input-number
                            v-model:value="state.syncYawOffsetDeg"
                            :step="0.1"
                            :precision="2"
                            addon-after="deg"
                            style="width: 100%"
                            @change="onSyncYawOffsetChange"
                        />
                    </div>
                    <div v-if="state.motionMode === 'STATIC'" class="sync-distance-row">
                        <span class="sync-distance-label">{{ $$('sync-x-offset') }}</span>
                        <a-input-number
                            v-model:value="state.syncXOffsetM"
                            :step="0.05"
                            :precision="3"
                            addon-after="m"
                            style="width: 100%"
                            @change="(value) => onSyncXYOffsetChange('x', value)"
                        />
                    </div>
                    <div v-if="state.motionMode === 'STATIC'" class="sync-distance-row">
                        <span class="sync-distance-label">{{ $$('sync-y-offset') }}</span>
                        <a-input-number
                            v-model:value="state.syncYOffsetM"
                            :step="0.05"
                            :precision="3"
                            addon-after="m"
                            style="width: 100%"
                            @change="(value) => onSyncXYOffsetChange('y', value)"
                        />
                    </div>
                    <a-button
                        type="primary"
                        block
                        :loading="state.syncing"
                        style="margin-top: 8px"
                        @click="onSyncClick"
                    >
                        {{ $$('sync-now') }}
                    </a-button>
                    <div class="sync-tip">{{ $$('sync-now-tip') }}</div>
                    <div class="sync-distance-row">
                        <span class="sync-distance-label">{{ $$('sync-location-gap') }}</span>
                        <a-input-number
                            v-model:value="state.syncLocationGapMs"
                            :min="1"
                            :step="1"
                            :precision="0"
                            addon-after="ms"
                            style="width: 100%"
                            @change="onSyncLocationGapMsChange"
                        />
                    </div>
                    <div v-if="state.motionMode === 'STATIC'" class="sync-distance-row">
                        <span class="sync-distance-label">{{ $$('sync-max-disappear-gap') }}</span>
                        <a-input-number
                            v-model:value="state.syncMaxDisappearGap"
                            :min="0"
                            :step="1"
                            :precision="0"
                            addon-after="frames"
                            style="width: 100%"
                            @change="onSyncMaxDisappearGapChange"
                        />
                    </div>
                </a-collapse-panel>

                <a-collapse-panel v-show="state.attrs.length > 0" key="attribute">
                    <template #header="{ isActive }">
                        <span class="item-header">
                            <span class="title1">
                                {{ 'Attributes' }}
                            </span>
                        </span>
                    </template>
                    <ObjectAttr :state="state" @change="onAttChange" @copy-from="copyAttrFrom" />
                </a-collapse-panel>
                <a-collapse-panel key="objects" v-if="TState.imgViews.length > 0">
                    <template #header="{ isActive }">
                        <span class="item-header">
                            <span class="title1">
                                {{ 'Objects' }}
                            </span>
                        </span>
                    </template>
                    <ObjectItem
                        v-for="item in state.resultInstances"
                        :data="item"
                        @remove="onObjectInstanceRemove(item)"
                    />
                </a-collapse-panel>
            </a-collapse>
        </div>
        <CloseCircleOutlined v-show="showClose" @click="onClose" class="close" />
    </div>
</template>

<script setup lang="ts">
    import { useInjectEditor } from '../../state';
    import {
        EyeOutlined,
        DeleteOutlined,
        CloseCircleOutlined,
        FileMarkdownOutlined,
        EyeInvisibleOutlined,
        CopyOutlined,
    } from '@ant-design/icons-vue';
    import * as _ from 'lodash';
    import * as locale from './lang';
    import { Const, MotionMode, utils } from 'pc-editor';

    import ObjectItem from './ObjectItem.vue';
    import ObjectClass from './ObjectClass.vue';
    import ObjectAttr from './ObjectAttr.vue';

    import useUI from '../../hook/useUI';
    import useEditClass from './useEditClass';
    import { computed, ref, onMounted } from 'vue';

    interface IProps {
        // option: IClassOption;
        showClose: boolean;
    }

    // ***************Props and Emits***************
    let props = defineProps<IProps>();
    // let emit = defineEmits(['close']);
    // let props = defineProps<IProps>();
    // *********************************************

    let container = ref(null as any as HTMLDivElement);
    let { canEdit } = useUI();
    let editor = useInjectEditor();
    let TState = editor.state;
    // let EState = editor.state;
    let $$ = editor.bindLocale(locale);

    onMounted(() => {
        container.value.addEventListener('scroll', editor.blurPage);
    });

    let statusList = computed(() => {
        const data = [
            { value: Const.True_Value, label: $$('True-Value') },
            { value: Const.Predicted, label: $$('Predicted') },
            { value: Const.Copied, label: $$('Copied') },
        ];
        return data;
    });
    let motionModeOptions = computed(() => utils.getMotionModeOptions($$));

    // function onStatusChange(e: any) {
    //     editor.blurPage();
    //     onObjectStatusChange(e.target.value);
    // }

    function onClose() {
        // emit('close');
        control.close();
    }

    let {
        state,
        update,
        control,
        onAttChange,
        onClassChange,
        onGroupIdChange,
        onOccludedChange,
        onReviewedCorrectChange,
        onMotionModeChange,
        onSyncDistanceChange,
        onSyncMaxDisappearGapChange,
        onSyncLocationGapMsChange,
        onDynamicRangeSyncEnabledChange,
        onDynamicSyncPreviousFramesChange,
        onDynamicSyncNextFramesChange,
        onSyncUseZChange,
        onSyncYawOffsetChange,
        onSyncXYOffsetChange,
        onSyncClick,
        onInstanceRemove,
        onToggleObjectsVisible,
        onRemoveObjects,
        // onObjectStatusChange,
        onObjectInstanceRemove,
        copyAttrFrom,
        onToggleTrackVisible,
        // toggleStandard,
    } = useEditClass();
    let isDynamicMotionMode = computed(
        () =>
            state.motionMode === MotionMode.DYNAMIC_FIXED_SIZE ||
            state.motionMode === MotionMode.DYNAMIC_VARIABLE_SIZE,
    );
    defineExpose({
        update,
    });
</script>

<style lang="less">
    .edit-class-common {
        position: relative;
        height: 100%;

        .view-class-wrap {
            overflow: auto;
            max-height: calc(100vh - 300px);
            min-height: 200px;
            padding: 0px 32px;
        }

        .attr-container {
            margin-top: 4px;
            max-height: 300px;
            overflow: auto;
        }

        .instance-list {
            max-height: 200px;
            overflow-y: auto;
            // min-height: 100px;
        }

        .close {
            position: absolute;
            right: 10px;
            top: 10px;
            font-size: 20px;
        }

        .class-list {
            text-align: left;
        }

        .attr-item {
            text-align: left;
            .name {
                font-size: 14px;
                line-height: 34px;
            }

            .value {
                padding: 4px 0px;
            }
        }

        .item {
            background: #303036;
            padding: 4px 6px;
            margin-right: 8px;
            margin-bottom: 8px;
            white-space: nowrap;
            border-radius: 3px;
            display: inline-block;
            cursor: pointer;
            vertical-align: middle;
            max-width: 140px;

            .anticon,
            .iconfont {
                margin-right: 4px;
            }

            &.active,
            &:hover {
                background: #2e8cf0;
                color: white !important;
            }
        }

        .inference-source {
            display: inline-block;
            padding: 3px 8px;
            margin: 6px 0;
            color: #1f1f1f;
            font-size: 12px;
            font-weight: 500;
            background: #ff9f1c;
            border-radius: 3px;
        }

        .item-header {
            height: 40px;
            display: flex;
            align-items: center;
            color: #d5d5d5;
        }

        .sub-header {
            height: 40px;
            display: flex;
            align-items: center;
            color: white;
        }

        .item-content {
            padding-left: 20px;
        }

        .title-icon {
            font-size: 18px;
            margin-left: 4px;
            cursor: pointer;
        }

        .title1 {
            font-size: 14px;
            font-weight: bold;
        }
        .title2 {
            font-size: 12px;
            line-height: 20px;
            color: #bfbfbf;
        }

        .sync-tip {
            color: #999;
            font-size: 12px;
            line-height: 18px;
            margin-top: 6px;
        }

        .sync-distance-row {
            margin-top: 8px;
        }

        .sync-distance-label {
            color: #999;
            display: block;
            font-size: 12px;
            margin-bottom: 4px;
        }

        .copy {
            font-size: 16px;
            margin-left: 6px;
            cursor: pointer;
        }

        .ant-input,
        .no-attrs,
        .ant-select-single .ant-select-selector .ant-select-selection-item,
        .ant-radio-button-wrapper,
        .attr-item .name,
        .ant-radio-wrapper {
            color: #cbcbcb;
        }

        .ant-radio-button-wrapper,
        .ant-radio-button-wrapper:first-child {
            border: 1px solid #177ddc;
        }

        .ant-radio-button-wrapper:hover {
            border: 1px solid #177ddc;
            color: white;
        }

        .ant-radio-button-wrapper-checked {
            background: #177ddc;
            color: white;
        }

        .class-msg-box {
            padding: 10px;
            border: 1px solid #3a3a3a;
            margin-top: 10px;

            .content-wrap {
                color: #b1b1b1;
            }

            .btn {
                text-align: right;
                margin-top: 10px;
            }
        }

        .pick {
            font-size: 18px;
            margin-left: 10px;
            cursor: pointer;
        }

        // ant
        .ant-collapse-header {
            padding: 0px !important;
        }
        .ant-collapse {
            border: none;
            background-color: #1e1f23;
        }
        .ant-collapse-content-box {
            background: #1e1f23 !important;
        }

        .ant-collapse-content {
            border: none;
            background-color: #1e1f23;
        }

        .ant-collapse > .ant-collapse-item > .ant-collapse-header .ant-collapse-arrow {
            left: -15px;
        }
    }
</style>
