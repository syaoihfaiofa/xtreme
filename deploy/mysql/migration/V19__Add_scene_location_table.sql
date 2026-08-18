CREATE TABLE IF NOT EXISTS `scene_location`
(
    `id`         bigint   NOT NULL AUTO_INCREMENT,
    `data_id`    bigint   NOT NULL COMMENT 'Frame data id (SINGLE_DATA row under a Scene)',
    `pos_x`      double   NOT NULL,
    `pos_y`      double   NOT NULL,
    `pos_z`      double   NOT NULL,
    `yaw`        double   NOT NULL COMMENT 'Heading, radians',
    `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_scene_location_data_id` (`data_id`)
) ENGINE = InnoDB
  DEFAULT CHARSET = utf8mb4 COMMENT ='Per-frame ego pose uploaded for a Scene';
