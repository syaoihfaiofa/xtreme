<template>
    <div>
        <span class="collapse-title">
            <!-- <span>{{ $$('result-pre') }}</span> -->
            <span class="result-classify-name limit">Instances</span>
            ({{ instanceCount }})
        </span>
        <div class="tool">
            <a-popover
                v-model:open="visibilityMenuOpen"
                trigger="click"
                placement="bottomRight"
                overlayClassName="instance-visibility-popover"
            >
                <EyeOutlined class="icon" :title="$$('title-visibility-filter')" />
                <template #content>
                    <div class="visibility-filter-menu">
                        <div class="visibility-filter-title">{{ $$('visibility-filter-scope') }}</div>
                        <a-radio-group v-model:value="visibilityScope">
                            <a-radio value="current-frame">{{
                                $$('visibility-filter-current-frame')
                            }}</a-radio>
                            <a-radio value="all-frames">{{
                                $$('visibility-filter-all-frames')
                            }}</a-radio>
                        </a-radio-group>
                        <div class="visibility-filter-title">{{
                            $$('visibility-filter-type')
                        }}</div>
                        <a-checkbox-group
                            v-model:value="hiddenTypes"
                            @change="onHiddenTypesChange"
                        >
                            <a-checkbox
                                v-for="type in INSTANCE_VISIBILITY_TYPES"
                                :key="type"
                                :value="type"
                            >
                                {{ $$(`visibility-type-${type}`) }}
                            </a-checkbox>
                        </a-checkbox-group>
                    </div>
                </template>
            </a-popover>
            <i
                :class="
                    tState.config.showAttr
                        ? 'iconfont icon-xinxi icon active'
                        : 'iconfont icon-xinxi icon'
                "
                :title="$$('title-show-attr')"
                v-show="tState.config.enableShowAttr"
                @click.stop="onToggleAttr"
            ></i>
            <a-dropdown :trigger="['click']" v-if="canEdit() && !isPlay()">
                <i class="iconfont icon-gengduoicon icon" @click.stop></i>
                <template #overlay>
                    <div>
                        <div class="border-bottom" style="text-align: center; padding: 4px">{{
                            $$('header-Operation')
                        }}</div>
                        <a-menu @click="onMenuClick" :selectable="false">
                            <a-menu-item key="delete"> {{ $$('header-remove-all') }} </a-menu-item>
                        </a-menu>
                    </div>
                </template>
            </a-dropdown>
        </div>
    </div>
</template>

<script setup lang="ts">
    import { computed, ref, watch } from 'vue';
    import useUI from '../../hook/useUI';
    import { useInjectEditor } from '../../state';
    import * as locale from './lang';
    import { IClassify } from './type';
    import { getClassifyObjectCount } from './useInstance';
    import { EyeOutlined } from '@ant-design/icons-vue';
    import {
        INSTANCE_VISIBILITY_TYPES,
    } from './visibilityFilter';
    import type {
        IInstanceVisibilityFilter,
        InstanceVisibilityScope,
        InstanceVisibilityType,
    } from './visibilityFilter';

    // ***************Props and Emits***************
    let emit = defineEmits(['toggle-attr']);
    let props = defineProps<{
        // title: string;
        data: IClassify;
        visibilityFilter: IInstanceVisibilityFilter;
        frameId: string;
        changeVisibilityFilter: (
            scope: InstanceVisibilityScope,
            type: InstanceVisibilityType,
            hidden: boolean,
        ) => void;
    }>();
    // *********************************************

    let { canEdit, isPlay } = useUI();
    let editor = useInjectEditor();
    let tState = editor.state;

    let $$ = editor.bindLocale(locale);
    let visibilityScope = ref<InstanceVisibilityScope>('current-frame');
    let visibilityMenuOpen = ref(false);
    let hiddenTypes = ref<InstanceVisibilityType[]>([]);
    let instanceCount = computed(() => getClassifyObjectCount(props.data));

    watch(
        [visibilityScope, () => props.visibilityFilter, () => props.frameId],
        () => {
            let types =
                visibilityScope.value === 'all-frames'
                    ? props.visibilityFilter.allFrames
                    : props.visibilityFilter.frames[props.frameId] || [];
            hiddenTypes.value = [...types];
        },
        { immediate: true },
    );

    function onMenuClick(item: any) {
        console.log(item);
        switch (item.key) {
            case 'delete':
                onDelete();
                break;
        }
    }

    function onToggleAttr() {
        emit('toggle-attr');
    }

    function onHiddenTypesChange(nextTypes: InstanceVisibilityType[]): void {
        const nextTypeSet = new Set(nextTypes);
        const currentTypes =
            visibilityScope.value === 'all-frames'
                ? props.visibilityFilter.allFrames
                : props.visibilityFilter.frames[props.frameId] || [];

        INSTANCE_VISIBILITY_TYPES.forEach((type) => {
            let currentHidden = currentTypes.includes(type);
            let nextHidden = nextTypeSet.has(type);
            if (currentHidden !== nextHidden) {
                props.changeVisibilityFilter(visibilityScope.value, type, nextHidden);
            }
        });
    }

    function getAllObjects() {
        return [...editor.pc.getAnnotate3D(), ...editor.pc.getAnnotate2D()];
    }

    function onDelete() {
        const objects = getAllObjects();

        editor
            .showConfirm({
                title: $$('msg-delete-title'),
                subTitle: $$('msg-delete-all', { n: objects.length }),
                okText: $$('msg-delete-title'),
                okDanger: true,
            })
            .then(
                () => {
                    if (objects.length > 0) {
                        editor.cmdManager.execute('delete-object', objects);
                    }
                },
                () => {},
            );
    }
</script>

<style lang="less">
    .result-classify-name {
        max-width: 80px;
        vertical-align: top;
        display: inline-block;
    }
    .ant-dropdown {
        background: #333;
        .ant-menu {
            background-color: transparent;
        }

        .ant-menu-vertical > .ant-menu-item {
            height: 30px;
            line-height: 30px;
            color: #a7a7a7;
        }
    }

    .visibility-filter-menu {
        min-width: 180px;
        padding: 8px 12px;

        .visibility-filter-title {
            margin: 4px 0;
            color: #a7a7a7;
        }

        .ant-radio-group,
        .ant-checkbox-wrapper {
            display: block;
            margin: 4px 0;
        }
    }
</style>
