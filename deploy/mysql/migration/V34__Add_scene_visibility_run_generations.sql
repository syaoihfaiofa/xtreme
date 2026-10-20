ALTER TABLE `scene_visibility_run`
    ADD COLUMN `generation_token` char(36) NOT NULL DEFAULT 0 AFTER `source_hash`,
    ADD COLUMN `is_default` tinyint(1) NOT NULL DEFAULT 1 AFTER `generation_token`;

ALTER TABLE `scene_visibility_run`
    DROP INDEX `uk_scene_visibility_source`,
    ADD UNIQUE KEY `uk_scene_visibility_generation` (
        `dataset_id`, `scene_id`, `source_hash`, `algorithm_version`, `generation_token`
    ) USING BTREE,
    ADD KEY `idx_scene_visibility_default` (
        `dataset_id`, `scene_id`, `source_hash`, `algorithm_version`, `is_default`
    ) USING BTREE;
