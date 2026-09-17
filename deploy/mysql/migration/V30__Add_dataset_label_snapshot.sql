CREATE TABLE IF NOT EXISTS `dataset_label_snapshot`
(
    `id`         bigint       NOT NULL AUTO_INCREMENT,
    `dataset_id` bigint       NOT NULL,
    `scene_id`   bigint       NOT NULL,
    `name`       varchar(255) NOT NULL,
    `created_at` datetime     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `created_by` bigint       DEFAULT NULL,
    PRIMARY KEY (`id`),
    KEY `idx_label_snapshot_dataset_scene_created`
        (`dataset_id`, `scene_id`, `created_at`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4
  COMMENT = 'Scene-scoped editable-label snapshots';
