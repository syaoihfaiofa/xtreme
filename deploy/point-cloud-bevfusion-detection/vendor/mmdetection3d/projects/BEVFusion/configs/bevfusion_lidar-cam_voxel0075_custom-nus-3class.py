_base_ = [
    './bevfusion_lidar-cam_voxel0075_custom-nus-7class.py'
]

class_names = [
    'Car',
    'Cone',
    'Pillar',
]
metainfo = dict(classes=class_names, box_type_3d='LiDAR')
dataset_type = 'CustomNuScenesThreeClassDataset'
data_root = 'data/nuscenes/'
point_cloud_range = [-21.0, -21.0, -5.0, 21.0, 21.0, 4.0]
data_prefix = dict(
    pts='samples/LIDAR_TOP_BIN',
    CAM_FRONT='samples/CAM_FRONT',
    CAM_RIGHT='samples/CAM_RIGHT',
    CAM_BACK='samples/CAM_BACK',
    CAM_LEFT='samples/CAM_LEFT',
    sweeps='sweeps/LIDAR_TOP_BIN')
input_modality = dict(use_lidar=True, use_camera=True)
backend_args = None

# Custom fisheye images are 1280x720. ImageAug3D crops to 256x704, so scaled
# width must exceed 704 for horizontal crop diversity: resize > 704/1280 = 0.55.
# Range [0.58, 0.72] yields scaled width 742~921 and horizontal crop 38~217 px.
image_resize_lim = [0.58, 0.72]
image_val_resize = 0.65
# Fisheye bottom ~15-20% is ego vehicle hood. bot_pct_lim shifts crop upward:
# 0.0 keeps bottom (nuScenes road); ~0.4 excludes hood and keeps parking scene.
# Camera intrinsics are NOT changed for crop; ImageAug3D writes img_aug_matrix
# and LSS undoes it in get_geometry / sparse-depth projection.
image_bot_pct_lim = [0.35, 0.50]
image_val_bot_pct = 0.42

camera_calibrations = [
    dict(
        camera_name='CAM_FRONT',
        camera_model='fisheye',
        camera_intrinsic=[
            [317.01254197439897, 0.0, 663.4047748335187],
            [0.0, 317.0023758803889, 326.0984106866462],
            [0.0, 0.0, 1.0],
        ],
        distortion=[
            0.08167513010016911,
            0.03127473950834274,
            -0.019971375474817647,
            0.0023991777601088528,
        ],
        axis_signs=[1.0, -1.0, -1.0]),
    dict(
        camera_name='CAM_LEFT',
        camera_model='fisheye',
        camera_intrinsic=[
            [319.39, 0.0, 641.912],
            [0.0, 319.459, 323.807],
            [0.0, 0.0, 1.0],
        ],
        distortion=[0.0772143, 0.0373292, -0.021348, 0.0022813],
        axis_signs=[1.0, -1.0, -1.0]),
    dict(
        camera_name='CAM_BACK',
        camera_model='fisheye',
        camera_intrinsic=[
            [316.04215020904763, 0.0, 657.8146280065309],
            [0.0, 316.11328528450775, 344.8465437212912],
            [0.0, 0.0, 1.0],
        ],
        distortion=[
            0.07865616805982469,
            0.03161245031273102,
            -0.019612367256880002,
            0.0023425362039370423,
        ],
        axis_signs=[1.0, -1.0, -1.0]),
    dict(
        camera_name='CAM_RIGHT',
        camera_model='fisheye',
        camera_intrinsic=[
            [320.606, 0.0, 642.637],
            [0.0, 320.311, 348.676],
            [0.0, 0.0, 1.0],
        ],
        distortion=[0.0752761, 0.038262, -0.0224308, 0.00248036],
        axis_signs=[1.0, -1.0, -1.0]),
]

model = dict(
    view_transform=dict(camera_calibrations=camera_calibrations),
    bbox_head=dict(
        num_classes=3,
        train_cfg=dict(
            min_radius=1,
            code_weights=[1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0])))

