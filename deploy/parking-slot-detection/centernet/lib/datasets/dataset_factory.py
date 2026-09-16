from __future__ import absolute_import
from __future__ import division
from __future__ import print_function

from .sample.ddd import DddDataset
from .sample.exdet import EXDetDataset
from .sample.ctdet import CTDetDataset
from .sample.multi_pose import MultiPoseDataset

from .dataset.coco import COCO
from .dataset.pascal import PascalVOC
from .dataset.my_pascal import MyPascalVOC
from .dataset.kitti import KITTI
from .dataset.coco_hp import COCOHP
from .dataset.my_coco_hp import MyCOCOHP
from .dataset.my_xml_hp import MyXMLHP

dataset_factory = {
  'coco': COCO,
  'pascal': PascalVOC,
  'my_pascal': MyPascalVOC,
  'kitti': KITTI,
  'coco_hp': COCOHP,
  'my_coco_hp': MyCOCOHP,
  'my_xml_hp': MyXMLHP
}

_sample_factory = {
  'exdet': EXDetDataset,
  'ctdet': CTDetDataset,
  'ddd': DddDataset,
  'multi_pose': MultiPoseDataset,
  'ctdet_voc': CTDetDataset,
  'my_ctdet_voc': CTDetDataset,
  'my_multi_pose': MultiPoseDataset
}


def get_dataset(dataset, task):
  class Dataset(dataset_factory[dataset], _sample_factory[task]):
    pass
  return Dataset
  
