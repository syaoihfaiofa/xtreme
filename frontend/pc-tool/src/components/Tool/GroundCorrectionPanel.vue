<template>
    <div v-show="editor.state.config.groundCorrectionMode" class="ground-correction-panel">
        <div class="ground-correction-panel__header">
            <span>地面纠正</span>
            <span class="ground-correction-panel__close" title="退出地面纠正模式" @click="exitMode">
                &times;
            </span>
        </div>

        <div class="ground-correction-panel__section">标注工具</div>
        <div class="ground-correction-panel__grid ground-correction-panel__grid--tools">
            <span class="ground-correction-panel__tool" title="多边形选区：逐点点击围出区域，双击或 Enter 提交，区域内的点归为地面" @click="startPolygon">
                <svg class="ground-correction-panel__icon" viewBox="0 0 24 24"><path d="M3,5V19H5V21H3A2,2 0 0,1 1,19V5A2,2 0 0,1 3,3H5V5H3M21,19V5H19V3H21A2,2 0 0,1 23,5V19A2,2 0 0,1 21,21H19V19H21M7,5H9V3H7V5M11,5H13V3H11V5M15,5H17V3H15V5M7,21H9V19H7V21M11,21H13V19H11V21M15,21H17V19H15V21M7,12L10,9L13,12L17,8V16H7V12Z" /></svg>
                <span>多边形选区</span>
            </span>
            <span class="ground-correction-panel__tool" title="画笔涂抹：按住拖动涂抹，松开提交，涂过的点归为地面" @click="startBrush">
                <svg class="ground-correction-panel__icon" viewBox="0 0 24 24"><path d="M20.71,4.63L19.37,3.29C19,2.9 18.35,2.9 17.96,3.29L9,12.25L11.75,15L20.71,6.04C21.1,5.65 21.1,5 20.71,4.63M7,14A3,3 0 0,0 4,17C4,18.31 2.84,19 2,19C2.92,20.22 4.5,21 6,21A4,4 0 0,0 10,17A3,3 0 0,0 7,14Z" /></svg>
                <span>画笔涂抹</span>
            </span>
            <span class="ground-correction-panel__tool" title="魔棒聚类：点击一个点，自动选中相连的贴地点并归为地面" @click="startCluster">
                <svg class="ground-correction-panel__icon" viewBox="0 0 24 24"><path d="M7.5,5.6L5,7L6.4,4.5L5,2L7.5,3.4L10,2L8.6,4.5L10,7L7.5,5.6M19.5,15.4L22,14L20.6,16.5L22,19L19.5,17.6L17,19L18.4,16.5L17,14L19.5,15.4M22,2L20.6,4.5L22,7L19.5,5.6L17,7L18.4,4.5L17,2L19.5,3.4L22,2M13.34,12.78L15.78,10.34L13.66,8.22L11.22,10.66L13.34,12.78M14.37,7.29L16.71,9.63C17.1,10 17.1,10.65 16.71,11.04L5.04,22.71C4.65,23.1 4,23.1 3.63,22.71L1.29,20.37C0.9,20 0.9,19.35 1.29,18.96L12.96,7.29C13.35,6.9 14,6.9 14.37,7.29Z" /></svg>
                <span>魔棒聚类</span>
            </span>
            <span class="ground-correction-panel__tool" title="橡皮擦：按住拖动，把误纠正为地面的点恢复为原分类" @click="startEraser">
                <svg class="ground-correction-panel__icon" viewBox="0 0 24 24"><path d="M16.24,3.56L21.19,8.5C21.97,9.29 21.97,10.55 21.19,11.34L12,20.53C10.44,22.09 7.91,22.09 6.34,20.53L2.81,17C2.03,16.21 2.03,14.95 2.81,14.16L13.41,3.56C14.2,2.78 15.46,2.78 16.24,3.56M4.22,15.58L7.76,19.11C8.54,19.9 9.8,19.9 10.59,19.11L14.12,15.58L9.17,10.63L4.22,15.58Z" /></svg>
                <span>橡皮擦</span>
            </span>
        </div>

        <div class="ground-correction-panel__section">快捷操作</div>
        <div class="ground-correction-panel__grid ground-correction-panel__grid--actions">
            <span class="ground-correction-panel__btn" title="低点归地：当前帧所有低于 拾取 Z - 0.1m 的点归为地面" @click="applyBelowGround">
                <svg class="ground-correction-panel__icon" viewBox="0 0 24 24"><path d="M19.92,12.08L12,20L4.08,12.08L5.5,10.67L11,16.17V2H13V16.17L18.5,10.66L19.92,12.08M12,20H2V22H22V20H12Z" /></svg>
                <span>低点归地</span>
            </span>
            <a-popover
                v-model:visible="propagateVisible"
                trigger="click"
                placement="right"
                overlayClassName="ground-correction-propagate-popover"
            >
                <template #content>
                    <div class="ground-correction-propagate">
                        <div class="ground-correction-propagate__title">应用到后续帧</div>
                        <div class="ground-correction-propagate__row">
                            <label>往后</label>
                            <a-input-number
                                v-model:value="propagateDistance"
                                :min="1"
                                :precision="0"
                                size="small"
                                @pressEnter="propagate"
                            />
                            <label>帧</label>
                        </div>
                        <a-button size="small" type="primary" block @click="propagate">应用</a-button>
                    </div>
                </template>
                <span class="ground-correction-panel__btn" title="把当前帧的纠正结果应用到后续 N 帧；Ctrl+X 直接按当前帧数应用">
                    <svg class="ground-correction-panel__icon" viewBox="0 0 24 24"><path d="M13,6V18L21.5,12M4,18L12.5,12L4,6V18Z" /></svg>
                    <span>应用后续</span>
                </span>
            </a-popover>
        </div>

        <div class="ground-correction-panel__section">参数</div>
        <div class="ground-correction-panel__params">
            <label title="地面纠正的 Z 高度范围下限">Z 最小</label>
            <a-input-number
                :value="heightRange[0]"
                :controls="false"
                :step="0.1"
                size="small"
                @update:value="updateHeight(0, $event)"
            />
            <span class="ground-correction-panel__unit">m</span>
            <label title="地面纠正的 Z 高度范围上限">Z 最大</label>
            <a-input-number
                :value="heightRange[1]"
                :controls="false"
                :step="0.1"
                size="small"
                @update:value="updateHeight(1, $event)"
            />
            <span class="ground-correction-panel__unit">m</span>
            <label title="BEV 拾取平面的绝对 Z（原点为后轴中心，地面约为 -轮胎半径）">拾取 Z</label>
            <a-input-number
                :value="pickZ"
                :controls="false"
                :step="0.05"
                size="small"
                @update:value="updatePickZ"
            />
            <span class="ground-correction-panel__unit">m</span>
            <label title="聚类只包含种子点上下该范围内的点，防止串到车辆等目标">高度带 ±</label>
            <a-input-number
                :value="clusterHeightTolerance"
                :controls="false"
                :min="0.01"
                :step="0.05"
                size="small"
                @update:value="updateClusterHeightTolerance"
            />
            <span class="ground-correction-panel__unit">m</span>
            <label title="聚类连通与匹配半径">聚类半径</label>
            <a-input-number
                :value="clusterRadius"
                :controls="false"
                :min="0.01"
                :step="0.1"
                size="small"
                @update:value="updateClusterRadius"
            />
            <span class="ground-correction-panel__unit">m</span>
            <label title="画笔的涂抹半径，越小越精细">画笔大小</label>
            <a-input-number
                :value="brushRadius"
                :controls="false"
                :min="0.05"
                :step="0.1"
                size="small"
                @update:value="updateBrushRadius"
            />
            <span class="ground-correction-panel__unit">m</span>
            <label title="橡皮擦的擦除半径，越小越精细">橡皮大小</label>
            <a-input-number
                :value="eraserRadius"
                :controls="false"
                :min="0.05"
                :step="0.1"
                size="small"
                @update:value="updateEraserRadius"
            />
            <span class="ground-correction-panel__unit">m</span>
        </div>
    </div>
