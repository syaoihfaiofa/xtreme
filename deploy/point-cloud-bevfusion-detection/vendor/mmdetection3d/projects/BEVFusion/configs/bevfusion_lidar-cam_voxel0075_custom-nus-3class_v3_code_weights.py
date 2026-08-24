_base_ = ["./bevfusion_lidar-cam_voxel0075_custom-nus-3class_v3.py"]

experiment = dict(
    id="lidar-cam-3class-v3-code-weights",
    work_dir="work_dirs/bevfusion_lidar_cam_custom_nus_3class_v3_code_weights",
    description="v3 with dimension code_weights 1.2.",
    pretrained_strategy="lidar_partial_no_bbox_head",
)

model = dict(
    bbox_head=dict(
        train_cfg=dict(
            min_radius=1,
            gaussian_overlap=0.1,
            code_weights=[
                1.0, 1.0, 1.0, 1.2, 1.2, 1.2, 1.0, 1.0, 0.0, 0.0
            ],
        )))
