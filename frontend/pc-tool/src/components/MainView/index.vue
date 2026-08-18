<template>
    <div class="main-view">
        <div ref="dom" style="height: 100%; width: 100%; position: relative"></div>
        <Labels :data="state.labels" v-show="editor.state.config.showLabel" />
        <Labels :data="state.lineLabels" />
        <Annotation
            v-if="editor.state.modeConfig.name === 'discussion'"
            :data="state.annotations"
            @select="openDiscussion"
        />
        <slot name="info" v-if="$slots.info"></slot>
        <Info v-else />
        <Image2DMax />
        <slot name="editClass" v-if="$slots.editClass"></slot>
    </div>
</template>

<script setup lang="ts">
    import { onMounted, onBeforeUnmount, ref, reactive, computed } from 'vue';
    import { MainRenderView, Event as RenderEvent } from 'pc-render';
    import { useInjectEditor } from '../../state';
    import * as _ from 'lodash';
    import * as THREE from 'three';

    import Labels from './Labels.vue';
    import Annotation from './Annotation.vue';
    import Info from './Info.vue';
    import Image2DMax from '../ImgView/Image2DMax.vue';

    import { IUserData, IClassType, Event } from 'pc-editor';
    import { discussionState, IDiscussionPosition } from '../Discussion/store';

    interface ILabel {
        name: string;
        x: number;
        y: number;
        scale: number;
    }

    let dom = ref<HTMLDivElement | null>(null);
    let editor = useInjectEditor();
    let pc = editor.pc;
    let view = {} as MainRenderView;
    let state = reactive({
        labels: [] as ILabel[],
        lineLabels: [] as ILabel[],
        annotations: [] as any[],
    });

    let classTypeMap = computed(() => {
        let map = {} as Record<string, IClassType>;
        editor.state.classTypes.forEach((e) => {
            map[e.name] = e;
        });
        return map;
    });

    let updateAnnotation = () => {
        if (editor.state.modeConfig.name !== 'discussion') {
            state.annotations = [];
            return;
        }
        const frameId = String(editor.getCurrentFrame()?.id || '');
        const matrix = new THREE.Matrix4()
            .copy(view.camera.projectionMatrix)
            .multiply(view.camera.matrixWorldInverse);
        const object3d = editor.pc.getAnnotate3D();
        const annotations: any[] = [];

        discussionState.comments
            .filter((item) => !item.parentId && String(item.dataId) === frameId)
            .forEach((item) => {
                const position = new THREE.Vector3();
                if (item.anchorType === 'POSITION' && item.position) {
                    const point = item.position as IDiscussionPosition;
                    position.set(point.x, point.y, point.z);
                } else if (item.anchorType === 'OBJECT') {
                    const object = object3d.find((candidate) => {
                        const userData = candidate.userData || {};
                        return (
                            (!!item.objectId &&
                                String(userData.backId || userData.id) ===
                                    String(item.objectId)) ||
                            (!!item.trackId && userData.trackId === item.trackId)
                        );
                    });
                    if (!object) return;
                    position.set(0, 0, 0).applyMatrix4(object.matrixWorld);
                } else {
                    return;
                }

                position.applyMatrix4(matrix);
                if (Math.abs(position.z) > 1) return;
                annotations.push({
                    id: item.id,
                    name: item.resolved ? `Resolved: ${item.message}` : item.message,
                    x: ((position.x + 1) / 2) * view.width,
                    y: (-(position.y - 1) / 2) * view.height,
                    scale: 1,
                });
            });
        state.annotations = annotations;
    };

    let updateLabel = () => {
        // if (!editor.state.config.showLabel) return;
        let measureLineObjects = editor.pc.groupTrack;
        let camera = view.camera;
        let matrix = new THREE.Matrix4();
        matrix.copy(camera.projectionMatrix);
        matrix.multiply(camera.matrixWorldInverse);

        let objects = pc.getAnnotate3D();

        let list: ILabel[] = [];
        let list1: ILabel[] = [];
        let pos = new THREE.Vector3();
        let pos1 = new THREE.Vector3();

        if (measureLineObjects.visible) {
            measureLineObjects.children.forEach((e) => {
                if (!e.visible) return;
                const size = e.scale.x;
                pos.set(0, 0, 0);
                pos.applyMatrix4(e.matrixWorld);
                pos.x += size;
                pos.applyMatrix4(matrix);
                pos.x = ((pos.x + 1) / 2) * view.width;
                pos.y = (-(pos.y - 1) / 2) * view.height;
                if (Math.abs(pos.z) > 1) return;
                let obj = {
                    name: size + 'm',
                    x: pos.x,
                    y: pos.y - 6,
                    scale: 1,
                };
                list1.push(obj);
            });
        }

        if (editor.state.config.showLabel) {
            objects.forEach((e) => {
                if (!e.visible) return;
                let userData = e.userData as IUserData;
                let classType = userData.classType || '';
                let classConfig = editor.getClassType(userData);
                let className = classConfig
                    ? classConfig.label || classConfig.name || ''
                    : classType;

                pos.set(0, 0, 0);
                pos.applyMatrix4(e.matrixWorld);
                pos.applyMatrix4(matrix);
                pos.x = ((pos.x + 1) / 2) * view.width;
                pos.y = (-(pos.y - 1) / 2) * view.height;
                // pos.z = 0;

                if (Math.abs(pos.z) > 1) return;

                // let subId = (userData.id + '').slice(-4);
                let trackName = userData.trackName || '';
                let obj = {
                    name: classType ? `${className}-${trackName}` : `${trackName}`,
                    x: pos.x,
                    y: pos.y,
                    scale: 1,
                };
                list.push(obj);
            });
        }
        state.labels = list;
        state.lineLabels = list1;
    };

    function update() {
        updateLabel();
        updateAnnotation();
    }

    function openDiscussion(id: string) {
        editor.dispatchEvent({ type: Event.DISCUSSION_OPEN, data: { id } });
    }

    onMounted(() => {
        if (dom.value) {
            view = new MainRenderView(dom.value, pc, { name: 'main-view' });
            pc.addRenderView(view);
        }
        view.addEventListener(RenderEvent.RENDER_AFTER, update);
    });
    onBeforeUnmount(() => {
        view.removeEventListener(RenderEvent.RENDER_AFTER, update);
        pc.removeRenderView(view);
    });
</script>

<style lang="less">
    .main-view {
        height: 100%;
        position: relative;
        overflow: hidden;
    }

    .main-view-tool {
        position: absolute;
        right: 6px;
        top: 6px;
        width: 32px;
        background: #333333;
        border-radius: 4px;
        z-index: 1;

        .item {
            display: inline-block;
            width: 32px;
            height: 32px;
            font-size: 18px;
            padding: 6px;
            border-radius: 4px;
            background: #333333;
            color: white;
            cursor: pointer;

            &:hover,
            &.active {
                background: #ffffff4d;
            }
        }
    }
</style>
