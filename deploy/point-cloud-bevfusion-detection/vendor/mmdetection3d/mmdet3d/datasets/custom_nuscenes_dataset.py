# Copyright (c) OpenMMLab. All rights reserved.
import numpy as np

from mmdet3d.registry import DATASETS

from .nuscenes_dataset import NuScenesDataset


@DATASETS.register_module()
class CustomNuScenesDataset(NuScenesDataset):
    """NuScenes dataset variant for the seven Xtreme1 source categories."""

    METAINFO = {
        'classes': (
            'Car',
            'Cone',
            'No Parking Board',
            'Parking Lock (Locked)',
            'Person',
            'Pillar',
            'Pole',
        ),
    }

    def _filter_with_mask(self, ann_info: dict) -> dict:
        """Keep valid boxes without relying on lidar-point statistics."""
        dimensions = ann_info['gt_bboxes_3d'][:, 3:6]
        filter_mask = np.isfinite(dimensions).all(axis=1) & (dimensions > 0).all(
            axis=1)
        return {
            key: value if key == 'instances' else value[filter_mask]
            for key, value in ann_info.items()
        }
