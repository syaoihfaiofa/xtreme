ALTER TABLE `scene_visibility_run`
    ADD COLUMN `stage` varchar(32) NOT NULL DEFAULT 'QUEUED' AFTER `status`;
