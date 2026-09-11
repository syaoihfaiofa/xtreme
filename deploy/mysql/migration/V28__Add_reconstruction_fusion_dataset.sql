ALTER TABLE `dataset`
    MODIFY COLUMN `type` enum ('LIDAR_FUSION','LIDAR_BASIC','IMAGE','TEXT','RECONSTRUCTION_FUSION')
        NOT NULL DEFAULT 'LIDAR_FUSION'
        COMMENT 'Dataset type';

CREATE TABLE IF NOT EXISTS `reconstruction_scene`
(
    `id`                    bigint   NOT NULL AUTO_INCREMENT,
    `dataset_id`            bigint   NOT NULL,
    `name`                  varchar(255) NOT NULL,
    `point_cloud_file_id`   bigint   NOT NULL,
    `camera_config_file_id` bigint   NOT NULL,
    `created_at`            datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `created_by`            bigint   DEFAULT NULL,
    `updated_at`            datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `updated_by`            bigint   DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_reconstruction_scene_dataset_name` (`dataset_id`, `name`),
    KEY `idx_reconstruction_scene_dataset_id` (`dataset_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='Independent global-point-cloud reconstruction scenes';

CREATE TABLE IF NOT EXISTS `reconstruction_frame`
(
    `id`           bigint NOT NULL AUTO_INCREMENT,
    `scene_id`     bigint NOT NULL,
    `timestamp_ns` bigint NOT NULL,
    `pos_x`        double NOT NULL,
    `pos_y`        double NOT NULL,
    `pos_z`        double NOT NULL,
    `yaw`          double NOT NULL,
    `roll`         double DEFAULT NULL,
    `pitch`        double DEFAULT NULL,
    `created_at`   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`   datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_reconstruction_frame_scene_timestamp` (`scene_id`, `timestamp_ns`),
    KEY `idx_reconstruction_frame_scene_id` (`scene_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='Image timestamps and world poses for a reconstruction scene';

CREATE TABLE IF NOT EXISTS `reconstruction_frame_image`
(
    `id`           bigint NOT NULL AUTO_INCREMENT,
    `frame_id`     bigint NOT NULL,
    `camera_index` int    NOT NULL,
    `file_id`      bigint NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_reconstruction_frame_camera` (`frame_id`, `camera_index`),
    KEY `idx_reconstruction_frame_image_frame_id` (`frame_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='Camera images belonging to a reconstruction timestamp';

CREATE TABLE IF NOT EXISTS `reconstruction_annotation`
(
    `id`               bigint   NOT NULL AUTO_INCREMENT,
    `dataset_id`       bigint   NOT NULL,
    `scene_id`         bigint   NOT NULL,
    `class_id`         bigint   NOT NULL,
    `geometry`         json     NOT NULL,
    `class_attributes` json     DEFAULT NULL,
    `created_at`       datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `created_by`       bigint   DEFAULT NULL,
    `updated_at`       datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `updated_by`       bigint   DEFAULT NULL,
    PRIMARY KEY (`id`),
    KEY `idx_reconstruction_annotation_scene_id` (`scene_id`),
    KEY `idx_reconstruction_annotation_dataset_id` (`dataset_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='Scene-level annotations in reconstruction world coordinates';
