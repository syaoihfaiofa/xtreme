from typing import Dict, List

import numpy as np


def _sample_with_ratio(cls_inds, ratio):
    """根据比例采样，确保所有原样本都被包含
    
    Args:
        cls_inds: 类别样本索引列表
        ratio: 采样比例
    
    Returns:
        采样后的索引列表
    """
    target_count = int(len(cls_inds) * ratio)
    
    if target_count <= len(cls_inds):
        sample_indices = np.random.choice(cls_inds, target_count).tolist()
    else:
        # 过采样，先包含所有原样本
        sample_indices = cls_inds.copy()
        
        # 整数倍复制
        for _ in range(int(ratio) - 1):
            sample_indices += cls_inds
        
        # 小数部分随机采样
        if ratio % 1 > 0:
            fractional_count = int(len(cls_inds) * (ratio % 1))
            if fractional_count > 0:
                sample_indices += np.random.choice(cls_inds, fractional_count).tolist()
    
    return sample_indices


class CBGSDataset(object):
    """A wrapper of class sampled dataset.

    Implementation of paper
    `Class-balanced Grouping and Sampling for Point Cloud 3D Object
    Detection <https://arxiv.org/abs/1908.09492.>`_.

    Balance the number of scenes under different classes.

    Args:
        dataset: The dataset to be class sampled.
    """
                            
    def __init__(self, dataset):
        self.dataset = dataset
        
        self.sample_indices = self._get_sample_indices()
        

    def _get_sample_indices(self):
        class_sample_idxs = {cat_id: [] for cat_id in self.dataset.cat2id.values()}
        class_sample_idxs[-1] = []  # 负样本（没有标注的图片）
        
        for idx in range(len(self.dataset)):
            sample_cat_ids = self.dataset.get_cat_ids(idx)
            if len(sample_cat_ids) == 0:
                # 没有标注的图片作为负样本
                class_sample_idxs[-1].append(idx)
            else:
                for cat_id in sample_cat_ids:
                    class_sample_idxs[cat_id].append(idx)
        
        sample_indices = []

        # 计算每个类别的目标比例（包括负样本）
        num_classes = sum(1 for cls_inds in class_sample_idxs.values() if len(cls_inds) > 0)
        frac = 1.0 / num_classes
        
        for cls_inds in class_sample_idxs.values():
            if len(cls_inds) == 0:
                continue
            # 计算该类别的目标比例
            target_ratio = frac * len(self.dataset) / len(cls_inds)
            sample_indices += _sample_with_ratio(cls_inds, target_ratio)
        
        total_count = sum(len(cls_inds) for cls_inds in class_sample_idxs.values())
        negative_count = len(class_sample_idxs[-1])
        active_classes = sum(1 for cls_inds in class_sample_idxs.values() if len(cls_inds) > 0)
        print(f'CBGS: origin {len(self.dataset)} duplicated total {total_count} sampled total {len(sample_indices)} \
            origin classes {len(self.dataset.cat2id)+1} active classes {active_classes} negative samples {negative_count}')
        return sample_indices

    def __getitem__(self, idx):
        """Get item from infos according to the given index.

        Returns:
            dict: Data dictionary of the corresponding index.
        """
        ori_idx = self.sample_indices[idx]
        return self.dataset[ori_idx]

    def __len__(self):
        """Return the length of data infos.

        Returns:
            int: Length of data infos.
        """
        return len(self.sample_indices)


class CBGSDatasetV2(object):
    """改进的CBGS实现，确保所有数据都被使用。
    
    通过重复采样来平衡类别分布，而不是丢弃数据。
    """
                            
    def __init__(self, dataset):
        self.dataset = dataset
        
        self.sample_indices = self._get_sample_indices()
        

    def _get_sample_indices(self):
        class_sample_idxs = {cat_id: [] for cat_id in self.dataset.cat2id.values()}
        class_sample_idxs[-1] = []  # 负样本（没有标注的图片）
        
        for idx in range(len(self.dataset)):
            sample_cat_ids = self.dataset.get_cat_ids(idx)
            if len(sample_cat_ids) == 0:
                # 没有标注的图片作为负样本
                class_sample_idxs[-1].append(idx)
            else:
                for cat_id in sample_cat_ids:
                    class_sample_idxs[cat_id].append(idx)
        
        # 计算每个类别的样本数量
        class_counts = {k: len(v) for k, v in class_sample_idxs.items()}
        max_count = max(class_counts.values())
        
        sample_indices = []
        
        # 为每个类别计算采样比例，确保所有数据都被使用
        for cat_id, cls_inds in class_sample_idxs.items():
            if len(cls_inds) == 0:
                continue
                
            # 计算采样比例：目标数量 / 当前数量
            ratio = max_count / len(cls_inds)
            
            sample_indices += _sample_with_ratio(cls_inds, ratio)

        total_count = sum(class_counts.values())
        negative_count = len(class_sample_idxs[-1])
        active_classes = sum(1 for cls_inds in class_sample_idxs.values() if len(cls_inds) > 0)
        print(f'CBGSV2: origin {len(self.dataset)} duplicated total {total_count} sampled total {len(sample_indices)} \
            origin classes {len(self.dataset.cat2id)+1} active classes {active_classes} negative samples {negative_count}')
        return sample_indices

    def __getitem__(self, idx):
        """Get item from infos according to the given index.

        Returns:
            dict: Data dictionary of the corresponding index.
        """
        ori_idx = self.sample_indices[idx]
        return self.dataset[ori_idx]

    def __len__(self):
        """Return the length of data infos.

        Returns:
            int: Length of data infos.
        """
        return len(self.sample_indices)
