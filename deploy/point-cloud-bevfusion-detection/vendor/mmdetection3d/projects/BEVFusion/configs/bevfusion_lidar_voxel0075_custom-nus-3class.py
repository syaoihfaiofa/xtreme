_base_ = [
    './bevfusion_lidar_voxel0075_custom-nus-7class.py'
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
    pts='samples/LIDAR_TOP_BIN', sweeps='sweeps/LIDAR_TOP_BIN')
input_modality = dict(use_lidar=True, use_camera=False)
backend_args = None

model = dict(
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
        type='GlobalRotScaleTrans',
        scale_ratio_range=[0.9, 1.1],
        rot_range=[-0.78539816, 0.78539816],
        translation_std=0.5),
    dict(type='BEVFusionRandomFlip3D'),
    dict(type='PointsRangeFilter', point_cloud_range=point_cloud_range),
    dict(type='ObjectRangeFilter', point_cloud_range=point_cloud_range),
    dict(type='ObjectNameFilter', classes=class_names),
    dict(type='FilterBoxesWithoutPoints', min_num_points=1),
    dict(type='PointShuffle'),
    dict(
        type='Pack3DDetInputs',
        keys=['points', 'gt_bboxes_3d', 'gt_labels_3d'],
        meta_keys=[
            'box_type_3d', 'sample_idx', 'lidar_path',
            'transformation_3d_flow', 'pcd_rotation', 'pcd_scale_factor',
            'pcd_trans', 'lidar_aug_matrix'
        ])
]

train_dataloader = dict(
    batch_size=4,
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

val_pipeline = [
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
    dict(type='PointsRangeFilter', point_cloud_range=point_cloud_range),
    dict(
        type='Pack3DDetInputs',
        keys=['points', 'gt_bboxes_3d', 'gt_labels_3d'],
        meta_keys=['box_type_3d', 'sample_idx', 'lidar_path', 'num_pts_feats']),
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
