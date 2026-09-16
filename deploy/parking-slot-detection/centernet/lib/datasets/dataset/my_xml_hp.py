from __future__ import absolute_import
from __future__ import division
from __future__ import print_function

import os
import numpy as np
import torch.utils.data as data
from .. import labels

class MyXMLHP(data.Dataset):
  num_joints = 4
  default_resolution = [512, 512]
  mean = np.array([0.40789654, 0.44719302, 0.47026115],
                   dtype=np.float32).reshape(1, 1, 3)
  std  = np.array([0.28863828, 0.27408164, 0.27809835],
                   dtype=np.float32).reshape(1, 1, 3)
  flip_idx = [[0, 3], [1, 2]]
  flip_idx_corner = [[0, 2]]

  def _get_label2id(self, labels_path):
    """Get label name to category ID mapping (0-indexed)."""
    lbl = labels.Labels(labels_path)
    return lbl.cat2id

  def _loadFromTxt(self, filepath):
    file_names = []
    with open(filepath) as file:
      for line in file:
        line = line.strip()
        if len(line) > 0:
          file_names.append(line)
    return file_names

  def __init__(self, opt, split):
    super(MyXMLHP, self).__init__()
    self.data_dir = os.path.join(opt.data_dir, opt.dataset_name)
    self.img_dir = os.path.join(self.data_dir, 'JPEGImages')
    self.anno_dir = os.path.join(self.data_dir, 'Annotations')
    self.splitset_dir = os.path.join(self.data_dir, opt.split_set)

    self.max_objs = 32
    self._data_rng = np.random.RandomState(123)
    self._eig_val = np.array([0.2141788, 0.01817699, 0.00341571],
                             dtype=np.float32)
    self._eig_vec = np.array([
        [-0.58752847, -0.69563484, 0.41340352],
        [-0.5832747, 0.00994535, -0.81221408],
        [-0.56089297, 0.71832671, 0.41158938]
    ], dtype=np.float32)
    self.split = split
    self.opt = opt

    self.cat2id = self._get_label2id(labels_path=opt.labels_file)
    
    print('==> initializing {} data.'.format(split))
    file_path = os.path.join(self.splitset_dir, split+".txt")
    self.relative_paths = self._loadFromTxt(file_path)
    self.sample_nums = len(self.relative_paths)
    print('Loaded {} {} samples'.format(split, self.sample_nums))

  def __len__(self):
    return self.sample_nums
