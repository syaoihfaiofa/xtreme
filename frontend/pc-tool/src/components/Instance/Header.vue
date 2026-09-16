<template>
    <div>
        <span class="collapse-title">
            <!-- <span>{{ $$('result-pre') }}</span> -->
            <span class="result-classify-name limit">Instances</span>
            ({{ data.objectN }})
        </span>
        <div class="tool">
            <EyeOutlined
                v-if="data.visible"
                class="icon"
                :title="$$('title-hide-all')"
                @click.stop="onToggleAllVisible"
            />
            <EyeInvisibleOutlined
                v-else
                class="icon"
                :title="$$('title-show-all')"
                @click.stop="onToggleAllVisible"
            />
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
    import useUI from '../../hook/useUI';
    import * as _ from 'lodash';
    import { useInjectEditor } from '../../state';
    import * as locale from './lang';
    import { IClassify } from './type';
    import { EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons-vue';

    // ***************Props and Emits***************
    let emit = defineEmits(['toggle-attr']);
    let props = defineProps<{
        // title: string;
        data: IClassify;
    }>();
    // *********************************************

    let { canEdit, isPlay } = useUI();
    let editor = useInjectEditor();
    let tState = editor.state;

    let $$ = editor.bindLocale(locale);

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

    function getAllObjects() {
        const objectIdMap: Record<string, true> = {};
        props.data.data.forEach((classInfo) => {
            classInfo.data.forEach((trackInfo) => {
                trackInfo.data.forEach((item) => {
                    objectIdMap[item.id] = true;
                });
            });
        });
        return [...editor.pc.getAnnotate3D(), ...editor.pc.getAnnotate2D()].filter(
            (object) => objectIdMap[object.uuid],
        );
    }

    function onToggleAllVisible() {
        const objects = getAllObjects();
        if (objects.length === 0) return;
        editor.cmdManager.execute('toggle-visible', {
            objects,
            // If any instance is visible, the aggregate control hides all;
            // otherwise it restores all of them.
            visible: !props.data.visible,
        });
    }

    function onDelete() {
        const objects = getAllObjects();

        editor
            .showConfirm({
                title: $$('msg-delete-title'),
                subTitle: $$('msg-delete-all', { n: props.data.objectN }),
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
</style>
