<template>
  <BasicModal
    v-bind="$attrs"
    @register="register"
    :title="t('business.datasetContent.scene.uploadLocation')"
    :footer="null"
    :width="480"
    @visible-change="handleVisible"
  >
    <div class="upload-location">
      <p class="upload-location__tip">{{ t('business.datasetContent.scene.uploadLocationTip') }}</p>
      <UploadDragger
        v-if="!uploading"
        :multiple="false"
        :showUploadList="false"
        accept=".txt"
        :beforeUpload="beforeUpload"
      >
        <SvgIcon size="60" name="upload" />
        <div class="dragger-placeholder">
          <span>{{ t('business.datasetContent.uploadModel.clickText') }}</span>
          <span>location.txt</span>
        </div>
      </UploadDragger>
      <div v-else class="upload-location__progress">
        <Spin />
        <span>{{ t('business.datasetContent.process.uploading') }}</span>
      </div>
    </div>
  </BasicModal>
</template>
<script lang="ts" setup>
  import { ref } from 'vue';
  import { Upload, Spin } from 'ant-design-vue';
  import { SvgIcon } from '/@/components/Icon';
  import { BasicModal, useModalInner } from '/@/components/Modal';
  import { useI18n } from '/@/hooks/web/useI18n';
  import { useMessage } from '/@/hooks/web/useMessage';
  import { uploadSceneLocationApi } from '/@/api/business/dataset';

  const UploadDragger = Upload.Dragger;

  const { t } = useI18n();
  const { createMessage } = useMessage();
  const uploading = ref(false);
  const sceneId = ref<string | number>('');

  const emits = defineEmits(['success']);
  const [register] = useModalInner((data) => {
    sceneId.value = data.id;
  });

  const handleVisible = (visible: boolean) => {
    if (!visible) uploading.value = false;
  };

  const beforeUpload = (file: File) => {
    if (!file.name.toLowerCase().endsWith('.txt')) {
      createMessage.error(t('business.datasetContent.scene.locationFileTypeError'));
      return false;
    }
    uploading.value = true;
    uploadSceneLocationApi(sceneId.value, file)
      .then((res: any) => {
        const result = res?.data || res;
        const matched = result?.matchedCount ?? 0;
        const total = result?.totalLines ?? 0;
        createMessage.success(`${t('business.datasetContent.scene.locationUploadSuccess')} ${matched}/${total}`);
        emits('success');
      })
      .catch((error) => {
        const message =
          error?.response?.data?.message || error?.message || t('business.datasetContent.scene.locationUploadFail');
        createMessage.error(message);
      })
      .finally(() => {
        uploading.value = false;
      });
    return false;
  };
</script>
<style scoped lang="less">
  .upload-location {
    padding: 10px 0 20px;

    &__tip {
      color: #999;
      font-size: 12px;
      margin-bottom: 12px;
    }

    :deep(.ant-upload-drag) {
      padding: 24px 0;
    }

    .dragger-placeholder {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 10px;
    }

    &__progress {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 40px 0;
    }
  }
</style>
