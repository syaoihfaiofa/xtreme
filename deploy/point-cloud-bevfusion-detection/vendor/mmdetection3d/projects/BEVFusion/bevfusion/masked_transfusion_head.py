from typing import List, Tuple

import torch
from mmengine.structures import InstanceData

from mmdet3d.registry import MODELS

from .transfusion_head import TransFusionHead, clip_sigmoid


@MODELS.register_module()
class MaskedTransFusionHead(TransFusionHead):
    """TransFusion head with per-sample class supervision masks."""

    def loss(self, batch_feats: List[torch.Tensor],
             batch_data_samples: List[InstanceData]) -> dict[str, torch.Tensor]:
        batch_input_metas = []
        batch_gt_instances_3d = []
        class_supervision_masks = []
        for data_sample in batch_data_samples:
            batch_input_metas.append(data_sample.metainfo)
            batch_gt_instances_3d.append(data_sample.gt_instances_3d)
            class_supervision_masks.append(
                data_sample.metainfo.get('class_supervision_mask'))
        preds_dicts = self(batch_feats, batch_input_metas)
        device = preds_dicts[0][0]['dense_heatmap'].device
        masks = self._get_class_supervision_masks(
            class_supervision_masks, device)
        return self.loss_by_feat(
            preds_dicts, batch_gt_instances_3d, class_supervision_masks=masks)

    def _get_class_supervision_masks(
            self, masks: list[object], device: torch.device) -> torch.Tensor:
        normalized_masks = []
        for mask in masks:
            if mask is None:
                normalized_masks.append(
                    torch.ones(self.num_classes, device=device, dtype=torch.bool))
            else:
                normalized_masks.append(
                    torch.as_tensor(mask, device=device, dtype=torch.bool))
        return torch.stack(normalized_masks)

    def loss_by_feat(
            self, preds_dicts: Tuple[List[dict]],
            batch_gt_instances_3d: List[InstanceData],
            class_supervision_masks: torch.Tensor,
            *args, **kwargs) -> dict[str, torch.Tensor]:
        (labels, label_weights, bbox_targets, bbox_weights, ious, num_pos,
         matched_ious, heatmap) = self.get_targets(batch_gt_instances_3d,
                                                   preds_dicts[0])
        if hasattr(self, 'on_the_image_mask'):
            label_weights = label_weights * self.on_the_image_mask
            bbox_weights = bbox_weights * self.on_the_image_mask[:, :, None]
            num_pos = bbox_weights.max(-1).values.sum()
        preds_dict = preds_dicts[0][0]
        loss_dict = {}
        heatmap_weights = class_supervision_masks[:, :, None, None].to(
            dtype=heatmap.dtype)
        heatmap_weights = heatmap_weights * self._get_visibility_heatmap_weights(
            batch_gt_instances_3d, heatmap)
        enabled_positives = (heatmap.eq(1) * heatmap_weights).sum().item()
        loss_dict['loss_heatmap'] = self.loss_heatmap(
            clip_sigmoid(preds_dict['dense_heatmap']).float(),
            heatmap.float(),
            weight=heatmap_weights,
            avg_factor=max(enabled_positives, 1),
        )

        for idx_layer in range(
                self.num_decoder_layers if self.auxiliary else 1):
            prefix = ('layer_-1' if
                      (idx_layer == self.num_decoder_layers - 1 or
                       (idx_layer == 0 and not self.auxiliary)) else
                      f'layer_{idx_layer}')
            proposal_slice = slice(
                idx_layer * self.num_proposals,
                (idx_layer + 1) * self.num_proposals)
            layer_labels = labels[..., proposal_slice].reshape(-1)
            layer_label_weights = label_weights[..., proposal_slice]
            layer_score = preds_dict['heatmap'][..., proposal_slice]
            layer_cls_score = layer_score.permute(0, 2, 1).reshape(
                -1, self.num_classes)
            class_weights = (
                layer_label_weights[..., None] *
                class_supervision_masks[:, None, :].to(
                    dtype=layer_label_weights.dtype)).reshape(
                        -1, self.num_classes)
            layer_loss_cls = self.loss_cls(
                layer_cls_score.float(),
                layer_labels,
                class_weights,
                avg_factor=max(num_pos, 1),
            )

            layer_center = preds_dict['center'][..., proposal_slice]
            layer_height = preds_dict['height'][..., proposal_slice]
            layer_rot = preds_dict['rot'][..., proposal_slice]
            layer_dim = preds_dict['dim'][..., proposal_slice]
            preds = torch.cat(
                [layer_center, layer_height, layer_dim, layer_rot],
                dim=1).permute(0, 2, 1)
            if 'vel' in preds_dict:
                layer_vel = preds_dict['vel'][..., proposal_slice]
                preds = torch.cat([
                    layer_center, layer_height, layer_dim, layer_rot, layer_vel
                ], dim=1).permute(0, 2, 1)
            code_weights = self.train_cfg.get('code_weights', None)
            layer_bbox_weights = bbox_weights[:, proposal_slice, :]
            layer_reg_weights = layer_bbox_weights * layer_bbox_weights.new_tensor(
                code_weights)
            layer_bbox_targets = bbox_targets[:, proposal_slice, :]
            layer_loss_bbox = self.loss_bbox(
                preds,
                layer_bbox_targets,
                layer_reg_weights,
                avg_factor=max(num_pos, 1))
            loss_dict[f'{prefix}_loss_cls'] = layer_loss_cls
            loss_dict[f'{prefix}_loss_bbox'] = layer_loss_bbox
        loss_dict['matched_ious'] = layer_loss_cls.new_tensor(matched_ious)
        return loss_dict

    def _get_visibility_heatmap_weights(
            self, batch_gt_instances_3d: List[InstanceData],
            heatmap: torch.Tensor) -> torch.Tensor:
        weights = torch.ones_like(heatmap)
        voxel_size = heatmap.new_tensor(self.train_cfg['voxel_size'])
        pc_range = heatmap.new_tensor(self.train_cfg['point_cloud_range'])
        out_size_factor = self.train_cfg['out_size_factor']
        for batch_idx, instances in enumerate(batch_gt_instances_3d):
            instance_weights = getattr(instances, 'visibility_weights', None)
            if instance_weights is None:
                continue
            centers = instances.bboxes_3d.gravity_center
            labels = instances.labels_3d
            for center, label, weight in zip(centers, labels,
                                             instance_weights):
                x = int((center[0] - pc_range[0]) / voxel_size[0] /
                        out_size_factor)
                y = int((center[1] - pc_range[1]) / voxel_size[1] /
                        out_size_factor)
                if 0 <= x < heatmap.shape[-1] and 0 <= y < heatmap.shape[-2]:
                    weights[batch_idx, label, y, x] = weight
        return weights
