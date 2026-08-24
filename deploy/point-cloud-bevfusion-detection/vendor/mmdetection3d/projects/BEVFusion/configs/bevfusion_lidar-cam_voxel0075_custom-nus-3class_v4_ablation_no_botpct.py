_base_ = ["./bevfusion_lidar-cam_voxel0075_custom-nus-3class.py"]

experiment = dict(
    id="lidar-cam-3class-v4-no-botpct",
    work_dir="work_dirs/bevfusion_lidar_cam_custom_nus_3class_v4_no_botpct",
    description="Fisheye resize aug with bot_pct disabled.",
    pretrained_strategy="full_lidar_load_from",
)

image_bot_pct_lim = [0.0, 0.0]
image_val_bot_pct = 0.0

train_pipeline = [
    dict(type="BEVLoadMultiViewImageFromFiles", to_float32=True, color_type="color", num_views=4, backend_args=backend_args),
    dict(type="LoadPointsFromFile", coord_type="LIDAR", load_dim=5, use_dim=5, backend_args=backend_args),
    dict(type="LoadPointsFromMultiSweeps", sweeps_num=5, load_dim=5, use_dim=5, pad_empty_sweeps=True, remove_close=True, backend_args=backend_args),
    dict(type="FilterVehicleBlindZone", car_config_path="outputs/car.json", blind_zone_front=1.3, blind_zone_rear=1.3),
    dict(type="LoadAnnotations3D", with_bbox_3d=True, with_label_3d=True, with_attr_label=False),
    dict(type="ObjectSample", db_sampler=object_sampler),
    dict(type="ImageAug3D", final_dim=[256, 704], resize_lim=[0.58, 0.72], bot_pct_lim=[0.0, 0.0], rot_lim=[-5.4, 5.4], rand_flip=True, is_train=True),
    dict(type="BEVFusionGlobalRotScaleTrans", scale_ratio_range=[0.9, 1.1], rot_range=[-0.78539816, 0.78539816], translation_std=0.5),
    dict(type="BEVFusionRandomFlip3D"),
    dict(type="PointsRangeFilter", point_cloud_range=point_cloud_range),
    dict(type="ObjectRangeFilter", point_cloud_range=point_cloud_range),
    dict(type="ObjectNameFilter", classes=class_names),
    dict(type="FilterBoxesWithoutPoints", min_num_points=1),
    dict(type="GridMask", use_h=True, use_w=True, max_epoch=6, rotate=1, offset=False, ratio=0.5, mode=1, prob=0.0, fixed_prob=True),
    dict(type="PointShuffle"),
    dict(type="Pack3DDetInputs", keys=["points", "img", "gt_bboxes_3d", "gt_labels_3d", "gt_bboxes", "gt_labels"], meta_keys=["cam2img", "ori_cam2img", "lidar2cam", "lidar2img", "cam2lidar", "ori_lidar2img", "img_aug_matrix", "box_type_3d", "sample_idx", "lidar_path", "img_path", "transformation_3d_flow", "pcd_rotation", "pcd_scale_factor", "pcd_trans", "lidar_aug_matrix", "num_pts_feats"]),
]

val_pipeline = [
    dict(type="BEVLoadMultiViewImageFromFiles", to_float32=True, color_type="color", num_views=4, backend_args=backend_args),
    dict(type="LoadPointsFromFile", coord_type="LIDAR", load_dim=5, use_dim=5, backend_args=backend_args),
    dict(type="LoadPointsFromMultiSweeps", sweeps_num=5, load_dim=5, use_dim=5, pad_empty_sweeps=True, remove_close=True, test_mode=True, backend_args=backend_args),
    dict(type="FilterVehicleBlindZone", car_config_path="outputs/car.json", blind_zone_front=1.3, blind_zone_rear=1.3),
    dict(type="ImageAug3D", final_dim=[256, 704], resize_lim=[0.65, 0.65], bot_pct_lim=[0.0, 0.0], rot_lim=[0.0, 0.0], rand_flip=False, is_train=False),
    dict(type="PointsRangeFilter", point_cloud_range=point_cloud_range),
    dict(type="Pack3DDetInputs", keys=["img", "points", "gt_bboxes_3d", "gt_labels_3d"], meta_keys=["cam2img", "ori_cam2img", "lidar2cam", "lidar2img", "cam2lidar", "ori_lidar2img", "img_aug_matrix", "box_type_3d", "sample_idx", "lidar_path", "img_path", "num_pts_feats"]),
]

test_pipeline = val_pipeline

train_dataloader = dict(dataset=dict(dataset=dict(pipeline=train_pipeline)))
val_dataloader = dict(dataset=dict(pipeline=val_pipeline))
test_dataloader = val_dataloader