</template>

<script setup lang="ts">
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
    import { useInjectEditor } from '../../state';
    import { requestGroundCorrectionMaskPropagation } from '../../packages/pc-editor/utils/groundCorrectionMaskEditing';

    type GroundCorrectionToolAction =
        | 'editGroundCorrectionPolygon'
        | 'editGroundCorrectionBrush'
        | 'editGroundCorrectionEraser'
        | 'editGroundCorrectionCluster'
        | 'toggleGroundCorrectionMode';

    const editor = useInjectEditor();
    const heightRange = computed(() => editor.state.config.groundCorrectionHeightRange);
    const clusterRadius = computed(() => editor.state.config.groundCorrectionClusterRadius);
    const pickZ = computed(() => editor.state.config.groundCorrectionPickZ);
    const clusterHeightTolerance = computed(
        () => editor.state.config.groundCorrectionClusterHeightTolerance,
    );
    const brushRadius = computed(() => editor.state.config.groundCorrectionBrushRadius);
    const eraserRadius = computed(() => editor.state.config.groundCorrectionEraserRadius);
    const propagateVisible = ref(false);
    const propagateDistance = ref<number | null>(1);

    function isEditableTarget(target: EventTarget | null): boolean {
        const element = target as HTMLElement | null;
        return !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
    }

    // Ctrl/Cmd+X applies immediately with the frame count last set in the popover.
    function onPropagateHotkey(event: KeyboardEvent): void {
        if (!editor.state.config.groundCorrectionMode) return;
        if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
        if (event.key.toLowerCase() !== 'x' || isEditableTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        propagate();
    }

    onMounted(() => window.addEventListener('keydown', onPropagateHotkey, true));
    onBeforeUnmount(() => window.removeEventListener('keydown', onPropagateHotkey, true));

    function updateHeight(index: 0 | 1, value: number | null): void {
        if (value === null || !Number.isFinite(value)) return;
        const nextRange: [number, number] = [...heightRange.value];
        nextRange[index] = value;
        editor.state.config.groundCorrectionHeightRange = nextRange;
    }

    function updateClusterRadius(value: number | null): void {
        if (value === null || !Number.isFinite(value) || value <= 0) return;
        editor.state.config.groundCorrectionClusterRadius = value;
    }

    function updatePickZ(value: number | null): void {
        if (value === null || !Number.isFinite(value)) return;
        editor.state.config.groundCorrectionPickZ = value;
    }

    function updateClusterHeightTolerance(value: number | null): void {
        if (value === null || !Number.isFinite(value) || value <= 0) return;
        editor.state.config.groundCorrectionClusterHeightTolerance = value;
    }

    function updateBrushRadius(value: number | null): void {
        if (value === null || !Number.isFinite(value) || value <= 0) return;
        editor.state.config.groundCorrectionBrushRadius = value;
    }

    function updateEraserRadius(value: number | null): void {
        if (value === null || !Number.isFinite(value) || value <= 0) return;
        editor.state.config.groundCorrectionEraserRadius = value;
    }

    function validateHeightRange(): boolean {
        const [min, max] = heightRange.value;
        if (Number.isFinite(min) && Number.isFinite(max) && min <= max) return true;
        editor.showMsg('warning', 'Z 最小值和最大值必须为有效数字，且最小值不能大于最大值');
        return false;
    }

    // Editing tools stay active and ActionManager blocks new actions while one runs,
    // so switching tools must stop the current one first.
    function switchTool(name: GroundCorrectionToolAction): void {
        editor.actionManager.stopCurrentAction();
        void editor.actionManager.execute(name);
    }

    function startPolygon(): void {
        if (!validateHeightRange()) return;
        switchTool('editGroundCorrectionPolygon');
    }

    function startBrush(): void {
        if (!validateHeightRange()) return;
        switchTool('editGroundCorrectionBrush');
    }

    function startCluster(): void {
        if (!validateHeightRange() || !Number.isFinite(clusterRadius.value) || clusterRadius.value <= 0) {
            editor.showMsg('warning', '聚类半径必须为大于 0 的有效数字');
            return;
        }
        switchTool('editGroundCorrectionCluster');
    }

    function startEraser(): void {
        if (!validateHeightRange()) return;
        switchTool('editGroundCorrectionEraser');
    }

    // Instant operations call the manager directly so the active editing tool stays on.
    function applyBelowGround(): void {
        editor.groundCorrectionMaskManager.applyBelowGround();
    }

    function propagate(): void {
        propagateVisible.value = false;
        requestGroundCorrectionMaskPropagation(editor, () => String(propagateDistance.value ?? ''));
    }

    function exitMode(): void {
        switchTool('toggleGroundCorrectionMode');
    }
</script>

<style lang="less">
    .ground-correction-panel {
        position: absolute;
        z-index: 20;
        top: 0;
        left: 44px;
        width: 212px;
        padding: 8px;
        border: 1px solid #3a3d44;
        border-radius: 6px;
        background: rgba(30, 31, 34, 0.96);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
        color: #bec1ca;
        font-size: 12px;

        &__header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 6px;
            border-bottom: 1px solid #3a3d44;
            color: #dee5eb;
            font-size: 13px;
            font-weight: 600;
        }

        &__close {
            width: 20px;
            height: 20px;
            border-radius: 4px;
            font-size: 16px;
            line-height: 20px;
            text-align: center;
            cursor: pointer;

            &:hover {
                background: #3a3d44;
                color: #fff;
            }
        }

        &__section {
            margin: 8px 0 4px;
            color: #8a8f99;
            font-size: 11px;
        }

        &__grid {
            display: grid;
            gap: 4px;

            &--tools {
                grid-template-columns: repeat(2, 1fr);
            }

            &--actions {
                grid-template-columns: repeat(2, 1fr);
            }
        }

        &__icon {
            width: 16px;
            height: 16px;
            flex: none;
            fill: currentColor;
        }

        &__tool {
            display: flex;
            align-items: center;
            gap: 6px;
            height: 32px;
            padding: 0 8px;
            border-radius: 4px;
            background: #2a2c31;
            white-space: nowrap;
            cursor: pointer;
            user-select: none;

            &:hover {
                background: #224b77;
                color: #dee5eb;
            }
        }

        &__btn {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 3px;
            height: 44px;
            border-radius: 4px;
            background: #2a2c31;
            cursor: pointer;
            user-select: none;

            &:hover {
                background: #224b77;
                color: #dee5eb;
            }
        }

        &__params {
            display: grid;
            grid-template-columns: auto 1fr auto;
            align-items: center;
            gap: 4px 8px;

            label {
                white-space: nowrap;
            }

            .ant-input-number {
                width: 100%;
            }
        }

        &__unit {
            color: #8a8f99;
        }
    }

    .ground-correction-propagate {
        width: 150px;

        &__title {
            margin-bottom: 8px;
            font-weight: 600;
        }

        &__row {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 8px;

            .ant-input-number {
                width: 60px;
            }
        }
    }
</style>
