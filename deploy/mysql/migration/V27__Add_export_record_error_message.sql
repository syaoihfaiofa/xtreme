ALTER TABLE `export_record`
    ADD COLUMN `error_message` text DEFAULT NULL COMMENT 'Export failure detail' AFTER `status`;
