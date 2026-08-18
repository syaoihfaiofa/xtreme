<template>
  <BasicModal
    v-bind="$attrs"
    :title="t('business.dataset.settingsTitle')"
    :okText="t('common.saveText')"
    :width="900"
    :bodyStyle="{ maxHeight: '68vh', overflowY: 'auto' }"
    destroyOnClose
    @register="registerModal"
    @ok="handleSave"
  >
    <Spin :spinning="loading">
      <Form
        v-if="dataset"
        :model="formState"
        :label-col="{ span: 7 }"
        :wrapper-col="{ span: 15 }"
      >
        <Alert
          v-if="!canEnableInference"
          class="mb-4"
          type="warning"
          show-icon
          :message="t('business.dataset.inferenceSyncRequired')"
        />

        <Form.Item :label="t('business.dataset.inferenceMode')">
          <Switch
            v-model:checked="formState.inferenceMode"
            :disabled="!canEnableInference"
          />
        </Form.Item>

        <template v-if="formState.inferenceMode">
          <Form.Item :label="t('business.dataset.inferenceModel')" required>
            <Select
              v-model:value="formState.modelId"
              :placeholder="t('business.dataset.selectInferenceModel')"
              @change="handleModelChange"
            >
              <Select.Option v-for="model in models" :key="model.id" :value="model.id">
                {{ model.name }}
              </Select.Option>
            </Select>
          </Form.Item>

          <Form.Item :label="t('business.dataset.syncDistance')" required>
            <InputNumber
              v-model:value="formState.syncDistance"
              :min="0.1"
              :max="1000"
              :step="0.1"
              style="width: 180px"
            />
            <span class="unit">{{ t('business.dataset.meters') }}</span>
          </Form.Item>

          <Form.Item :label="t('business.dataset.maxOutsideFrames')" required>
            <InputNumber
              v-model:value="formState.maxOutsideFrames"
              :min="1"
              :max="100000"
              :precision="0"
              style="width: 180px"
            />
          </Form.Item>

          <Form.Item :label="t('business.dataset.associationIou')" required>
            <InputNumber
              v-model:value="formState.associationIou"
              :min="0"
              :max="1"
              :step="0.05"
              style="width: 180px"
            />
          </Form.Item>

          <Form.Item :label="t('business.dataset.minConfidence')" required>
            <InputNumber
              v-model:value="formState.minConfidence"
              :min="0"
              :max="1"
              :step="0.05"
              style="width: 180px"
            />
          </Form.Item>

          <Form.Item
            :label="t('business.dataset.classMappings')"
            required
            :wrapper-col="{ span: 17 }"
          >
            <div v-if="mappingRows.length === 0" class="empty-tip">
              {{ t('business.dataset.noModelClasses') }}
            </div>
            <div v-else class="mapping-list">
              <div class="mapping-header">
                <span>{{ t('business.dataset.modelClass') }}</span>
                <span>{{ t('business.dataset.datasetClass') }}</span>
                <span>{{ t('business.dataset.motionMode') }}</span>
              </div>
              <div v-for="row in mappingRows" :key="row.code" class="mapping-row">
                <Checkbox v-model:checked="row.selected">
                  <span class="class-name">{{ row.name }}</span>
                  <span class="class-code">{{ row.code }}</span>
                </Checkbox>
                <Select
                  v-model:value="row.datasetClassId"
                  :disabled="!row.selected"
                  :placeholder="t('business.dataset.selectDatasetClass')"
                >
                  <Select.Option
                    v-for="datasetClass in datasetClasses"
                    :key="datasetClass.id"
                    :value="datasetClass.id"
                  >
                    {{ datasetClass.name }}
                  </Select.Option>
                </Select>
                <Select v-model:value="row.motionMode" :disabled="!row.selected">
                  <Select.Option
                    v-for="option in motionModeOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </Select.Option>
                </Select>
              </div>
            </div>
          </Form.Item>
        </template>
      </Form>
    </Spin>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { computed, inject, reactive, ref } from 'vue';
  import {
    Alert,
    Checkbox,
    Form,
    InputNumber,
    Select,
    Spin,
    Switch,
  } from 'ant-design-vue';
  import { getDatasetClassApi } from '/@/api/business/classes';
  import { datasetItemDetail, updateDataset } from '/@/api/business/dataset';
  import {
    DatasetClassMapping,
    DatasetInferenceConfig,
    DatasetListItem,
    datasetTypeEnum,
    MotionMode,
  } from '/@/api/business/model/datasetModel';
  import {
    ModelClassItem,
    ModelListItem,
    ModelType,
    ResponseModelParams,
  } from '/@/api/business/model/modelsModel';
  import { datasetClassItem } from '/@/api/business/model/classesModel';
  import { getModelByIdApi, getModelPageApi } from '/@/api/business/models';
  import { BasicModal, useModalInner } from '/@/components/Modal';
  import { useI18n } from '/@/hooks/web/useI18n';
  import { useMessage } from '/@/hooks/web/useMessage';

  interface ModalData {
    datasetId: number;
  }

  interface MappingRow {
    code: string;
    name: string;
    selected: boolean;
    datasetClassId?: number;
    motionMode: MotionMode;
  }

  interface SettingsFormState {
    inferenceMode: boolean;
    modelId?: number;
    syncDistance: number;
    maxOutsideFrames: number;
    associationIou: number;
    minConfidence: number;
  }

  const DEFAULT_SYNC_DISTANCE = 12;
  const DEFAULT_MAX_OUTSIDE_FRAMES = 50;
  const DEFAULT_ASSOCIATION_IOU = 0.3;
  const DEFAULT_MIN_CONFIDENCE = 0.5;

  const { t } = useI18n();
  const { createMessage } = useMessage();
  const loading = ref<boolean>(false);
  const dataset = ref<DatasetListItem>();
  const models = ref<ModelListItem[]>([]);
  const datasetClasses = ref<datasetClassItem[]>([]);
  const mappingRows = ref<MappingRow[]>([]);
  const formState = reactive<SettingsFormState>({
    inferenceMode: false,
    modelId: undefined,
    syncDistance: DEFAULT_SYNC_DISTANCE,
    maxOutsideFrames: DEFAULT_MAX_OUTSIDE_FRAMES,
    associationIou: DEFAULT_ASSOCIATION_IOU,
    minConfidence: DEFAULT_MIN_CONFIDENCE,
  });
  const fetchList = inject<() => void>('fetchList');

  const canEnableInference = computed<boolean>(
    () =>
      dataset.value?.type === datasetTypeEnum.LIDAR_FUSION &&
      dataset.value?.syncMode === true,
  );

  const motionModeOptions = computed(() => [
    { value: MotionMode.STATIC, label: t('business.dataset.motionStatic') },
    {
      value: MotionMode.DYNAMIC_FIXED_SIZE,
      label: t('business.dataset.motionDynamicFixedSize'),
    },
    {
      value: MotionMode.DYNAMIC_VARIABLE_SIZE,
      label: t('business.dataset.motionDynamicVariableSize'),
    },
  ]);

  const [registerModal, { closeModal, changeOkLoading }] = useModalInner(
    (data: ModalData) => {
      void loadSettings(data.datasetId);
    },
  );

  function normalizeModelName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function getModelList(response: ResponseModelParams): ModelListItem[] {
    if (Array.isArray(response)) {
      return response;
    }
    return response.list;
  }

  function buildMappingRows(
    classes: ModelClassItem[],
    mappings: DatasetClassMapping[],
  ): MappingRow[] {
    const mappingByCode = new Map<string, DatasetClassMapping>(
      mappings.map((mapping) => [mapping.modelClassCode, mapping]),
    );
    const classByCode = new Map<string, ModelClassItem>(
      classes.filter((item) => item.code).map((item) => [item.code, item]),
    );

    mappings.forEach((mapping) => {
      if (!classByCode.has(mapping.modelClassCode)) {
        classByCode.set(mapping.modelClassCode, {
          code: mapping.modelClassCode,
          name: mapping.modelClassCode,
        });
      }
    });

    return Array.from(classByCode.values()).map((modelClass) => {
      const mapping = mappingByCode.get(modelClass.code);
      return {
        code: modelClass.code,
        name: modelClass.name,
        selected: Boolean(mapping),
        datasetClassId: mapping?.datasetClassId,
        motionMode: mapping?.motionMode ?? MotionMode.STATIC,
      };
    });
  }

  async function loadModelClasses(
    modelId: number,
    mappings: DatasetClassMapping[],
  ): Promise<void> {
    const model = await getModelByIdApi({ id: modelId });
    const modelIndex = models.value.findIndex((item) => item.id === model.id);
    if (modelIndex >= 0) {
      models.value[modelIndex] = model;
    }
    mappingRows.value = buildMappingRows(model.classes ?? [], mappings);
  }

  async function loadSettings(datasetId: number): Promise<void> {
    loading.value = true;
    mappingRows.value = [];
    try {
      const [datasetInfo, modelResponse, classResponse] = await Promise.all([
        datasetItemDetail({ id: datasetId }),
        getModelPageApi({
          pageNo: 1,
          pageSize: 1000,
          datasetType: datasetTypeEnum.LIDAR,
          isInteractive: 0,
        }),
        getDatasetClassApi({ datasetId, pageNo: 1, pageSize: 1000 }),
      ]);

      dataset.value = datasetInfo;
      models.value = getModelList(modelResponse).filter(
        (model) => model.modelType === ModelType.DETECTION,
      );
      datasetClasses.value = classResponse.list;

      const config = datasetInfo.inferenceConfig;
      formState.inferenceMode = datasetInfo.inferenceMode === true && canEnableInference.value;
      formState.modelId =
        config?.modelId ??
        models.value.find((model) => normalizeModelName(model.name).includes('bevfusion'))?.id;
      formState.syncDistance = config?.syncDistance ?? DEFAULT_SYNC_DISTANCE;
      formState.maxOutsideFrames =
        config?.maxOutsideFrames ?? DEFAULT_MAX_OUTSIDE_FRAMES;
      formState.associationIou = config?.associationIou ?? DEFAULT_ASSOCIATION_IOU;
      formState.minConfidence = config?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

      if (formState.modelId) {
        await loadModelClasses(formState.modelId, config?.classMappings ?? []);
      }
    } catch (error) {
      createMessage.error(t('business.dataset.settingsLoadFailed'));
    } finally {
      loading.value = false;
    }
  }

  async function handleModelChange(modelId: number): Promise<void> {
    loading.value = true;
    try {
      await loadModelClasses(modelId, []);
    } catch (error) {
      mappingRows.value = [];
      createMessage.error(t('business.dataset.modelClassesLoadFailed'));
    } finally {
      loading.value = false;
    }
  }

  function isNumberInRange(value: number, min: number, max: number): boolean {
    return Number.isFinite(value) && value >= min && value <= max;
  }

  function validateSettings(): DatasetInferenceConfig | undefined {
    if (!formState.inferenceMode) {
      return undefined;
    }
    if (!canEnableInference.value) {
      createMessage.error(t('business.dataset.inferenceSyncRequired'));
      return undefined;
    }
    if (!formState.modelId) {
      createMessage.error(t('business.dataset.modelRequired'));
      return undefined;
    }
    if (!isNumberInRange(formState.syncDistance, 0.1, 1000)) {
      createMessage.error(t('business.dataset.syncDistanceInvalid'));
      return undefined;
    }
    if (
      !Number.isInteger(formState.maxOutsideFrames) ||
      !isNumberInRange(formState.maxOutsideFrames, 1, 100000)
    ) {
      createMessage.error(t('business.dataset.maxOutsideFramesInvalid'));
      return undefined;
    }
    if (!isNumberInRange(formState.associationIou, 0, 1)) {
      createMessage.error(t('business.dataset.associationIouInvalid'));
      return undefined;
    }
    if (!isNumberInRange(formState.minConfidence, 0, 1)) {
      createMessage.error(t('business.dataset.minConfidenceInvalid'));
      return undefined;
    }

    const selectedMappings = mappingRows.value.filter((row) => row.selected);
    if (selectedMappings.length === 0) {
      createMessage.error(t('business.dataset.mappingRequired'));
      return undefined;
    }
    if (selectedMappings.some((row) => !row.datasetClassId)) {
      createMessage.error(t('business.dataset.datasetClassRequired'));
      return undefined;
    }

    return {
      modelId: formState.modelId,
      syncDistance: formState.syncDistance,
      maxOutsideFrames: formState.maxOutsideFrames,
      associationIou: formState.associationIou,
      minConfidence: formState.minConfidence,
      classMappings: selectedMappings.map((row) => ({
        modelClassCode: row.code,
        datasetClassId: row.datasetClassId as number,
        motionMode: row.motionMode,
      })),
    };
  }

  async function handleSave(): Promise<void> {
    if (!dataset.value) {
      return;
    }
    const inferenceConfig = validateSettings();
    if (formState.inferenceMode && !inferenceConfig) {
      return;
    }

    changeOkLoading(true);
    try {
      await updateDataset({
        id: dataset.value.id,
        name: dataset.value.name,
        syncMode: dataset.value.syncMode === true,
        inferenceMode: formState.inferenceMode,
        ...(inferenceConfig ? { inferenceConfig } : {}),
      });
      createMessage.success(t('business.dataset.settingsSaveSuccess'));
      closeModal();
      fetchList?.();
    } finally {
      changeOkLoading(false);
    }
  }
</script>

<style lang="less" scoped>
  .unit {
    margin-left: 8px;
    color: #666;
  }

  .empty-tip {
    padding: 16px;
    color: #999;
    text-align: center;
    border: 1px dashed #ddd;
    border-radius: 6px;
  }

  .mapping-list {
    border: 1px solid #eee;
    border-radius: 6px;
    overflow: hidden;
  }

  .mapping-header,
  .mapping-row {
    display: grid;
    grid-template-columns: minmax(180px, 1.2fr) minmax(160px, 1fr) minmax(190px, 1fr);
    gap: 12px;
    align-items: center;
    padding: 10px 12px;
  }

  .mapping-header {
    color: #666;
    font-weight: 500;
    background: #fafafa;
  }

  .mapping-row {
    border-top: 1px solid #eee;
  }

  .class-name {
    margin-right: 6px;
  }

  .class-code {
    color: #999;
    font-size: 12px;
  }
</style>
