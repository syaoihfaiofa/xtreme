# Copyright (c) OpenMMLab. All rights reserved.
from mmdet3d.registry import DATASETS

from .custom_nuscenes_dataset import CustomNuScenesDataset


@DATASETS.register_module()
class CustomNuScenesThreeClassDataset(CustomNuScenesDataset):
    """NuScenes dataset variant retaining Car, Cone, and Pillar only."""

    METAINFO = CustomNuScenesDataset.METAINFO

    def parse_ann_info(self, info: dict) -> dict:
        """Remove categories excluded by the configured target metainfo."""
        ann_info = super().parse_ann_info(info)
        keep_mask = ann_info['gt_labels_3d'] >= 0
        ann_info['gt_bboxes_3d'] = ann_info['gt_bboxes_3d'][keep_mask]
        ann_info['gt_labels_3d'] = ann_info['gt_labels_3d'][keep_mask]
        return ann_info
