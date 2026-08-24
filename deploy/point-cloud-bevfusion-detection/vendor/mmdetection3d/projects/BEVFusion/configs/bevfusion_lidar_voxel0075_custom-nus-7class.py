_base_ = [
    './bevfusion_lidar_voxel0075_second_secfpn_8xb4-cyclic-20e_nus-3d.py'
]

voxel_size = [0.075, 0.075, 0.2]
point_cloud_range = [-21.0, -21.0, -5.0, 21.0, 21.0, 4.0]
class_names = [
    'Car',
    'Cone',
    'No Parking Board',
    'Parking Lock (Locked)',
    'Person',
    'Pillar',
    'Pole',
]
metainfo = dict(classes=class_names)
dataset_type = 'CustomNuScenesDataset'
data_root = 'data/nuscenes/'
data_prefix = dict(pts='samples/LIDAR_TOP', sweeps='sweeps/LIDAR_TOP')
input_modality = dict(use_lidar=True, use_camera=False)
backend_args = None

model = dict(
    data_preprocessor=dict(
        voxelize_cfg=dict(
            max_num_points=10,
            point_cloud_range=point_cloud_range,
            voxel_size=voxel_size,
            max_voxels=[120000, 160000],
            voxelize_reduce=True)),
    pts_middle_encoder=dict(sparse_shape=[560, 560, 46]),
    bbox_head=dict(
        num_classes=7,
        train_cfg=dict(
            dataset='custom',
            point_cloud_range=point_cloud_range,
            grid_size=[560, 560, 46],
            voxel_size=voxel_size),
        test_cfg=dict(
            dataset='custom',
            grid_size=[560, 560, 46],
            voxel_size=voxel_size[:2],
            pc_range=point_cloud_range[:2]),
        bbox_coder=dict(
            pc_range=point_cloud_range[:2],
            post_center_range=point_cloud_range,
            voxel_size=voxel_size[:2])))

object_sampler = dict(
    data_root=data_root,
    info_path=data_root + 'nuscenes_dbinfos_train.pkl',
    rate=1.0,
    prepare=dict(
        filter_by_difficulty=[-1],
        filter_by_min_points={
            'Car': 1,
            'Cone': 1,
            'No Parking Board': 1,
            'Parking Lock (Locked)': 1,
            'Person': 1,
            'Pillar': 1,
            'Pole': 1,
        }),
    classes=class_names,
    sample_groups={
        'Car': 2,
        'Cone': 2,
        'No Parking Board': 2,
        'Parking Lock (Locked)': 2,
        'Person': 2,
        'Pillar': 2,
        'Pole': 2,
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
        sweeps_num=9,
        load_dim=5,
        use_dim=5,
        pad_empty_sweeps=True,
        remove_close=True,
        backend_args=backend_args),
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

test_pipeline = [
    dict(
        type='LoadPointsFromFile',
        coord_type='LIDAR',
        load_dim=5,
        use_dim=5,
        backend_args=backend_args),
    dict(
        type='LoadPointsFromMultiSweeps',
        sweeps_num=9,
        load_dim=5,
        use_dim=5,
        pad_empty_sweeps=True,
        remove_close=True,
        test_mode=True,
        backend_args=backend_args),
    dict(type='PointsRangeFilter', point_cloud_range=point_cloud_range),
    dict(
        type='Pack3DDetInputs',
        keys=['points', 'gt_bboxes_3d', 'gt_labels_3d'],
        meta_keys=[
            'box_type_3d', 'sample_idx', 'lidar_path', 'num_pts_feats'
        ])
]

train_dataloader = dict(
    dataset=dict(
        dataset=dict(
            type=dataset_type,
            data_root=data_root,
            ann_file='nuscenes_infos_train.pkl',
            pipeline=train_pipeline,
            metainfo=metainfo,
            modality=input_modality,
            test_mode=False,
            data_prefix=data_prefix,
            use_valid_flag=False,
            box_type_3d='LiDAR',
            backend_args=backend_args)))
val_dataloader = None
test_dataloader = None
val_evaluator = None
test_evaluator = None
val_cfg = None
test_cfg = None
default_hooks = dict(logger=dict(interval=10))
train_cfg = dict(by_epoch=True, max_epochs=20, val_interval=20)
