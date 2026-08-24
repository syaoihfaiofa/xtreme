UPDATE model
SET name = 'Image Keypoint-Lifted 21-Class Detection',
    description = '<p>Detects 15 quad classes and 6 ground-polyline classes from Fusion camera images, then lifts them into the vehicle coordinate system.</p>'
WHERE url = 'http://image-keypoint-lifted-detection:5000/image/keypoint-lifted/recognition'
  AND is_deleted = b'0';

INSERT INTO model_class (model_id, name, code, created_by)
SELECT m.id, v.name, v.code, 1
FROM model m
JOIN (
    SELECT 'curb' AS name, 'curb' AS code
    UNION ALL SELECT 'wall', 'wall'
    UNION ALL SELECT 'fence', 'fence'
    UNION ALL SELECT 'vehicle_long_side_edge', 'vehicle_long_side_edge'
    UNION ALL SELECT 'vehicle_short_side_edge', 'vehicle_short_side_edge'
    UNION ALL SELECT 'barrier_side_edge', 'barrier_side_edge'
) v ON 1 = 1
WHERE m.url = 'http://image-keypoint-lifted-detection:5000/image/keypoint-lifted/recognition'
  AND m.is_deleted = b'0'
  AND NOT EXISTS (
    SELECT 1
    FROM model_class mc
    WHERE mc.model_id = m.id
      AND mc.code = v.code
);
