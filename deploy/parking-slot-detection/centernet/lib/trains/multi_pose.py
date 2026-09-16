from __future__ import absolute_import
from __future__ import division
from __future__ import print_function

import torch
import numpy as np

from models.losses import FocalLoss, RegL1Loss, RegLoss, RegWeightedL1Loss
from models.decode import multi_pose_decode
from models.utils import _sigmoid, flip_tensor, flip_lr_off, flip_lr
from utils.debugger import Debugger
from utils.post_process import multi_pose_post_process
from utils.oracle_utils import gen_oracle_map
from .base_trainer import BaseTrainer
from datasets import labels

class MultiPoseLoss(torch.nn.Module):
  def __init__(self, opt):
    super(MultiPoseLoss, self).__init__()
    self.crit = FocalLoss()
    self.crit_hm_hp = torch.nn.MSELoss() if opt.mse_loss else FocalLoss()
    self.crit_kp = RegWeightedL1Loss() if not opt.dense_hp else \
                   torch.nn.L1Loss(reduction='sum')
    self.crit_reg = RegL1Loss() if opt.reg_loss == 'l1' else \
                    RegLoss() if opt.reg_loss == 'sl1' else None
    self.crit_seg = torch.nn.CrossEntropyLoss(reduction='mean')
    self.opt = opt
    
    # Determine which loss groups are active based on heads
    group1_heads = ['hm', 'wh', 'reg', 'hps', 'hm_hp', 'hp_offset']
    group2_heads = ['corner_hm', 'corner_hps']
    group3_heads = ['seg']
    
    self.active_groups = []
    if any(h in opt.heads for h in group1_heads):
      self.active_groups.append(0)  # group1 (detection)
    if any(h in opt.heads for h in group2_heads):
      self.active_groups.append(1)  # group2 (corner)
    if any(h in opt.heads for h in group3_heads):
      self.active_groups.append(2)  # group3 (seg)

  def forward(self, outputs, batch):
    opt = self.opt
    device = next(iter(outputs[0].values())).device
    hm_loss = torch.tensor(0.0, device=device)
    wh_loss = torch.tensor(0.0, device=device)
    off_loss = torch.tensor(0.0, device=device)
    hp_loss = torch.tensor(0.0, device=device)
    hm_hp_loss = torch.tensor(0.0, device=device)
    hp_offset_loss = torch.tensor(0.0, device=device)
    corner_hm_loss = torch.tensor(0.0, device=device)
    corner_hp_loss = torch.tensor(0.0, device=device)
    seg_loss = torch.tensor(0.0, device=device)
    for s in range(opt.num_stacks):
      output = outputs[s]
      if 'hm' in output:
        output['hm'] = _sigmoid(output['hm'])
      if opt.hm_hp and not opt.mse_loss:
        output['hm_hp'] = _sigmoid(output['hm_hp'])
      if 'corner_hm' in output:
        output['corner_hm'] = _sigmoid(output['corner_hm'])
      
      if opt.eval_oracle_hmhp:
        output['hm_hp'] = batch['hm_hp']
      if opt.eval_oracle_hm:
        output['hm'] = batch['hm']
      if opt.eval_oracle_kps:
        if opt.dense_hp:
          output['hps'] = batch['dense_hps']
        else:
          output['hps'] = torch.from_numpy(gen_oracle_map(
            batch['hps'].detach().cpu().numpy(), 
            batch['ind'].detach().cpu().numpy(), 
            opt.output_res, opt.output_res)).to(opt.device)
      if opt.eval_oracle_hp_offset:
        output['hp_offset'] = torch.from_numpy(gen_oracle_map(
          batch['hp_offset'].detach().cpu().numpy(), 
          batch['hp_ind'].detach().cpu().numpy(), 
          opt.output_res, opt.output_res)).to(opt.device)

      batch_mask_basic = None  # batch dimension: which images affect basic branch
      basic_cls_mask = None  # class dimension: which classes in hm are affected
      batch_mask_corner = None  # batch dimension: which images affect corner branch
      corner_cls_mask = None  # class dimension: which classes in corner_hm are affected
      batch_mask_seg = None
      if 'standard' in batch:
        batch_standard = batch['standard']  # shape: (batch_size,) with standard indices
        batch_size = batch_standard.shape[0]
        device = batch_standard.device
        
        # Build masks based on standard indices
        if 'hm' in batch:
          batch_mask_basic = torch.zeros(batch_size, dtype=torch.bool, device=device)
          for i in range(batch_size):
            std_idx = batch_standard[i].item()
            if std_idx in labels.kStandardIdxHasBasic and labels.kStandardIdxHasBasic[std_idx]:
              batch_mask_basic[i] = True

        if 'corner_hm' in batch:
          batch_mask_corner = torch.zeros(batch_size, dtype=torch.bool, device=device)
          for i in range(batch_size):
            std_idx = batch_standard[i].item()
            if std_idx in labels.kStandardIdxHasCorner and labels.kStandardIdxHasCorner[std_idx]:
              batch_mask_corner[i] = True

        if 'seg' in batch:
          batch_mask_seg = torch.zeros(batch_size, dtype=torch.bool, device=device)
          for i in range(batch_size):
            std_idx = batch_standard[i].item()
            if std_idx in labels.kStandardIdxHasMask and labels.kStandardIdxHasMask[std_idx]:
              batch_mask_seg[i] = True

      # basic_cls_mask: class dimension mask (which classes in hm are affected)
      # shape: (batch_size, num_basic_classes) or (num_basic_classes,)
      if 'basic_cls_mask' in batch:
        basic_cls_mask = batch['basic_cls_mask']
      
      # corner_cls_mask: class dimension mask (which classes in corner_hm are affected)
      # shape: (batch_size, num_corner_classes) or (num_corner_classes,)
      if 'corner_cls_mask' in batch:
        corner_cls_mask = batch['corner_cls_mask']

      if 'hm' in batch:
        # Pass both batch_mask and cls_mask to loss function
        # cls_mask is applied inside loss function on loss values (not on inputs)
        hm_loss += self.crit(output['hm'], batch['hm'], batch_mask_basic, basic_cls_mask) / opt.num_stacks
      if opt.dense_hp:
        mask_weight = batch['dense_hps_mask'].sum() + 1e-4
        hp_loss += (self.crit_kp(output['hps'] * batch['dense_hps_mask'], 
                                 batch['dense_hps'] * batch['dense_hps_mask']) / 
                                 mask_weight) / opt.num_stacks
      elif 'hps' in batch:
        hp_loss += self.crit_kp(output['hps'], batch['hps_mask'], 
                                batch['ind'], batch['hps']) / opt.num_stacks
      if 'wh' in batch and opt.wh_weight > 0:
        wh_loss += self.crit_reg(output['wh'], batch['reg_mask'],
                                 batch['ind'], batch['wh']) / opt.num_stacks
      if opt.reg_offset and opt.off_weight > 0:
        off_loss += self.crit_reg(output['reg'], batch['reg_mask'],
                                  batch['ind'], batch['reg']) / opt.num_stacks
      if opt.reg_hp_offset and opt.off_weight > 0:
        hp_offset_loss += self.crit_reg(
          output['hp_offset'], batch['hp_mask'],
          batch['hp_ind'], batch['hp_offset']) / opt.num_stacks
      if opt.hm_hp and opt.hm_hp_weight > 0:
        hm_hp_loss += self.crit_hm_hp(
          output['hm_hp'], batch['hm_hp'], None) / opt.num_stacks

      if 'corner_hm' in batch:
        # Pass both batch_mask and cls_mask to loss function
        # cls_mask is applied inside loss function on loss values (not on inputs)
        corner_hm_loss += self.crit(output['corner_hm'], batch['corner_hm'], batch_mask_corner, corner_cls_mask) / opt.num_stacks
      if 'corner_hps' in batch:
        corner_hp_loss += self.crit_kp(output['corner_hps'], batch['corner_hps_mask'], 
                                batch['corner_ind'], batch['corner_hps']) / opt.num_stacks
      
      # Segmentation loss (only for images with mask annotations)
      if 'seg' in batch:
        if batch_mask_seg is not None and batch_mask_seg.any():
          # Only compute loss for images that have mask annotations
          seg_loss += self.crit_seg(output['seg'][batch_mask_seg], batch['seg'][batch_mask_seg]) / opt.num_stacks
        elif batch_mask_seg is None:
          # No standard info, use all images
          seg_loss += self.crit_seg(output['seg'], batch['seg']) / opt.num_stacks

    loss_group1 = opt.hm_weight * hm_loss + opt.wh_weight * wh_loss + \
           opt.off_weight * off_loss + opt.hp_weight * hp_loss + \
           opt.hm_hp_weight * hm_hp_loss + opt.off_weight * hp_offset_loss
    
    loss_group2 = opt.hm_weight * corner_hm_loss + opt.hp_weight * corner_hp_loss
    
    loss_group3 = seg_loss  # segmentation loss

    loss = loss_group1 + loss_group2 + loss_group3
    
    loss_stats = {'loss': loss}
    
    if 'hm' in batch:
      loss_stats['hm_loss'] = hm_loss
    if 'hps' in batch:
      loss_stats['hp_loss'] = hp_loss
    if 'hm_hp' in batch: 
      loss_stats['hm_hp_loss'] = hm_hp_loss
    if 'hp_offset' in batch:
      loss_stats['hp_offset_loss'] = hp_offset_loss
    if 'wh' in batch:  
      loss_stats['wh_loss'] = wh_loss
    if 'reg' in batch:   
      loss_stats['off_loss'] = off_loss
    if 'corner_hm' in batch:
      loss_stats['corner_hm_loss'] = corner_hm_loss
    if 'corner_hps' in batch:
      loss_stats['corner_hp_loss'] = corner_hp_loss
    if 'seg' in batch:
      loss_stats['seg_loss'] = seg_loss

    # Only return active loss groups for MTL
    all_groups = [loss_group1, loss_group2, loss_group3]
    active_loss_groups = tuple(all_groups[i] for i in self.active_groups)
    
    return loss, loss_stats, active_loss_groups

