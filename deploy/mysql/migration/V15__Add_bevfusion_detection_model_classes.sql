INSERT INTO model_class (model_id, name, code, created_by)
SELECT m.id, v.name, v.code, 1
FROM model m
JOIN (
    SELECT 'Car' AS name, 'car' AS code
    UNION ALL SELECT 'Cone', 'cone'
    UNION ALL SELECT 'Pillar', 'pillar'
) v ON 1 = 1
WHERE m.url = 'http://point-cloud-bevfusion-detection:5000/pointCloud/recognition'
AND NOT EXISTS (
    SELECT 1 FROM model_class mc WHERE mc.model_id = m.id AND mc.code = v.code
);