object_sampler = dict(
    data_root=data_root,
    info_path=data_root + 'nuscenes_dbinfos_train.pkl',
    rate=1.0,
    prepare=dict(
        filter_by_difficulty=[-1],
        filter_by_min_points={
            'Car': 3,
            'Cone': 5,
            'Pillar': 3,
        }),
    classes=class_names,
    sample_groups={
        'Car': 2,
        'Cone': 3,
        'Pillar': 2,
    },
    points_loader=dict(
        type='LoadPointsFromFile',
        coord_type='LIDAR',
        load_dim=5,
        use_dim=[0, 1, 2, 3, 4],
        backend_args=backend_args))
db_sampler = dict(_delete_=True, **object_sampler)

train_pipeline = [
    dict(
        type='BEVLoadMultiViewImageFromFiles',
        to_float32=True,
        color_type='color',
        num_views=4,
        backend_args=backend_args),
    dict(
        type='LoadPointsFromFile',
        coord_type='LIDAR',
        load_dim=5,
        use_dim=5,
        backend_args=backend_args),
    dict(
        type='LoadPointsFromMultiSweeps',
        sweeps_num=5,
        load_dim=5,
        use_dim=5,
        pad_empty_sweeps=True,
        remove_close=True,
        backend_args=backend_args),
    dict(
        type='FilterVehicleBlindZone',
        car_config_path='outputs/car.json',
        blind_zone_front=1.3,
        blind_zone_rear=1.3),
    dict(
        type='LoadAnnotations3D',
        with_bbox_3d=True,
        with_label_3d=True,
        with_attr_label=False),
    dict(type='ObjectSample', db_sampler=object_sampler),
    dict(
        type='ImageAug3D',
        final_dim=[256, 704],
        resize_lim=image_resize_lim,
        bot_pct_lim=image_bot_pct_lim,
        rot_lim=[-5.4, 5.4],
        rand_flip=True,
        is_train=True),
    dict(
        type='BEVFusionGlobalRotScaleTrans',
        scale_ratio_range=[0.9, 1.1],
        rot_range=[-0.78539816, 0.78539816],
        translation_std=0.5),
    dict(type='BEVFusionRandomFlip3D'),
    dict(type='PointsRangeFilter', point_cloud_range=point_cloud_range),
    dict(type='ObjectRangeFilter', point_cloud_range=point_cloud_range),
    dict(type='ObjectNameFilter', classes=class_names),
    dict(type='FilterBoxesWithoutPoints', min_num_points=1),
    dict(
        type='GridMask',
        use_h=True,
        use_w=True,
        max_epoch=6,
        rotate=1,
        offset=False,
        ratio=0.5,
        mode=1,
        prob=0.0,
        fixed_prob=True),
    dict(type='PointShuffle'),
    dict(
        type='Pack3DDetInputs',
        keys=[
            'points', 'img', 'gt_bboxes_3d', 'gt_labels_3d', 'gt_bboxes',
            'gt_labels'
        ],
        meta_keys=[
            'cam2img', 'ori_cam2img', 'lidar2cam', 'lidar2img', 'cam2lidar',
            'ori_lidar2img', 'img_aug_matrix', 'box_type_3d', 'sample_idx',
            'lidar_path', 'img_path', 'transformation_3d_flow', 'pcd_rotation',
            'pcd_scale_factor', 'pcd_trans', 'lidar_aug_matrix',
            'num_pts_feats'
        ])
]

