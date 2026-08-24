UPDATE `model`
SET `version` = 'v2.0.0',
    `description` = '<p>BEVFusion LiDAR and 4-camera detector trained on Car / Cone / Pillar. Returns native LiDAR-coordinate 3D boxes from Fusion frames.</p>',
    `dataset_type` = 'LIDAR_FUSION'
WHERE `url` = 'http://point-cloud-bevfusion-detection:5000/pointCloud/recognition'
  AND `is_deleted` = b'0';
