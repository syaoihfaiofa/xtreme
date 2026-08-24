_base_ = ["./bevfusion_lidar-cam_voxel0075_custom-nus-3class.py"]

experiment = dict(
    id="lidar-cam-3class-v2",
    work_dir="work_dirs/bevfusion_lidar_cam_custom_nus_3class_v2",
    description="Fisheye image aug + full LiDAR checkpoint load (baseline v2).",
    pretrained_strategy="full_lidar_load_from",
)
