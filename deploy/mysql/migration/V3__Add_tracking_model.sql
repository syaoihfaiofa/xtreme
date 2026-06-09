ALTER TABLE `model`
    MODIFY `model_type` enum ('DETECTION', 'TRACKING') DEFAULT 'DETECTION' COMMENT 'Model type',
    MODIFY `model_code` enum ('PRE_LABEL','COCO_80','LIDAR_DETECTION','IMAGE_DETECTION','LIDAR_TRACKING') DEFAULT NULL COMMENT 'Model''s unique identifier';

INSERT INTO `model`(`id`, `name`, `version`, `description`, `scenario`, `dataset_type`, `model_type`, `model_code`, `url`, `is_deleted`, `del_unique_key`, `created_at`, `created_by`, `updated_at`, `updated_by`)
VALUES (3, 'Basic Lidar Object Tracking', 'v0.1.0', '<p>Point cloud 3D box tracking for sequence frame annotation. Seed a box on the source frame and propagate it to target frames.</p>', '["Lidar","Lidar fusion","Autonomous Vehicle","Object Tracking"]', 'LIDAR', 'TRACKING', 'LIDAR_TRACKING', 'http://point-cloud-object-tracking:5000/pointCloud/tracking', b'0', 0, current_timestamp, 1, NULL, NULL);
