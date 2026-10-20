ALTER TABLE `scene_visibility_run`
    ADD COLUMN `task_type` varchar(16) DEFAULT NULL AFTER `is_default`,
    ADD COLUMN `occ_run_id` bigint(20) DEFAULT NULL AFTER `task_type`,
    ADD KEY `idx_scene_visibility_occ_run` (`occ_run_id`) USING BTREE;