class MultiPoseTrainer(BaseTrainer):
  def __init__(self, opt, model, optimizer=None):
    super(MultiPoseTrainer, self).__init__(opt, model, optimizer=optimizer)
  
  def _get_losses(self, opt):
    loss_states = ['loss']
    
    if 'hm' in opt.heads:
      loss_states.append('hm_loss')
    if 'hps' in opt.heads:
      loss_states.append('hp_loss')
    if 'hm_hp' in opt.heads:  
      loss_states.append('hm_hp_loss')
    if 'hp_offset' in opt.heads: 
      loss_states.append('hp_offset_loss')
    if 'wh' in opt.heads:  
      loss_states.append('wh_loss')
    if 'reg' in opt.heads:  
      loss_states.append('off_loss')
    if 'corner_hm' in opt.heads:
      loss_states.append('corner_hm_loss')
    if 'corner_hps' in opt.heads:
      loss_states.append('corner_hp_loss')
    if 'seg' in opt.heads:
      loss_states.append('seg_loss')
    loss = MultiPoseLoss(opt)

    # Dynamic n_task based on active loss groups
    n_task = len(loss.active_groups)

    return loss_states, loss, n_task


  def debug(self, batch, output, iter_id):
    opt = self.opt
    reg = output['reg'] if opt.reg_offset else None
    hm_hp = output['hm_hp'] if opt.hm_hp else None
    hp_offset = output['hp_offset'] if opt.reg_hp_offset else None
    dets_dict = multi_pose_decode(
      output['hm'], output['wh'], output['hps'], 
      reg=reg, hm_hp=hm_hp, hp_offset=hp_offset,
      seg=output.get('seg'), K=opt.K)
    dets = dets_dict[''].detach().cpu().numpy().reshape(1, -1, dets_dict[''].shape[2])

    dets[:, :, :4] *= opt.input_res / opt.output_res
    dets[:, :, 5:5+opt.num_joints*2] *= opt.input_res / opt.output_res

    dets_gt = batch['meta']['gt_det']
    if not isinstance(dets_gt, list):
      dets_gt = dets_gt.numpy().reshape(1, -1, dets.shape[2])
    else:
      # TODO: list of objs with different number of keypoints
      pass
    dets_gt[:, :, :4] *= opt.input_res / opt.output_res
    dets_gt[:, :, 5:5+opt.num_joints*2] *= opt.input_res / opt.output_res
    for i in range(1):
      debugger = Debugger(
        dataset=opt.dataset, ipynb=(opt.debug==3), theme=opt.debugger_theme)
      img = batch['input'][i].detach().cpu().numpy().transpose(1, 2, 0)
      img = np.clip(((
        img * opt.std + opt.mean) * 255.), 0, 255).astype(np.uint8)
      pred = debugger.gen_colormap(output['hm'][i].detach().cpu().numpy())
      gt = debugger.gen_colormap(batch['hm'][i].detach().cpu().numpy())
      debugger.add_blend_img(img, pred, 'pred_hm')
      debugger.add_blend_img(img, gt, 'gt_hm')

      debugger.add_img(img, img_id='out_pred')
      for k in range(len(dets[i])):
        if dets[i, k, 4] > opt.center_thresh:
          debugger.add_coco_bbox(dets[i, k, :4], dets[i, k, -1],
                                 dets[i, k, 4], img_id='out_pred')
          debugger.add_coco_hp(dets[i, k, 5:5+opt.num_joints*2], img_id='out_pred')

      debugger.add_img(img, img_id='out_gt')
      for k in range(len(dets_gt[i])):
        if dets_gt[i, k, 4] > opt.center_thresh:
          debugger.add_coco_bbox(dets_gt[i, k, :4], dets_gt[i, k, -1],
                                 dets_gt[i, k, 4], img_id='out_gt')
          debugger.add_coco_hp(dets_gt[i, k, 5:5+opt.num_joints*2], img_id='out_gt')

      if opt.hm_hp:
        pred = debugger.gen_colormap_hp(output['hm_hp'][i].detach().cpu().numpy())
        gt = debugger.gen_colormap_hp(batch['hm_hp'][i].detach().cpu().numpy())
        debugger.add_blend_img(img, pred, 'pred_hmhp')
        debugger.add_blend_img(img, gt, 'gt_hmhp')

      if opt.debug == 4:
        debugger.save_all_imgs(opt.debug_dir, prefix='{}'.format(iter_id))
      else:
        debugger.show_all_imgs(pause=True)

  def save_result(self, output, batch, results):
    reg = output['reg'] if self.opt.reg_offset else None
    hm_hp = output['hm_hp'] if self.opt.hm_hp else None
    hp_offset = output['hp_offset'] if self.opt.reg_hp_offset else None
    dets_dict = multi_pose_decode(
      output['hm'], output['wh'], output['hps'], 
      reg=reg, hm_hp=hm_hp, hp_offset=hp_offset,
      seg=output.get('seg'), K=self.opt.K)
    dets = dets_dict[''].detach().cpu().numpy().reshape(1, -1, dets_dict[''].shape[2])
    
    dets_out = multi_pose_post_process(
      dets.copy(), batch['meta']['c'].cpu().numpy(),
      batch['meta']['s'].cpu().numpy(),
      output['hm'].shape[2], output['hm'].shape[3], output['hm'].shape[1], output['hm_hp'].shape[1])
    results[batch['meta']['img_id'].cpu().numpy()[0]] = dets_out[0]