<template>
  <BasicModal
    v-bind="$attrs"
    @register="register"
    :title="t('business.datasetContent.backupLabelsTitle')"
    :width="560"
    :ok-text="t('business.datasetContent.startBackup')"
    @ok="handleBackup"
    :okButtonProps="{ loading: isLoading }"
  >
    <div class="content">
      <div class="row">
        <div class="label">{{ t('business.datasetContent.backupRange') }}</div>
        <Select v-model:value="scope" style="width: 320px">
          <Select.Option value="ALL">{{ t('business.datasetContent.allData') }}</Select.Option>
          <Select.Option value="SELECTED" :disabled="props.selectedList.length === 0">
            {{ t('business.datasetContent.selectedData') }}
          </Select.Option>
        </Select>
      </div>
      <div class="row">
        <div class="label">{{ t('business.datasetContent.serverBackupDirectory') }}</div>
        <Input
          v-model:value="destinationDirectory"
          :placeholder="t('business.datasetContent.serverBackupDirectoryPlaceholder')"
        />
      </div>
      <div class="hint">{{ t('business.datasetContent.serverBackupDirectoryHint') }}</div>
      <div class="hint">{{ t('business.datasetContent.backupLabelsHint') }}</div>
    </div>
  </BasicModal>
</template>

<script lang="ts" setup>
  import { ref } from 'vue';
  import { Input, message, Select } from 'ant-design-vue';
  import { BasicModal, useModalInner } from '/@/components/Modal';
  import { useI18n } from '/@/hooks/web/useI18n';
  import { backupLabels, exportDataRecordCallBack } from '/@/api/business/dataset';
  import { ExportStatus, exportFileRecord } from '/@/api/business/model/datasetModel';

  type BackupScope = 'ALL' | 'SELECTED';

  const props = defineProps<{
    datasetId: string | number;
    selectedList: string[];
  }>();

  const { t } = useI18n();
  const [register] = useModalInner();
  const scope = ref<BackupScope>('ALL');
  const destinationDirectory = ref('labels');
  const isLoading = ref(false);

  const waitForExport = async (serialNumber: string): Promise<exportFileRecord> => {
    while (true) {
      const records = await exportDataRecordCallBack({ serialNumbers: serialNumber });
      const record = records[0];
      if (!record) {
        throw new Error('Backup export record was not found');
      }
      if (record.status === ExportStatus.COMPLETED) {
        return record;
      }
      if (record.status === ExportStatus.FAILED) {
        throw new Error(record.errorMessage || 'Backup export failed');
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 2000));
    }
  };

  const handleBackup = async () => {
    const targetDirectory = destinationDirectory.value.trim();
    if (!targetDirectory) {
      message.warning(t('business.datasetContent.serverBackupDirectoryRequired'));
      return;
    }

    isLoading.value = true;
    try {
      const params: { datasetId: number; ids?: number[]; destinationDirectory: string } = {
        datasetId: Number(props.datasetId),
        destinationDirectory: targetDirectory,
      };
      if (scope.value === 'SELECTED') {
        params.ids = props.selectedList.map(Number);
      }

      const serialNumber = await backupLabels(params);
      const record = await waitForExport(String(serialNumber));
      message.success(
        t('business.datasetContent.serverBackupSuccess', {
          path: `${targetDirectory}/${record.fileName}`,
        }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      message.error(detail || t('business.datasetContent.backupLabelsFailed'));
    } finally {
      isLoading.value = false;
    }
  };
</script>

<style lang="less" scoped>
  .content {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 28px 42px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .label {
    flex: 0 0 86px;
    color: #333;
  }

  .hint {
    color: #666;
    font-size: 13px;
    line-height: 20px;
  }
</style>
