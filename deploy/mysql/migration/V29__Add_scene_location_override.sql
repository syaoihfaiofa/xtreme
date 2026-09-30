CREATE TABLE IF NOT EXISTS `scene_location_override`
(
    `id`         bigint   NOT NULL AUTO_INCREMENT,
    `data_id`    bigint   NOT NULL COMMENT 'Frame data id',
    `pos_x`      double   NOT NULL,
    `pos_y`      double   NOT NULL,
    `pos_z`      double   NOT NULL,
    `yaw`        double   NOT NULL,
    `roll`       double   NOT NULL,
    `pitch`      double   NOT NULL,
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_scene_location_override_data_id` (`data_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='Manual per-frame ego pose correction';
