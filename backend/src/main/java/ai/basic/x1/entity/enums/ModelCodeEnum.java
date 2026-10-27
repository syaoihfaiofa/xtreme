package ai.basic.x1.entity.enums;

/**
 * @author andy
 */

public enum ModelCodeEnum {

    /**
     * COCO_80
     */
    IMAGE_DETECTION,
    /**
     * PRE_LABEL
     */
    LIDAR_DETECTION,
    /**
     * LIDAR_TRACKING
     */
    LIDAR_TRACKING,
    /**
     * IMAGE_KEYPOINT_LIFTED_DETECTION
     */
    IMAGE_KEYPOINT_LIFTED_DETECTION,
    /**
     * CenterNet parking-slot detection from a stitched surround-view image.
     */
    PARKING_SLOT_DETECTION,
    /**
     * ROD YOLO11 pose detection on fisheye center crops, lifted to ground 3D boxes.
     */
    IMAGE_ROD_DETECTION
}
