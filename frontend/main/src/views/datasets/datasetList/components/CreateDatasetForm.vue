<template>
  <BasicModal
    :title="t('business.dataset.createDataset')"
    @register="registerCreateModal"
    :visible="false"
    :okText="t('common.createText')"
    :ok-button-props="{ type: 'primary' }"
    :bodyStyle="{
      height: '420px',
    }"
    @ok="handleOk"
  >
    <div :class="`${prefixCls}`">
      <BasicForm @register="registerForm" :showActionButtonGroup="false" :hideRequiredMark="true">
        <template #abcSlot="{ model, field }">
          <div class="datasetForm">
            <FormItem :label="t('business.dataset.datasetType')" labelAlign="left">
              <!-- <Tag color="#86AFFE">{{ model[field] }}</Tag> -->
            </FormItem>
            <FormItem name="type" :wrapperCol="{ span: 24 }">
              <Radio.Group class="img-radio" v-model:value="model[field]">
                <Radio :value="datasetTypeEnum.LIDAR_FUSION">
                  <div class="img-tool-form">
                    <img src="../../../../assets/images/dataset/lidar_fusion.png" alt="" />
                    <div class="img-title">{{ t('business.dataset.lidarFusion') }}</div>
                  </div>
                </Radio>
                <Radio :value="datasetTypeEnum.LIDAR_BASIC">
                  <div class="img-tool-form">
                    <img src="../../../../assets/images/dataset/lidar_basic.png" alt="" />
                    <div class="img-title">{{ t('business.dataset.lidarBasic') }}</div>
                  </div>
                </Radio>
                <Radio :value="datasetTypeEnum.IMAGE">
                  <div class="img-tool-form">
                    <img src="../../../../assets/images/dataset/image_type.png" alt="" />
                    <div class="img-title">{{ t('common.imageText') }}</div>
                  </div>
                </Radio>
                <Radio :value="datasetTypeEnum.TEXT">
                  <div class="img-tool-form">
                    <img src="../../../../assets/images/dataset/text_type.png" alt="" />
                    <div class="img-title">Text</div>
                  </div>
                </Radio>
              </Radio.Group>
            </FormItem>
            <FormItem v-if="model[field] === datasetTypeEnum.LIDAR_FUSION" :wrapperCol="{ span: 24 }">
              <Checkbox v-model:checked="syncMode">{{ t('business.dataset.syncMode') }}</Checkbox>
              <div class="sync-mode-tip">{{ t('business.dataset.syncModeTip') }}</div>
            </FormItem>
            <FormItem
              v-if="model[field] === datasetTypeEnum.LIDAR_FUSION && syncMode"
              :wrapperCol="{ span: 24 }"
            >
              <Checkbox v-model:checked="inferenceMode" disabled>
                {{ t('business.dataset.inferenceMode') }}
              </Checkbox>
              <div class="sync-mode-tip">
                {{ t('business.dataset.inferenceCreateTip') }}
              </div>
            </FormItem>
          </div>
        </template>
      </BasicForm>
    </div>
  </BasicModal>
</template>
<script lang="ts" setup>
  import { Form, Radio, Checkbox } from 'ant-design-vue';
  import { ref } from 'vue';
  import { useI18n } from '/@/hooks/web/useI18n';
  import { useDesign } from '/@/hooks/web/useDesign';
  import { datasetTypeEnum } from '/@/api/business/model/datasetModel';
  import { BasicForm } from '/@/components/Form';
  import { createForm } from './formSchemas';
  import { useForm } from '/@/components/Form';
  import { createDatasetApi } from '/@/api/business/dataset';
  import { BasicModal, useModalInner } from '/@/components/Modal';
  import { RouteChildEnum } from '/@/enums/routeEnum';
  import { useMessage } from '/@/hooks/web/useMessage';
  import { useGo } from '/@/hooks/web/usePage';
  import { setDatasetBreadcrumb } from '/@/utils/business';
  const FormItem = Form.Item;
  const go = useGo();
  const { createMessage } = useMessage();
  const { prefixCls } = useDesign('create-dataset-form');
  const { t } = useI18n();
  const [registerForm, { validate, resetFields }] = useForm({
    schemas: createForm,
    labelCol: { span: 6 },
    wrapperCol: { span: 12 },
    labelAlign: 'left',
  });
  const [registerCreateModal, { closeModal: closeCreateModal, changeOkLoading }] = useModalInner();
  const syncMode = ref(false);
  const inferenceMode = ref(false);
  // defineProps({
  //   registerForm: { type: Object as any, required: true },
  // });
  const handleOk = async () => {
    changeOkLoading(true);
    try {
      const data = await validate();
      const res = await createDatasetApi({
        ...data,
        syncMode: data.type === datasetTypeEnum.LIDAR_FUSION ? syncMode.value : false,
        inferenceMode: false,
      });
      if (res) {
        closeCreateModal();
        resetFields();
        syncMode.value = false;
        inferenceMode.value = false;
        changeOkLoading(false);
        createMessage.success(t('action.createSuccess'));
        setDatasetBreadcrumb(res.name, res.type);
        go(RouteChildEnum.DATASETS_DATA + '?id=' + res.id);
      }
    } catch (e) {
      changeOkLoading(false);
    }
  };
</script>
<style lang="less" scoped>
  @import url(./createDatasetForm.less);
</style>
