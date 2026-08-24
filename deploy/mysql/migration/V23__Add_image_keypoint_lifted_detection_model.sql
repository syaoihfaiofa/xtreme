ALTER TABLE `model`
    MODIFY COLUMN `model_code`
        enum ('PRE_LABEL', 'COCO_80', 'LIDAR_DETECTION', 'IMAGE_DETECTION', 'LIDAR_TRACKING',
              'IMAGE_KEYPOINT_LIFTED_DETECTION') DEFAULT NULL COMMENT 'Model''s unique identifier';

INSERT INTO `model`(`name`, `version`, `description`, `scenario`, `dataset_type`, `model_type`, `model_code`, `url`,
                    `is_deleted`, `del_unique_key`, `created_at`, `created_by`, `updated_at`, `updated_by`)
SELECT 'Image Keypoint-Lifted 15-Class Detection',
       'v1.0.0',
       '<p>Runs 2D keypoint detection on same-frame Fusion camera images, lifts detections with camera calibration, and returns pc-tool compatible 3D boxes.</p>',
       '["Lidar","Camera","Autonomous Vehicle","Object Detection"]',
       'LIDAR_FUSION',
       'DETECTION',
       'IMAGE_KEYPOINT_LIFTED_DETECTION',
       'http://image-keypoint-lifted-detection:5000/image/keypoint-lifted/recognition',
       b'0',
       0,
       current_timestamp,
       1,
       NULL,
       NULL
WHERE NOT EXISTS (
    SELECT 1
    FROM `model`
    WHERE `url` = 'http://image-keypoint-lifted-detection:5000/image/keypoint-lifted/recognition'
      AND `is_deleted` = b'0'
);

INSERT INTO model_class (model_id, name, code, created_by)
SELECT m.id, v.name, v.code, 1
FROM model m
JOIN (
    SELECT 'Car' AS name, 'car' AS code
    UNION ALL SELECT 'Bus', 'bus'
    UNION ALL SELECT 'Truck', 'truck'
    UNION ALL SELECT 'Tricycle', 'tricycle'
    UNION ALL SELECT 'Bike', 'bike'
    UNION ALL SELECT 'Locked parking lock', 'parkinglock_locked'
    UNION ALL SELECT 'Unlocked parking lock', 'parkinglock_unlocked'
    UNION ALL SELECT 'No parking board', 'board_no_parking'
    UNION ALL SELECT 'Handcart', 'handcart'
    UNION ALL SELECT 'Person', 'person'
    UNION ALL SELECT 'Pillar', 'pillar'
    UNION ALL SELECT 'Cone', 'cone'
    UNION ALL SELECT 'Pole', 'pole'
    UNION ALL SELECT 'Barrier', 'barrier'
    UNION ALL SELECT 'Concrete ball', 'concrete_ball'
) v ON 1 = 1
WHERE m.url = 'http://image-keypoint-lifted-detection:5000/image/keypoint-lifted/recognition'
  AND NOT EXISTS (
    SELECT 1
    FROM model_class mc
    WHERE mc.model_id = m.id
      AND mc.code = v.code
);
