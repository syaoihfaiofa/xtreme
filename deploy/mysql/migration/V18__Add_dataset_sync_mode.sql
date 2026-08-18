ALTER TABLE `dataset`
    ADD COLUMN `sync_mode` bit(1) NOT NULL DEFAULT b'0' COMMENT 'Cross-frame static/dynamic object sync mode' AFTER `is_deleted`;
