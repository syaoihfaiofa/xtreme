<template>
  <BasicModal
    v-bind="$attrs"
    @register="register"
    :title="t('business.datasetContent.scene.editScene')"
    :okText="t('common.confirmText')"
    @ok="handleSubmit"
    @visible-change="handleVisible"
  >
    <Form
      ref="form"
      hideRequiredMark
      class="form"
      :rules="rules"
      :model="formState"
      :label-col="labelCol"
      :wrapper-col="wrapperCol"
    >
      <Form.Item name="name" :label="t('common.newName')">
        <Input
          class="input-element"
          ref="inputRef"
          autocomplete="off"
          v-model:value="formState.name"
          @focus="handleFocus"
        />
      </Form.Item>
      <Form.Item name="detail" :label="t('business.datasetContent.scene.detail')">
        <Input.TextArea
          autocomplete="off"
          v-model:value="formState.detail"
          :rows="4"
          :maxlength="1000"
          showCount
        />
      </Form.Item>
    </Form>
  </BasicModal>
</template>
<script lang="ts" setup>
  import { ref, unref, defineEmits, inject } from 'vue';
  import { Form, Input } from 'ant-design-vue';
  import { useI18n } from '/@/hooks/web/useI18n';
  import { BasicModal, useModalInner } from '/@/components/Modal';
  import { updateSceneInfoApi } from '/@/api/business/dataset';
  import { useMessage } from '/@/hooks/web/useMessage';

  const form = ref();
  const inputRef = ref(null);
  const { createMessage } = useMessage();
  const [register, { closeModal, changeOkLoading }] = useModalInner((data) => {
    formState.value = { id: data.id, name: data.name, detail: data.detail || '' };
  });
  const { t } = useI18n();
  const emits = defineEmits(['success']);
  const formState = ref<{ id: string | number; name: string; detail: string }>({
    id: '',
    name: '',
    detail: '',
  });
  const rules = {
    name: [
      { required: true, message: 'Please input name', trigger: 'blur' },
      { max: 255, message: 'Please enter less than 255' },
    ],
  };

  const labelCol = { span: 6 };
  const wrapperCol = { span: 17 };
  const fetchList: any = inject('fetchList', null);

  const handleVisible = () => {
    setTimeout(() => {
      if (document.getElementsByClassName('input-element').length > 0) {
        document.getElementsByClassName('input-element')['name']?.focus();
      }
    }, 100);
  };

  const handleFocus = function (e) {
    e.target.setSelectionRange(0, e.target.value.length);
  };

  const handleSubmit = async () => {
    changeOkLoading(true);
    try {
      await unref(form)
        .validateFields()
        .then(async (values) => {
          await updateSceneInfoApi({
            id: formState.value.id,
            name: values.name,
            detail: values.detail,
          });
          createMessage.success(t('action.renameSuccess'));
          closeModal();
          changeOkLoading(false);
          emits('success');
          if (fetchList) fetchList();
        })
        .catch(() => {
          changeOkLoading(false);
        });
    } catch (e) {
      changeOkLoading(false);
    }
  };
</script>
<style scoped>
  .form {
    padding-top: 20px;
  }
</style>
