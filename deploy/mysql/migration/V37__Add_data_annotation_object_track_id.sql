ALTER TABLE `data_annotation_object`
    ADD COLUMN `track_id` VARCHAR(64) NULL AFTER `class_attributes`,
    ADD INDEX `idx_data_annotation_object_data_id_track_id` (`data_id`, `track_id`);

UPDATE `data_annotation_object`
SET `track_id` = NULLIF(
    TRIM(JSON_UNQUOTE(JSON_EXTRACT(`class_attributes`, '$.trackId'))),
    ''
)
WHERE `class_attributes` IS NOT NULL;
