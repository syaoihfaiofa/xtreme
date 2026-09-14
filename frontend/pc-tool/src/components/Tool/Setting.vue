<template>
    <div class="setting">
        <div class="title1 border-bottom">{{ $$('setting_display') }}</div>
        <div class="wrap">
            <!-- image -->
            <div class="title2">
                <span style="vertical-align: middle; margin-right: 10px">{{
                    $$('setting_imgview')
                }}</span>
                <!-- <div class="divider"></div> -->
            </div>
            <div class="wrap">
                <div style="padding: 6px 0px">
                    <a-checkbox
                        v-if="state.config.projectPoint4"
                        v-model:checked="state.config.renderRect"
                        >{{ $$('setting_rect') }}</a-checkbox
                    >
                    <a-checkbox
                        v-if="state.config.projectPoint8"
                        v-model:checked="state.config.renderBox"
                        >{{ $$('setting_box') }}</a-checkbox
                    >

                    <a-checkbox
                        v-if="state.config.projectMap3d"
                        v-model:checked="state.config.renderProjectBox"
                        >{{ $$('setting_projectbox') }}</a-checkbox
                    >
                    <a-checkbox v-model:checked="state.config.renderProjectPoint">{{
                        $$('setting_projectpoint')
                    }}</a-checkbox>
                </div>
            </div>
            <!-- pointCloud background color-->
            <div class="title2">
                <span style="vertical-align: middle; margin-right: 10px">{{
                    $$('setting_backgroundColor')
                }}</span>
                <!-- <div class="divider"></div> -->
            </div>
            <div class="wrap">
                <a-tooltip trigger="click" placement="topLeft">
                    <template #title>
                        <color-picker
                            :isWidget="true"
                            pickerType="chrome"
                            useType="pure"
                            :disableAlpha="true"
                            :disableHistory="true"
                            v-model:pureColor="iState.backgroudColor"
                            @pureColorChange="updateBackgroundColor"
                        />
                    </template>
                    <div
                        style="
                            height: 16px;
                            display: inline-block;
                            width: 16px;
                            border: 1px solid white;
                        "
                        :style="{ background: iState.backgroudColor }"
                    ></div>
                </a-tooltip>
                <a-button type="dashed" class="reset" size="small" @click="onResetBg">{{
                    $$('setting_pointreset')
                }}</a-button>
            </div>
            <!-- show point -->
            <div class="title2">
                <span style="vertical-align: middle; margin-right: 10px">{{
                    $$('setting_pointview')
                }}</span>
                <!-- <div class="divider"></div> -->
            </div>
            <div class="wrap">
                <div class="title3"
                    >{{ $$('setting_pointsize')
                    }}<a-button type="dashed" class="reset" size="small" @click="onResetSize">{{
                        $$('setting_pointreset')
                    }}</a-button>
                </div>
                <a-slider
                    style="width: 200px; margin: 0px; margin-top: 5px"
                    v-model:value="config.pointSize"
                    :tip-formatter="formatter"
                    :min="1"
                    :max="10"
                    :step="0.1"
                    @change="() => update('pointSize')"
                />
                <div class="title3"
                    >{{ $$('setting_brightness')
                    }}<a-button
                        type="dashed"
                        class="reset"
                        size="small"
                        @click="onResetBrightness"
                        >{{ $$('setting_pointreset') }}</a-button
                    >
                </div>
                <a-slider
                    style="width: 200px; margin: 0px; margin-top: 5px"
                    v-model:value="config.brightness"
                    :tip-formatter="formatter"
                    :min="0.1"
                    :max="2"
                    :step="0.1"
                    @change="() => update('brightness')"
                />
            </div>
            <div class="wrap">
                <div class="title3"
                    >{{ $$('setting_pointcolor') }}
                    <br />
                    <a-radio-group
                        v-model:value="config.pointColorMode"
                        size="small"
                        style="font-size: 12px; margin-top: 5px"
                    >
                        <a-radio-button
                            style="width: 80px; text-align: center"
                            :value="ColorModeEnum.PURE"
                        >
                            {{ $$('setting_colorsingle') }}
                        </a-radio-button>
                        <a-radio-button
                            style="width: 80px; text-align: center"
                            :value="ColorModeEnum.HEIGHT"
                        >
                            {{ $$('setting_colorheight') }}
                        </a-radio-button>

                        <a-radio-button
                            v-if="config.pointInfo.hasRGB"
                            style="width: 100px; text-align: center"
                            :value="ColorModeEnum.RGB"
                        >
                            {{ 'RGB' }}
                        </a-radio-button>
                    </a-radio-group>
                </div>
            </div>
            <div
                class="wrap"
                v-if="config.pointInfo.hasRGB && config.pointColorMode === ColorModeEnum.RGB"
            >
                <div class="title3">
                    车道线 RGB 增强
                    <a-switch
                        size="small"
                        style="margin-top: 5px; float: right"
                        v-model:checked="config.rgbEnhance"
                    />
                </div>
                <div class="title3" style="padding-top: 8px">
                    隐藏 RGB=intensity 非地面点
                    <a-switch
                        size="small"
                        style="margin-top: 5px; float: right"
                        v-model:checked="config.hideNonGroundRgb"
                    />
                </div>
                <template v-if="config.rgbEnhance">
                    <div class="title3" style="padding-top: 8px">
                        地面 RGB 增强半径（以原点）
                    </div>
                    <a-slider
                        style="width: 200px; margin: 0px; margin-top: 5px"
                        v-model:value="config.rgbEnhanceRadius"
                        :tip-formatter="formatter"
                        :min="1"
                        :max="100"
                        :step="1"
                        @change="() => update('rgbEnhanceRadius')"
                    />
                    <div class="title3" style="padding-top: 8px">
                        地面 RGB 对比度
                    </div>
                    <a-slider
                        style="width: 200px; margin: 0px; margin-top: 5px"
                        v-model:value="config.rgbEnhanceContrast"
                        :tip-formatter="formatter"
                        :min="1"
                        :max="10"
                        :step="0.1"
                        @change="() => update('rgbEnhanceContrast')"
                    />
                    <div class="title3" style="padding-top: 8px">
                        RGB 增强最低亮度
                    </div>
                    <a-slider
                        style="width: 200px; margin: 0px; margin-top: 5px"
                        v-model:value="config.rgbEnhanceMinBrightness"
                        :tip-formatter="formatter"
                        :min="0.02"
                        :max="0.3"
                        :step="0.01"
                        @change="() => update('rgbEnhanceMinBrightness')"
                    />
                </template>
                <div class="title3" style="padding-top: 8px">
                    地面局部 RGB 对比度
                    <a-switch
                        size="small"
                        style="margin-top: 5px; float: right"
                        v-model:checked="config.rgbLocalContrast"
                    />
                </div>
                <div v-if="config.rgbLocalContrast" class="title3" style="padding-top: 8px">
                    局部对比度强度
                </div>
                <a-slider
                    v-if="config.rgbLocalContrast"
                    style="width: 200px; margin: 0px; margin-top: 5px"
                    v-model:value="config.rgbLocalContrastStrength"
                    :tip-formatter="formatter"
                    :min="1"
                    :max="10"
                    :step="0.1"
                    @change="() => update('rgbLocalContrastStrength')"
                />
                <div class="title3" style="padding-top: 8px">
                    RGB 高亮点增强
                    <a-switch
                        size="small"
                        style="margin-top: 5px; float: right"
                        v-model:checked="config.rgbHighlightBoost"
                    />
                </div>
                <div v-if="config.rgbHighlightBoost" class="title3" style="padding-top: 8px">
                    高亮亮度阈值
                </div>
                <a-slider
                    v-if="config.rgbHighlightBoost"
                    style="width: 200px; margin: 0px; margin-top: 5px"
                    v-model:value="config.rgbHighlightThreshold"
                    :tip-formatter="formatter"
                    :min="0"
                    :max="1"
                    :step="0.01"
                    @change="() => update('rgbHighlightThreshold')"
                />
                <div v-if="config.rgbHighlightBoost" class="title3" style="padding-top: 8px">
                    高亮增强强度
                </div>
                <a-slider
                    v-if="config.rgbHighlightBoost"
                    style="width: 200px; margin: 0px; margin-top: 5px"
                    v-model:value="config.rgbHighlightStrength"
                    :tip-formatter="formatter"
                    :min="0.01"
                    :max="10"
                    :step="0.01"
                    @change="() => update('rgbHighlightStrength')"
                />
                <div class="title3" style="padding-top: 8px">
                    P 标注三视图对比半径
                </div>
                <a-slider
                    style="width: 200px; margin: 0px; margin-top: 5px"
                    v-model:value="config.sideViewContrastRadius"
                    :tip-formatter="formatter"
                    :min="0.1"
                    :max="10"
                    :step="0.1"
                    @change="() => update('sideViewContrastRadius')"
                />
                <div class="parking-density">
                    <div class="title3" style="padding-top: 12px">
                        停车位 RGB 点云密集
                    </div>
                    <div class="title3" style="padding-top: 6px">
                        邻帧运动补偿（仅地面点）
                        <a-switch
                            size="small"
                            style="margin-top: 5px; float: right"
                            v-model:checked="config.parkingDensityMotion"
                        />
                    </div>
                    <div v-if="config.parkingDensityMotion">
                        <div class="title3" style="padding-top: 6px">
                            前后帧数
                            <a-input-number
                                v-model:value="config.parkingDensityFrameCount"
                                size="small"
                                :min="0"
                                :max="5"
                                :precision="0"
                                style="width: 64px; float: right"
                            />
                        </div>
                        <div class="title3" style="padding-top: 8px">邻帧显示方式</div>
                        <a-radio-group v-model:value="config.parkingDensityStyle" size="small">
                            <a-radio-button value="rgb">RGB 半透明</a-radio-button>
                            <a-radio-button value="gray">灰色半透明</a-radio-button>
                            <a-radio-button value="same">同样显示</a-radio-button>
                        </a-radio-group>
                        <div v-if="config.parkingDensityStyle !== 'same'" class="title3" style="padding-top: 8px">
                            邻帧透明度
                        </div>
                        <a-slider
                            v-if="config.parkingDensityStyle !== 'same'"
                            style="width: 200px; margin: 0px; margin-top: 5px"
                            v-model:value="config.parkingDensityOpacity"
                            :min="0.1"
                            :max="1"
                            :step="0.05"
                            :tip-formatter="formatter"
                        />
                    </div>
                    <div class="title3" style="padding-top: 9px">
                        当前帧地面视觉增密
                        <a-switch
                            size="small"
                            style="margin-top: 5px; float: right"
                            v-model:checked="config.parkingDensityGround"
                        />
                    </div>
                    <div v-if="config.parkingDensityGround" class="title3" style="padding-top: 8px">
                        地面点大小倍数（主点云与三视图同步）
                    </div>
                    <a-slider
                        v-if="config.parkingDensityGround"
                        style="width: 200px; margin: 0px; margin-top: 5px"
                        v-model:value="config.parkingDensityGroundScale"
                        :min="1"
                        :max="4"
                        :step="0.1"
                        :tip-formatter="formatter"
                    />
                </div>
            </div>
            <ColorSlider />
            <div class="wrap" v-if="config.pointInfo.hasIntensity">
                <div class="title3"
                    >{{ $$('setting_colorintensity') }}
                    <a-switch
                        size="small"
                        style="margin-top: 5px; float: right"
                        v-model:checked="state.config.openIntensity"
                    />
                </div>
                <div class="title3" style="padding-top: 10px">
                    <a-input-number
                        v-model:value="config.pointIntensity[0]"
                        size="small"
                        :min="0"
                        :max="255"
                        style="width: 80px"
                    ></a-input-number>
                    <a-input-number
                        v-model:value="config.pointIntensity[1]"
                        size="small"
                        :min="0"
                        :max="255"
                        style="width: 80px"
                    ></a-input-number>
                    <a-button
                        :title="$$('setting_pointreset')"
                        size="small"
                        style="border: none"
                        @click="onResetIntensity"
                    >
                        <template #icon>
                            <RetweetOutlined />
                        </template>
                    </a-button>
                </div>
                <div style="margin: 5px 0 0 5px; margin-top: 5px; width: 180px" class="title3">
                    <a-slider
                        range
                        v-model:value="config.pointIntensity"
                        :min="0"
                        :max="255"
                        :step="0.1"
                    />
                </div>
            </div>
            <div class="title2" v-if="!_config.noUtility">
                <span style="vertical-align: middle; margin-right: 10px">{{ $$('utility') }}</span>
                <!-- <div class="divider"></div> -->
            </div>
            <div class="wrap" v-if="!_config.noUtility">
                <div class="title3"
                    >{{ $$('measure') }}
                    <a-switch
                        v-model:checked="iState.measureOpen"
                        @change="onMeasureSwitch"
                        size="small"
                        style="float: right; margin-top: 5px"
                    />
                </div>
                <div v-for="item in iState.measureConfig" :key="item.id" class="title3">
                    {{ $$('measure_radius') }}
                    <a-button
                        size="small"
                        @click="() => delMeasure(item.id)"
                        style="float: right; border: none"
                    >
                        <template #icon>
                            <DeleteOutlined />
                        </template>
                    </a-button>
                    <a-input-number
                        style="width: 100px; float: right"
                        size="small"
                        :min="0"
                        :max="999"
                        @change="() => updateMeasure(item.id)"
                        v-model:value="item.radius"
                    />
                </div>
                <div class="title3">
                    <a-button size="small" style="width: 100%" @click="addMeasure">
                        <template #icon>
                            <PlusOutlined />
                        </template>
                        {{ $$('measure_add') }}
                    </a-button>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import { watch, onMounted, reactive, ref, computed } from 'vue';
    import * as THREE from 'three';
    import { DeleteOutlined, PlusOutlined } from '@ant-design/icons-vue';
    // import { getColorRange } from '../../utils';
    import * as _ from 'lodash';
    import { useInjectState, useInjectEditor } from '../../state';
    // import useRenderConfig from '../hook/useRenderConfig';
    import { RetweetOutlined } from '@ant-design/icons-vue';
    import { PointsMaterial, Event, Image2DRenderView } from 'pc-render';
    // import useLang from '../../hook/useLang';
    import * as locale from './lang';
    import { IConfig } from './useTool';
    import ColorSlider from './colorSlider.vue';
    import { ColorModeEnum } from 'pc-editor';
    let editor = useInjectEditor();
    let $$ = editor.bindLocale(locale);
    let pc = editor.pc;
    let state = useInjectState();
    let config = state.config;
    const props = defineProps<{
        config?: IConfig;
    }>();
    const _config = computed(() => {
        return Object.assign({} as IConfig, props.config || {});
    });
    let countId = 0;
    interface IMeasure {
        id: number;
        radius: number;
    }

    // ***************Props and Emits***************
    const emit = defineEmits(['close']);

    // *********************************************
    const formatter = (value: number) => {
        return value.toFixed(2);
    };
    const iState = reactive({
        colorCodeBg: 'transparent',
        focusOne: false,
        measureOpen: false,
        measureConfig: [] as IMeasure[],
        backgroudColor: '#000',
    });
    onMounted(() => {
        onMeasureSwitch();
    });
    function onMeasureSwitch() {
        if (props.config?.noUtility) return;
        editor.pc.groupTrack.visible = iState.measureOpen;
        editor.pc.render();
    }
    function addMeasure() {
        if (props.config?.noUtility) return;
        const measureLine = {
            id: countId++,
            radius: 50,
        };
        iState.measureConfig.push(measureLine);
        editor.viewManager.addTrackCircle(measureLine.radius, {
            id: measureLine.id,
        });
    }
    function delMeasure(id: number) {
        if (props.config?.noUtility) return;
        iState.measureConfig = iState.measureConfig.filter((item: IMeasure) => item.id !== id);
        editor.viewManager.delTrackCircle(id);
    }
    function onResetBg() {
        iState.backgroudColor = '#000';
        updateBackgroundColor();
    }
    const updateMeasure = _.debounce((id: number) => {
        const item = iState.measureConfig.find((item: IMeasure) => item.id === id);
        if (item && isFinite(item.radius)) {
            editor.viewManager.updateTrackCircle(id, item.radius);
        }
    }, 200);
    const updateBackgroundColor = _.throttle(() => {
        editor.viewManager.updateBackgroundColor(iState.backgroudColor || '#000');
    }, 100);

    let update = _.throttle((type: string) => {
        let points = pc.groupPoints.children[0] as THREE.Points;
        let material = points.material as PointsMaterial;
        let options = {} as any;
        switch (type) {
            case 'pointSize':
                options.pointSize = config.pointSize;
                break;
            case 'colorType':
                options.colorMode = config.pointColorMode || 0;
                break;
            case 'intensity':
                options.openIntensity = config.openIntensity ? 1.0 : -1.0;
                break;
            case 'brightness':
                options.brightness = config.brightness;
                break;
            case 'rgbEnhance':
                options.rgbEnhance = config.rgbEnhance ? 1 : -1;
                break;
            case 'rgbEnhanceRadius':
                options.rgbEnhanceRadius = config.rgbEnhanceRadius;
                break;
            case 'rgbEnhanceContrast':
                options.rgbEnhanceContrast = config.rgbEnhanceContrast;
                break;
            case 'rgbEnhanceMinBrightness':
                options.rgbEnhanceMinBrightness = config.rgbEnhanceMinBrightness;
                break;
            case 'rgbLocalContrast':
                options.rgbLocalContrast = config.rgbLocalContrast ? 1 : -1;
                break;
            case 'rgbLocalContrastStrength':
                options.rgbLocalContrastStrength = config.rgbLocalContrastStrength;
                break;
            case 'rgbHighlightBoost':
                options.rgbHighlightBoost = config.rgbHighlightBoost ? 1 : -1;
                break;
            case 'rgbHighlightThreshold':
                options.rgbHighlightThreshold = config.rgbHighlightThreshold;
                break;
            case 'rgbHighlightStrength':
                options.rgbHighlightStrength = config.rgbHighlightStrength;
                break;
            case 'hideNonGroundRgb':
                options.hideNonGroundRgb = config.hideNonGroundRgb ? 1 : -1;
                break;
            case 'sideViewContrastRadius':
                options.sideViewContrastRadius = config.sideViewContrastRadius;
                break;
            case 'intensityRange':
                options.intensityRange = new THREE.Vector2(
                    config.pointIntensity[0],
                    config.pointIntensity[1],
                );
                break;
        }

        material.setUniforms(options);
        pc.render();
        // console.log('update config', type, options);
    }, 200);

    function onResetSize() {
        config.pointSize = 0.1;
        update('pointSize');
    }

    function onResetIntensity() {
        config.pointIntensity = [0, 255];
    }
    function onResetBrightness() {
        config.brightness = 1;
        update('brightness');
    }
    watch(
        () => config.pointColorMode,
        () => {
            update('colorType');
            editor.parkingDensityManager?.refresh();
        },
    );

    const refreshParkingDensity = _.debounce(() => editor.parkingDensityManager?.refresh(), 120);
    watch(
        () => [
            config.parkingDensityMotion,
            config.parkingDensityFrameCount,
            config.parkingDensityStyle,
            config.parkingDensityOpacity,
            config.parkingDensityGround,
            config.parkingDensityGroundScale,
            config.pointSize,
            config.brightness,
            config.rgbEnhance,
            config.rgbEnhanceRadius,
            config.rgbEnhanceContrast,
            config.rgbEnhanceMinBrightness,
            config.rgbLocalContrast,
            config.rgbLocalContrastStrength,
            config.rgbHighlightBoost,
            config.rgbHighlightThreshold,
            config.rgbHighlightStrength,
            config.hideNonGroundRgb,
        ],
        () => refreshParkingDensity(),
    );

    watch(
        () => [config.pointIntensity[0], config.pointIntensity[1]],
        () => {
            update('intensityRange');
        },
    );

    watch(
        () => config.openIntensity,
        () => {
            update('intensity');
        },
    );

    watch(
        () => config.rgbEnhance,
        () => {
            update('rgbEnhance');
        },
    );

    watch(
        () => config.rgbHighlightBoost,
        () => {
            update('rgbHighlightBoost');
        },
    );

    watch(
        () => config.rgbLocalContrast,
        () => {
            update('rgbLocalContrast');
        },
    );

    watch(
        () => config.hideNonGroundRgb,
        () => {
            update('hideNonGroundRgb');
        },
    );


    watch(
        () => [
            config.renderBox,
            config.renderRect,
            config.renderProjectBox,
            config.renderProjectPoint,
        ],
        () => {
            pc.renderViews.forEach((view) => {
                if (view instanceof Image2DRenderView) {
                    view.renderBox = false;
                    view.renderRect = config.renderRect && state.config.projectPoint4;
                    view.renderBox2D = config.renderBox && state.config.projectPoint8;
                    if (view.name === state.config.singleViewPrefix) {
                        view.renderPoints = config.renderProjectPoint;
                    }
                }
            });
            pc.render();
        },
    );

    // function

    function onClose() {
        emit('close');
    }
</script>

<style lang="less">
    .setting {
        .reset {
            border: 1px solid #6d7278;
            color: #6d7278;
            float: right;
            font-size: 12px;
        }
    }
</style>
