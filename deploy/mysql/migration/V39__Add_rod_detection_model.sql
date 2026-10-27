ALTER TABLE `model`
    MODIFY COLUMN `model_code`
        enum ('PRE_LABEL', 'COCO_80', 'LIDAR_DETECTION', 'IMAGE_DETECTION', 'LIDAR_TRACKING',
              'IMAGE_KEYPOINT_LIFTED_DETECTION', 'PARKING_SLOT_DETECTION', 'IMAGE_ROD_DETECTION') DEFAULT NULL COMMENT 'Model''s unique identifier';

INSERT INTO `model`(`name`, `version`, `description`, `scenario`, `dataset_type`, `model_type`, `model_code`, `url`,
                    `is_deleted`, `del_unique_key`, `created_at`, `created_by`, `updated_at`, `updated_by`)
SELECT 'ROD Fisheye 4-Class Detection',
       'rod-x-260908',
       '<p>Runs the ROD YOLO11 pose model on the center crop of same-frame Fusion fisheye images, lifts the four ground keypoints with camera calibration, and returns pc-tool compatible 3D boxes.</p>',
       '["Lidar","Camera","Parking","Object Detection"]',
       'LIDAR_FUSION',
       'DETECTION',
       'IMAGE_ROD_DETECTION',
       'http://rod-detection:5000/image/rod/recognition',
       b'0', 0, current_timestamp, 1, NULL, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM `model` WHERE `model_code` = 'IMAGE_ROD_DETECTION' AND `is_deleted` = b'0'
);

INSERT INTO model_class (model_id, name, code, created_by)
SELECT m.id, v.name, v.code, 1
FROM model m
JOIN (
    SELECT 'No parking board' AS name, 'board_no_parking' AS code
    UNION ALL SELECT 'Cone', 'cone'
    UNION ALL SELECT 'Locked parking lock', 'parkinglock_locked'
    UNION ALL SELECT 'Unlocked parking lock', 'parkinglock_unlocked'
) v ON 1 = 1
WHERE m.model_code = 'IMAGE_ROD_DETECTION' AND m.is_deleted = b'0'
  AND NOT EXISTS (
      SELECT 1 FROM model_class mc WHERE mc.model_id = m.id AND mc.code = v.code
  );
