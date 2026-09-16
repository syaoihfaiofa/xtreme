<template>
    <div
        class="img-view"
        @dblclick="onDBClick"
        :style="{
            borderColor: state.config.imgRegionIndex === props.imgIndex ? '#1890ff' : '#2e2525',
            aspectRatio: viewAspectRatio,
        }"
    >
        <div class="render" ref="dom"></div>
        <div class="tool">
            <span
                :class="state.config.imgRegionIndex === props.imgIndex ? 'icon active' : 'icon'"
                @dblclick.stop="null"
                @click.stop="showView"
            >
                <span class="eye-icon" :title="$$('show-camera')">
                    <EyeOutlined />
                </span>
            </span>
        </div>
    </div>
</template>

<script setup lang="ts">
    import { computed, onMounted, ref, onBeforeUnmount, nextTick, watch } from 'vue';
    import * as THREE from 'three';
    import {
        Image2DRenderView,
        PointsMaterial,
        Rect,
    } from 'pc-render';
    import { useInjectState, useInjectEditor } from '../../state';
    import * as locale from './lang';

    import useUI from '../../hook/useUI';
    import useContextMenu from '../../hook/useContextMenu';
    import { FullscreenOutlined, EyeOutlined } from '@ant-design/icons-vue';
    import useInjectProxy from './useProxy';

    // ***************Props and Emits***************
    interface ImgViewProps {
        imgIndex: number;
    }

    const props = withDefaults(defineProps<ImgViewProps>(), {
        imgIndex: 0,
    });

    // *********************************************

    let dom = ref<HTMLDivElement | null>(null);
    let editor = useInjectEditor();
    let pc = editor.pc;
    let view = {} as Image2DRenderView;
    let state = useInjectState();
    let $$ = editor.bindLocale(locale);
    let { canOperate } = useUI();
    let { handleContext, clearContext } = useContextMenu();
    let renderProxy = useInjectProxy();
    let resizeObserver: ResizeObserver | undefined;
    let resizeFrame = 0;

    // Preserve the image's native aspect ratio in the viewport. Camera images
    // remain 16:9, while a square stitched image receives a square viewport
    // instead of letterboxing it inside the camera layout.
    const viewAspectRatio = computed(() => {
        const config = state.imgViews[props.imgIndex];
        // birdEye is available before the browser has decoded imgObject. Do
        // not briefly fall back to the camera 16:9 ratio on the first frame.
        if (config?.birdEye) return 1;
        const image = config?.imgObject;
        if (!image?.naturalWidth || !image?.naturalHeight) {
            return state.config.aspectRatio;
        }
        return image.naturalWidth / image.naturalHeight;
    });

    // The first resource load can mount this component before its Image object
    // has finished decoding. Re-applying options after imgObject arrives is
    // essential: frame switches did it incidentally, which is why only frame 1
    // showed black letterboxing.
    watch(
        () => state.imgViews[props.imgIndex]?.imgObject,
        (image) => {
            if (!image || !dom.value || !view.setOptions) return;
            nextTick(() => {
                requestAnimationFrame(() => {
                    if (!dom.value) return;
                    view.setOptions(state.imgViews[props.imgIndex]);
                    view.updateSize();
                    view.render();
                });
            });
        },
    );

    onMounted(() => {
        // console.log('img view onMounted');
        if (dom.value) {
            let config = state.config;
            view = new Image2DRenderView(dom.value, pc, {
                name: `${config.imgViewPrefix}-${props.imgIndex}`,
                // actions: [],
                actions: ['render-2d-shape'],
                proxy: renderProxy,
            });
            view.renderBox = false;
            view.renderRect = state.config.projectPoint4;
            view.renderBox2D = state.config.projectPoint8;

            view.id = `${config.imgViewPrefix}-${props.imgIndex}`;
            pc.addRenderView(view);

            // let info = get2DInfo(props.imgIndex);
            view.setOptions(state.imgViews[props.imgIndex]);
            view.renderPoints = false;

            // The stitched image changes this component from the initial
            // camera 16:9 layout to 1:1 after Vue has painted it. Recompute
            // the canvas fit matrix on that layout change; otherwise the first
            // frame is letterboxed until a later frame happens to resize it.
            resizeObserver = new ResizeObserver(() => {
                if (resizeFrame) cancelAnimationFrame(resizeFrame);
                resizeFrame = requestAnimationFrame(() => {
                    resizeFrame = 0;
                    view.updateSize();
                    view.render();
                });
            });
            resizeObserver.observe(dom.value);
            nextTick(() => {
                view.updateSize();
                view.render();
            });

            handleContext(dom.value);
        }
    });

    onBeforeUnmount(() => {
        resizeObserver?.disconnect();
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        clearContext();

        pc.removeRenderView(view);
        renderProxy.removeView(view);
        view.destroy();
    });

    function showView(e: MouseEvent) {
        let points = pc.groupPoints.children[0] as THREE.Points;
        let material = points.material as PointsMaterial;
        if (state.config.imgRegionIndex === props.imgIndex) {
            state.config.imgRegionIndex = -1;
            material.setUniforms({
                hasCameraRegion: -1,
            });
        } else {
            state.config.imgRegionIndex = props.imgIndex;
            let matrix = new THREE.Matrix4()
                .copy(view.camera.projectionMatrix)
                .multiply(view.camera.matrixWorldInverse);
            material.setUniforms({
                hasCameraRegion: 1,
                regionMatrix: matrix,
            });
        }
        pc.render();
    }

    function onDBClick() {
        if (!canOperate()) return;
        editor.viewManager.showSingleImgView(props.imgIndex);
    }

    function rand(start: number, end: number) {
        return Math.round(start + (end - start) * Math.random());
    }
</script>

<style lang="less" scoped>
    .img-view {
        // height: 100%;
        position: relative;
        color: white;
        // padding: 3px;
        // background: #2e2525;
        border: 2px solid #2e2525;
        width: 100%;
        // min-height: 100px;
        aspect-ratio: 1.78;

        .render {
            height: 100%;
        }

        .icon {
            vertical-align: middle;
            display: inline-block;
            background: #333333;
            line-height: 24px;
            height: 24px;
            padding: 0px 6px;
            border-radius: 4px;
            cursor: pointer;

            &.active {
                color: #40a9ff;
            }
        }

        .tool {
            position: absolute;
            right: 6px;
            top: 6px;
            .icon {
                .camera-heading {
                    font-size: 14px;
                    padding-right: 3px;
                    text-overflow: ellipsis;
                    overflow: hidden;
                    display: inline-block;
                    flex: 1;
                }
                .eye-icon {
                    display: inline-block;
                }
                display: flex;
                max-width: 90px;
                // width: 28px;
                text-align: center;
                font-size: 16px;
                margin-left: 6px;
                padding-right: 6px;
                white-space: nowrap;
            }
        }
    }
</style>
