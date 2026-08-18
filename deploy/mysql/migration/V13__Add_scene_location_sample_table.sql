CREATE TABLE `scene_location_sample`
(
    `id`           bigint   NOT NULL AUTO_INCREMENT,
    `scene_id`     bigint   NOT NULL COMMENT 'Scene data id',
    `timestamp_ns` bigint   NOT NULL COMMENT 'Original location sample timestamp in nanoseconds',
    `pos_x`        double   NOT NULL,
    `pos_y`        double   NOT NULL,
    `pos_z`        double   NOT NULL,
    `yaw`          double   NOT NULL COMMENT 'Heading, radians',
    `created_at`   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_scene_location_sample_scene_timestamp` (`scene_id`, `timestamp_ns`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4 COMMENT ='Original location samples uploaded for a Scene';