val_pipeline = [
    dict(
        type='BEVLoadMultiViewImageFromFiles',
        to_float32=True,
        color_type='color',
        num_views=4,
        backend_args=backend_args),
    dict(
        type='LoadPointsFromFile',
        coord_type='LIDAR',
        load_dim=5,
        use_dim=5,
        backend_args=backend_args),
    dict(
        type='LoadPointsFromMultiSweeps',
        sweeps_num=5,
        load_dim=5,
        use_dim=5,
        pad_empty_sweeps=True,
        remove_close=True,
        test_mode=True,
        backend_args=backend_args),
    dict(
        type='FilterVehicleBlindZone',
        car_config_path='outputs/car.json',
        blind_zone_front=1.3,
        blind_zone_rear=1.3),
    dict(
        type='ImageAug3D',
        final_dim=[256, 704],
        resize_lim=[image_val_resize, image_val_resize],
        bot_pct_lim=[image_val_bot_pct, image_val_bot_pct],
        rot_lim=[0.0, 0.0],
        rand_flip=False,
        is_train=False),
    dict(type='PointsRangeFilter', point_cloud_range=point_cloud_range),
    dict(
        type='Pack3DDetInputs',
        keys=['img', 'points', 'gt_bboxes_3d', 'gt_labels_3d'],
        meta_keys=[
            'cam2img', 'ori_cam2img', 'lidar2cam', 'lidar2img', 'cam2lidar',
            'ori_lidar2img', 'img_aug_matrix', 'box_type_3d', 'sample_idx',
            'lidar_path', 'img_path', 'num_pts_feats'
        ])
]

test_pipeline = val_pipeline

train_dataloader = dict(
    batch_size=2,
    num_workers=1,
    persistent_workers=False,
    dataset=dict(
        dataset=dict(
            type=dataset_type,
            ann_file='nuscenes_infos_train_bin.pkl',
            pipeline=train_pipeline,
            metainfo=metainfo,
            modality=input_modality,
            data_prefix=data_prefix,
            use_valid_flag=False,
            backend_args=backend_args)))

lr = 5e-5

optim_wrapper = dict(
    type='AmpOptimWrapper',
    optimizer=dict(type='AdamW', lr=lr, weight_decay=0.01),
    clip_grad=dict(max_norm=35, norm_type=2),
    loss_scale='dynamic')

train_cfg = dict(by_epoch=True, max_epochs=20, val_interval=5)

default_hooks = dict(
    checkpoint=dict(type='CheckpointHook', interval=1))

custom_hooks = [
    dict(type='DisableObjectSampleHook', disable_after_epoch=15),
]

val_dataloader = dict(
    _delete_=True,
    batch_size=1,
    num_workers=1,
    persistent_workers=False,
    drop_last=False,
    sampler=dict(type='DefaultSampler', shuffle=False),
    dataset=dict(
        type=dataset_type,
        data_root=data_root,
        ann_file='nuscenes_infos_test_bin.pkl',
        pipeline=val_pipeline,
        metainfo=metainfo,
        modality=input_modality,
        data_prefix=data_prefix,
        test_mode=True,
        box_type_3d='LiDAR',
        use_valid_flag=False,
        with_velocity=False,
        backend_args=backend_args))

test_dataloader = val_dataloader

val_evaluator = dict(
    _delete_=True,
    type='IndoorMetric',
    iou_thr=[0.25, 0.5, 0.7],
    collect_device='cpu')

test_evaluator = val_evaluator

val_cfg = dict(_delete_=True)
test_cfg = dict(_delete_=True)

param_scheduler = [
    dict(
        type='CosineAnnealingLR',
        T_max=8,
        eta_min=lr * 10,
        begin=0,
        end=8,
        by_epoch=True,
        convert_to_iter_based=True),
    dict(
        type='CosineAnnealingLR',
        T_max=12,
        eta_min=lr * 1e-4,
        begin=8,
        end=20,
        by_epoch=True,
        convert_to_iter_based=True),
    dict(
        type='CosineAnnealingMomentum',
        T_max=8,
        eta_min=0.85 / 0.95,
        begin=0,
        end=8,
        by_epoch=True,
        convert_to_iter_based=True),
    dict(
        type='CosineAnnealingMomentum',
        T_max=12,
        eta_min=1,
        begin=8,
        end=20,
        by_epoch=True,
        convert_to_iter_based=True),
]
