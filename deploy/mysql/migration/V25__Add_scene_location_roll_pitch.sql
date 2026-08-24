ALTER TABLE `scene_location`
    ADD COLUMN `roll` double NULL COMMENT 'Roll, radians' AFTER `yaw`,
    ADD COLUMN `pitch` double NULL COMMENT 'Pitch, radians' AFTER `roll`;

ALTER TABLE `scene_location_sample`
    ADD COLUMN `roll` double NULL COMMENT 'Roll, radians' AFTER `yaw`,
    ADD COLUMN `pitch` double NULL COMMENT 'Pitch, radians' AFTER `roll`;
