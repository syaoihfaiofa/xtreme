_base_ = ["./bevfusion_lidar-cam_voxel0075_custom-nus-3class_v3.py"]

experiment = dict(
    id="lidar-cam-3class-v3-gaussian",
    work_dir="work_dirs/bevfusion_lidar_cam_custom_nus_3class_v3_gaussian",
    description="v3 with gaussian_overlap 0.05.",
    pretrained_strategy="lidar_partial_no_bbox_head",
)

model = dict(
    bbox_head=dict(
        train_cfg=dict(
            min_radius=1,
            gaussian_overlap=0.05,
        )))
