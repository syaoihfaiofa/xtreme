-- Group orphaned SINGLE_DATA frames under a SCENE parent so sequence-frame tracking works.
-- Safe to run on fresh or existing DB: only affects rows with parent_id = 0.

INSERT INTO `data` (`dataset_id`, `name`, `order_name`, `type`, `parent_id`, `status`, `annotation_status`, `split_type`, `is_deleted`, `del_unique_key`, `created_by`)
SELECT d.dataset_id, CONCAT('Scene-', d.dataset_id), CONCAT('scene_', d.dataset_id), 'SCENE', 0, 'VALID', 'NOT_ANNOTATED', 'NOT_SPLIT', b'0', 0, 1
FROM (
    SELECT DISTINCT dataset_id
    FROM `data`
    WHERE `type` = 'SINGLE_DATA'
      AND `parent_id` = 0
      AND `is_deleted` = b'0'
      AND `dataset_id` NOT IN (
          SELECT DISTINCT dataset_id FROM `data` WHERE `type` = 'SCENE' AND `is_deleted` = b'0'
      )
) d;

UPDATE `data` AS child
INNER JOIN `data` AS scene
    ON scene.dataset_id = child.dataset_id
   AND scene.type = 'SCENE'
   AND scene.is_deleted = b'0'
SET child.parent_id = scene.id
WHERE child.type = 'SINGLE_DATA'
  AND child.parent_id = 0
  AND child.is_deleted = b'0';
