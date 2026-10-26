INSERT INTO `model`(`name`, `version`, `description`, `scenario`, `dataset_type`, `model_type`, `model_code`, `url`, `is_deleted`, `del_unique_key`, `created_at`, `created_by`, `updated_at`, `updated_by`)
SELECT 'BEVFusion LiDAR 10-Class Detection',
       'v1.0.0',
       '<p>Custom BEVFusion LiDAR-only detector trained on Barrier / Board No Parking / Car / Cone / Handcart / Parking Lock (Locked) / Parking Lock (Unlocked) / Person / Pillar / Pole. Runs native 3D detection on the uploaded point cloud frame.</p>',
       '["Lidar","Autonomous Vehicle","Object Detection"]',
       'LIDAR',
       'DETECTION',
       'LIDAR_DETECTION',
       'http://point-cloud-bevfusion-10class-detection:5000/pointCloud/recognition',
       b'0',
       0,
       current_timestamp,
       1,
       NULL,
       NULL
WHERE NOT EXISTS (
    SELECT 1 FROM `model` WHERE `url` = 'http://point-cloud-bevfusion-10class-detection:5000/pointCloud/recognition' AND `is_deleted` = b'0'
);

INSERT INTO model_class (model_id, name, code, created_by)
SELECT m.id, v.name, v.code, 1
FROM model m
JOIN (
    SELECT 'Barrier' AS name, 'barrier' AS code
    UNION ALL SELECT 'Board No Parking', 'board_no_parking'
    UNION ALL SELECT 'Car', 'car'
    UNION ALL SELECT 'Cone', 'cone'
    UNION ALL SELECT 'Handcart', 'handcart'
    UNION ALL SELECT 'Parking Lock (Locked)', 'parkinglock_locked'
    UNION ALL SELECT 'Parking Lock (Unlocked)', 'parkinglock_unlocked'
    UNION ALL SELECT 'Person', 'person'
    UNION ALL SELECT 'Pillar', 'pillar'
    UNION ALL SELECT 'Pole', 'pole'
) v ON 1 = 1
WHERE m.url = 'http://point-cloud-bevfusion-10class-detection:5000/pointCloud/recognition'
AND NOT EXISTS (
    SELECT 1 FROM model_class mc WHERE mc.model_id = m.id AND mc.code = v.code
);
