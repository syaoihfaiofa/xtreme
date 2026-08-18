ALTER TABLE `user`
    ADD COLUMN `role` enum ('ADMIN', 'ANNOTATOR', 'REVIEWER', 'ACCEPTOR') NOT NULL DEFAULT 'ADMIN' COMMENT 'User role' AFTER `nickname`;

UPDATE `user`
SET `role` = 'ADMIN'
WHERE `role` IS NULL;
