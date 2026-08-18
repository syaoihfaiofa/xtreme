ALTER TABLE `dataset`
    ADD COLUMN `inference_mode` bit(1) NOT NULL DEFAULT b'0' AFTER `sync_mode`,
    ADD COLUMN `inference_config` json DEFAULT NULL AFTER `inference_mode`;

ALTER TABLE `data_annotation_object`
    MODIFY COLUMN `source_type`
        enum ('DATA_FLOW','IMPORTED','MODEL','INFERENCE')
        DEFAULT 'DATA_FLOW' COMMENT 'Source type';

CREATE TABLE `scene_inference_run`
(
    `id`                bigint(20) NOT NULL AUTO_INCREMENT,
    `dataset_id`        bigint(20) NOT NULL,
    `scene_id`          bigint(20) NOT NULL,
    `config_hash`       char(64) NOT NULL,
    `config_snapshot`   json NOT NULL,
    `status`            enum ('QUEUED','RUNNING','SUCCEEDED','FAILED') NOT NULL DEFAULT 'QUEUED',
    `progress`          decimal(5,4) NOT NULL DEFAULT 0,
    `total_frames`      int NOT NULL DEFAULT 0,
    `completed_frames`  int NOT NULL DEFAULT 0,
    `error`             text DEFAULT NULL,
    `affected_data_ids` json DEFAULT NULL,
    `created_at`        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`) USING BTREE,
    UNIQUE KEY `uk_scene_inference_config` (`dataset_id`, `scene_id`, `config_hash`) USING BTREE,
    KEY `idx_scene_inference_status` (`status`) USING BTREE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4 COMMENT ='Scene inference and tracking runs';
