ALTER TABLE `model`
    MODIFY COLUMN `model_code`
        enum ('PRE_LABEL', 'COCO_80', 'LIDAR_DETECTION', 'IMAGE_DETECTION', 'LIDAR_TRACKING',
              'IMAGE_KEYPOINT_LIFTED_DETECTION', 'PARKING_SLOT_DETECTION') DEFAULT NULL COMMENT 'Model''s unique identifier';

INSERT INTO `model`(`name`, `version`, `description`, `scenario`, `dataset_type`, `model_type`, `model_code`, `url`,
                    `is_deleted`, `del_unique_key`, `created_at`, `created_by`, `updated_at`, `updated_by`)
SELECT 'Parking Slot Detection',
       'v1.0.0',
       '<p>Detects parking-slot quadrilaterals from a same-frame stitched surround-view image and projects them onto the lidar ground plane.</p>',
       '["Lidar","Camera","Parking","Object Detection"]',
       'LIDAR_FUSION',
       'DETECTION',
       'PARKING_SLOT_DETECTION',
       'http://parking-slot-detection:5000/parking-slot/recognition',
       b'0', 0, current_timestamp, 1, NULL, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM `model` WHERE `model_code` = 'PARKING_SLOT_DETECTION' AND `is_deleted` = b'0'
);

INSERT INTO model_class (model_id, name, code, created_by)
SELECT m.id, v.name, v.code, 1
FROM model m
JOIN (
    SELECT 'parkinglot' AS name, 'parkinglot' AS code
    UNION ALL SELECT 'parkinglot_parked', 'parkinglot_parked'
    UNION ALL SELECT 'parkinglot_mechanical', 'parkinglot_mechanical'
    UNION ALL SELECT 'parkinglot_handicap', 'parkinglot_handicap'
    UNION ALL SELECT 'parkinglot_parked_partial', 'parkinglot_parked_partial'
) v ON 1 = 1
WHERE m.model_code = 'PARKING_SLOT_DETECTION' AND m.is_deleted = b'0'
  AND NOT EXISTS (
      SELECT 1 FROM model_class mc WHERE mc.model_id = m.id AND mc.code = v.code
  );
