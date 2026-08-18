INSERT INTO `model`(`name`, `version`, `description`, `scenario`, `dataset_type`, `model_type`, `model_code`, `url`, `is_deleted`, `del_unique_key`, `created_at`, `created_by`, `updated_at`, `updated_by`)
SELECT 'BEVFusion LiDAR 3-Class Detection',
       'v1.0.0',
       '<p>Custom BEVFusion LiDAR-only detector trained on Car / Cone / Pillar. Runs native 3D detection on the uploaded point cloud frame (no camera fusion).</p>',
       '["Lidar","Autonomous Vehicle","Object Detection"]',
       'LIDAR',
       'DETECTION',
       'LIDAR_DETECTION',
       'http://point-cloud-bevfusion-detection:5000/pointCloud/recognition',
       b'0',
       0,
       current_timestamp,
       1,
       NULL,
       NULL
WHERE NOT EXISTS (
    SELECT 1 FROM `model` WHERE `url` = 'http://point-cloud-bevfusion-detection:5000/pointCloud/recognition' AND `is_deleted` = b'0'
);
