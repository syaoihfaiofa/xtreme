<template>
    <div v-show="editor.state.config.groundCorrectionMode" class="ground-correction-panel">
        <div class="ground-correction-panel__range" title="地面纠正的 Z 高度范围">
            <label>
                Z min
                <a-input-number
                    :value="heightRange[0]"
                    :controls="false"
                    :step="0.1"
                    @update:value="updateHeight(0, $event)"
                />
            </label>
            <label>
                Z max
                <a-input-number
                    :value="heightRange[1]"
                    :controls="false"
                    :step="0.1"
                    @update:value="updateHeight(1, $event)"
                />
            </label>
        </div>
        <div class="ground-correction-panel__range" title="聚类连通与匹配半径（米）">
            <label>
                聚类半径
                <a-input-number
                    :value="clusterRadius"
                    :controls="false"
                    :min="0.01"
                    :step="0.1"
                    @update:value="updateClusterRadius"
                />
            </label>
            <label title="BEV 拾取平面的绝对 Z（原点为后轴中心，地面约为 -轮胎半径）">
                拾取 Z
                <a-input-number
                    :value="pickZ"
                    :controls="false"
                    :step="0.05"
                    @update:value="updatePickZ"
                />
            </label>
            <label title="聚类只包含拾取 Z 上下该范围内的点（米），防止串到车辆等目标">
                高度带±
                <a-input-number
                    :value="clusterHeightTolerance"
                    :controls="false"
                    :min="0.01"
                    :step="0.05"
                    @update:value="updateClusterHeightTolerance"
                />
            </label>
        </div>
        <span class="item" title="区域：点击顶点，双击或 Enter 提交" @click="startPolygon">
            <i class="iconfont icon-polygon1"></i>
            <span class="title">区域</span>
        </span>
        <span class="item" title="笔刷：拖动采样，松开鼠标提交" @click="startBrush">
            <i class="iconfont icon-biaozhunkuang"></i>
            <span class="title">笔刷</span>
        </span>
        <span class="item" title="聚类：点击点云一键选中连通点集" @click="startCluster">
            <i class="iconfont icon-biaozhunkuang"></i>
            <span class="title">聚类</span>
        </span>
        <span class="item" title="橡皮擦：拖动擦除误纠正为地面的点，恢复原分类" @click="startEraser">
            <i class="iconfont icon-shanchuicon"></i>
            <span class="title">橡皮</span>
        </span>
        <span class="item" title="将当前帧所有低于 拾取 Z - 0.1m 的点归为地面" @click="applyBelowGround">
            <i class="iconfont icon-fuzhuxian"></i>
            <span class="title">下压</span>
        </span>
        <span class="item" title="删除当前帧最后一条纠正操作" @click="deleteLast">
            <i class="iconfont icon-shanchuicon"></i>
            <span class="title">撤销</span>
        </span>
        <span class="item" title="应用当前帧纠正到前后 N 帧" @click="propagate">
            <i class="iconfont icon-fuzhuxian"></i>
            <span class="title">应用帧</span>
        </span>
        <span class="item" title="退出地面纠正模式" @click="exitMode">
            <i class="iconfont icon-xianshi"></i>
            <span class="title">退出</span>
        </span>
    </div>
</template>

<script setup lang="ts">
    import { computed } from 'vue';
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

    function deleteLast(): void {
        editor.groundCorrectionMaskManager.deleteLastOperation();
    }

    function propagate(): void {
        requestGroundCorrectionMaskPropagation(editor, () =>
            window.prompt('应用到前后多少帧？', '1'),
        );
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
        display: flex;
        flex-direction: column;
        align-items: center;

        &__range {
            display: flex;
            flex-direction: column;
            gap: 4px;
            width: 52px;
            margin-bottom: 4px;

            label {
                color: #bec1ca;
                font-size: 10px;
                line-height: 1;
            }

            .ant-input-number {
                width: 52px;
                margin-top: 2px;
            }
        }
    }
</style>
