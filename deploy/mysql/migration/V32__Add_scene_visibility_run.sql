CREATE TABLE `scene_visibility_run`
(
    `id`                bigint(20) NOT NULL AUTO_INCREMENT,
    `dataset_id`        bigint(20) NOT NULL,
    `scene_id`          bigint(20) NOT NULL,
    `source_hash`       char(64) NOT NULL,
    `algorithm_version` varchar(64) NOT NULL,
    `status`            enum ('QUEUED','RUNNING','SUCCEEDED','FAILED','STALE') NOT NULL DEFAULT 'QUEUED',
    `progress`          decimal(5,4) NOT NULL DEFAULT 0,
    `total_frames`      int NOT NULL DEFAULT 0,
    `completed_frames`  int NOT NULL DEFAULT 0,
    `error`             text DEFAULT NULL,
    `result_file_id`    bigint(20) DEFAULT NULL,
    `created_at`        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`        datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`) USING BTREE,
    UNIQUE KEY `uk_scene_visibility_source` (`dataset_id`, `scene_id`, `source_hash`, `algorithm_version`) USING BTREE,
    KEY `idx_scene_visibility_status` (`status`) USING BTREE
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4 COMMENT ='Independent automatic visibility runs';
