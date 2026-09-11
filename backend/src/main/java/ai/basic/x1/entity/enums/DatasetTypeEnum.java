package ai.basic.x1.entity.enums;

/**
 * @author andy
 */

public enum DatasetTypeEnum {

    /**
     * LIDAR_FUSION
     */
    LIDAR_FUSION,
    /**
     * LIDAR_BASIC
     */
    LIDAR_BASIC,
    /**
     * IMAGE
     */
    IMAGE,
    /**
     * TEXT
     */
    TEXT,
    /**
     * One global reconstructed point cloud with timestamped camera images.
     * This type has its own upload, annotation tables and editor APIs.
     */
    RECONSTRUCTION_FUSION
}
