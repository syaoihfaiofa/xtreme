_base_ = ["./bevfusion_lidar-cam_voxel0075_custom-nus-3class_v2.py"]

experiment = dict(
    id="lidar-cam-3class-v2-ft",
    work_dir="work_dirs/bevfusion_lidar_cam_custom_nus_3class_v2_ft",
    description="Fine-tune v2 with lower LR and longer schedule.",
    pretrained_strategy="resume_only",
    resume_from="work_dirs/bevfusion_lidar_cam_custom_nus_3class_v2/epoch_20.pth",
)

lr = 1e-5

optim_wrapper = dict(
    optimizer=dict(lr=lr))

train_cfg = dict(max_epochs=30, val_interval=5)

custom_hooks = [
    dict(type="DisableObjectSampleHook", disable_after_epoch=25),
]

param_scheduler = [
    dict(
        type="CosineAnnealingLR",
        T_max=12,
        eta_min=lr * 10,
        begin=0,
        end=12,
        by_epoch=True,
        convert_to_iter_based=True),
    dict(
        type="CosineAnnealingLR",
        T_max=18,
        eta_min=lr * 1e-4,
        begin=12,
        end=30,
        by_epoch=True,
        convert_to_iter_based=True),
    dict(
        type="CosineAnnealingMomentum",
        T_max=12,
        eta_min=0.85 / 0.95,
        begin=0,
        end=12,
        by_epoch=True,
        convert_to_iter_based=True),
    dict(
        type="CosineAnnealingMomentum",
        T_max=18,
        eta_min=1,
        begin=12,
        end=30,
        by_epoch=True,
        convert_to_iter_based=True),
]
