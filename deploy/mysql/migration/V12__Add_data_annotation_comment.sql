CREATE TABLE `data_annotation_comment`
(
    `id`          bigint(20)                                      NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
    `dataset_id`  bigint(20)                                      NOT NULL COMMENT 'Dataset ID',
    `data_id`     bigint(20)                                      NOT NULL COMMENT 'Data ID',
    `anchor_type` enum ('OBJECT','FRAME','POSITION')              NOT NULL COMMENT 'Comment anchor type',
    `object_id`   bigint(20)                                               DEFAULT NULL COMMENT 'Annotation object ID',
    `track_id`    varchar(255)                                             DEFAULT NULL COMMENT 'Annotation track ID',
    `position`    json                                                     DEFAULT NULL COMMENT 'Point cloud position',
    `message`     text                                            NOT NULL COMMENT 'Comment text',
    `parent_id`   bigint(20)                                               DEFAULT NULL COMMENT 'Parent comment ID',
    `root_id`     bigint(20)                                               DEFAULT NULL COMMENT 'Root comment ID; null for roots',
    `resolved`    bit(1)                                          NOT NULL DEFAULT b'0' COMMENT 'Resolved state for root comments',
    `created_by`  bigint(20)                                      NOT NULL COMMENT 'Creator ID',
    `created_at`  datetime                                        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Create time',
    `updated_at`  datetime                                        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Update time',
    PRIMARY KEY (`id`) USING BTREE,
    KEY `idx_comment_dataset_data` (`dataset_id`, `data_id`) USING BTREE,
    KEY `idx_comment_root_created` (`root_id`, `created_at`) USING BTREE,
    KEY `idx_comment_parent` (`parent_id`) USING BTREE,
    KEY `idx_comment_object` (`object_id`) USING BTREE
) ENGINE = InnoDB
  AUTO_INCREMENT = 1
  DEFAULT CHARSET = utf8mb4 COMMENT ='Data annotation comments';
