ALTER TABLE `data_annotation_object`
    MODIFY COLUMN `source_type`
        enum ('DATA_FLOW','IMPORTED','MODEL','INFERENCE','SNAPSHOT')
        DEFAULT 'DATA_FLOW' COMMENT 'Source type';
