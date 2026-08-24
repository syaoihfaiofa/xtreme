_base_ = ["./bevfusion_lidar-cam_voxel0075_custom-nus-3class.py"]

experiment = dict(
    id="lidar-cam-3class-v3",
    work_dir="work_dirs/bevfusion_lidar_cam_custom_nus_3class_v3",
    description="Partial LiDAR pretrained load.",
    pretrained_strategy="lidar_partial_no_bbox_head",
)

lidar_pretrained_checkpoint = "work_dirs/bevfusion_lidar_custom_nus_3class/epoch_20.pth"

custom_hooks = [
    dict(type="DisableObjectSampleHook", disable_after_epoch=15),
    dict(
        type="LidarCamPartialPretrainedHook",
        checkpoint=lidar_pretrained_checkpoint,
        load_bbox_head=False),
]
