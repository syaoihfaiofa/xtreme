from mmdet3d.registry import DATASETS

from .custom_nuscenes_dataset import CustomNuScenesDataset


@DATASETS.register_module()
class CustomNuScenesTenClassDataset(CustomNuScenesDataset):
    """Dataset variant mapping 12 source labels to a configured subset."""

    # Keep source labels here so Det3DDataset can map unselected labels to -1
    # before annotation parsing. The config supplies the selected 10 classes.
    METAINFO = CustomNuScenesDataset.METAINFO
