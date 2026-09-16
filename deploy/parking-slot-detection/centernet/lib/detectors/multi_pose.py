from __future__ import absolute_import
from __future__ import division
from __future__ import print_function

import cv2
import numpy as np
from progress.bar import Bar
import time
import torch

try:
  from external.nms import soft_nms_39
except:
  print('NMS not imported! If you need it,'
        ' do \n cd $CenterNet_ROOT/src/lib/external \n make')
from models.decode import multi_pose_decode
from models.utils import flip_tensor, flip_lr_off, flip_lr
from utils.image import get_affine_transform
from utils.post_process import multi_pose_post_process
from utils.debugger import Debugger

from .base_detector import BaseDetector

class MultiPoseDetector(BaseDetector):
  def __init__(self, opt):
    super(MultiPoseDetector, self).__init__(opt)
    self.flip_idx = opt.flip_idx
    # Get corner class count from heads if available
    self.num_corner_classes = opt.heads.get('corner_hm', 0)

  def process(self, images, return_time=False):
    with torch.no_grad():
      torch.cuda.synchronize()
      output = self.model(images)[-1]
      # print('==keys:')
      # for k in sorted(output.keys()):
      #   print(k, output[k].shape)
      if 'hm' in output:
        output['hm'] = output['hm'].sigmoid_()
      if 'hm_hp' in output and not self.opt.mse_loss:
        output['hm_hp'] = output['hm_hp'].sigmoid_()
      if 'corner_hm' in output:
        output['corner_hm'] = output['corner_hm'].sigmoid_()

      reg = output.get('reg')
      hm_hp = output.get('hm_hp')
      hp_offset = output.get('hp_offset')
      torch.cuda.synchronize()
      forward_time = time.time()
      
      if self.opt.flip_test:
        output['hm'] = (output['hm'][0:1] + flip_tensor(output['hm'][1:2])) / 2
        output['wh'] = (output['wh'][0:1] + flip_tensor(output['wh'][1:2])) / 2
        output['hps'] = (output['hps'][0:1] + 
          flip_lr_off(output['hps'][1:2], self.flip_idx, self.opt.num_joints)) / 2
        hm_hp = (hm_hp[0:1] + flip_lr(hm_hp[1:2], self.flip_idx)) / 2 \
                if hm_hp is not None else None
        reg = reg[0:1] if reg is not None else None
        hp_offset = hp_offset[0:1] if hp_offset is not None else None

      dets = multi_pose_decode(
        output.get('hm'), output.get('wh'), output.get('hps'),
        reg=reg, hm_hp=hm_hp, hp_offset=hp_offset, 
        corner_hm=output.get('corner_hm'), corner_hps=output.get('corner_hps'),
        seg=output.get('seg'),
        K=self.opt.K)
    if return_time:
      return output, dets, forward_time
    else:
      return output, dets

  def post_process(self, in_dets, meta, scale=1):
    out_dets = {}
    for key in in_dets:
      # Handle segmentation output separately
      if key == 'seg':
        # seg is already (batch, H, W) class indices, just convert to numpy
        seg = in_dets[key]
        out_dets['seg'] = seg.detach().cpu().numpy()
        continue

      num_classes = self.num_classes
      num_joints = self.opt.num_joints
      if key == 'corner':
        num_classes = self.num_corner_classes
        num_joints = 3

      dets = in_dets[key]
      dets = dets.detach().cpu().numpy()
      
      dets = dets.reshape(1, -1, dets.shape[2])
      dets = multi_pose_post_process(
        dets.copy(), [meta['c']], [meta['s']],
        meta['out_height'], meta['out_width'],
        num_classes, num_joints)
      
      # Weizhe: only 1 class is supported by original code.
      # to fully support multiple classes may need to detect heat map of keypoints for every classes
      # to paritally support multiple classes, we can ommit keypoints heat map and only use keypoints regression.
      dets_0 = dets[0] # first batch
      for j in range(1, num_classes + 1):
        dets_0[j] = np.array(dets_0[j], dtype=np.float32).reshape(-1, 5+num_joints*2)
        # import pdb; pdb.set_trace()
        dets_0[j][:, :4] /= scale
        dets_0[j][:, 5:] /= scale

      out_dets[key] = dets_0

    return out_dets

  def merge_outputs(self, detections):
    dets_dict = {}
    for dets in detections:
      for key in dets:
        if key in dets_dict:
          dets_dict[key].append(dets[key])
        else:
          dets_dict[key] = [dets[key]]

    result_dict = {}
    for key in dets_dict:
      # Handle segmentation output separately
      if key == 'seg':
        # For seg, just use the first scale result (or could average)
        result_dict['seg'] = dets_dict['seg'][0]
        continue

      num_classes = self.num_classes
      if key == 'corner':
        num_classes = self.num_corner_classes
      detections = dets_dict[key]

      results = {}
      for j in range(1, num_classes + 1):
        dets = [detection[j] for detection in detections]
        results[j] = np.concatenate(dets, axis=0).astype(np.float32)
        if self.opt.nms or len(self.opt.test_scales) > 1:
          soft_nms_39(results[j], Nt=0.5, method=2)
      #results[1] = results[1].tolist()
      result_dict[key] = results

    return result_dict

  def debug(self, debugger, images, in_dets, output, scale=1):
    # dets = dets.detach().cpu().numpy().copy()
    # dets[:, :, :4] *= self.opt.down_ratio
    # dets[:, :, 5:5+self.opt.num_joints*2] *= self.opt.down_ratio
    img = images[0].detach().cpu().numpy().transpose(1, 2, 0)
    img = np.clip(((
      img * self.std + self.mean) * 255.), 0, 255).astype(np.uint8)
    pred = debugger.gen_colormap(output['hm'][0].detach().cpu().numpy())
    debugger.add_blend_img(img, pred, 'pred_hm')
    if 'hm_hp' in output:
      pred = debugger.gen_colormap_hp(output['hm_hp'][0].detach().cpu().numpy())
      debugger.add_blend_img(img, pred, 'pred_hmhp')

    if 'corner_hm' in output:
      pred = debugger.gen_colormap(output['corner_hm'][0].detach().cpu().numpy())
      debugger.add_blend_img(img, pred, 'pred_corner_hm')
  
  def show_results(self, debugger, image, result_dict):
    debugger.add_img(image, img_id='multi_pose')

    for key in result_dict:
      # Skip segmentation in show_results (handled separately if needed)
      if key == 'seg':
        continue

      num_classes = self.num_classes
      num_joints = self.opt.num_joints
      if key == 'corner':
        num_classes = self.num_corner_classes
        num_joints = 3
      results = result_dict[key]  
      for j in range(1, num_classes + 1):
        for bbox in results[j]:
          if bbox[4] > self.opt.vis_thresh:
            debugger.add_coco_bbox(bbox[:4], j - 1, bbox[4], img_id='multi_pose')
            debugger.add_coco_hp(bbox[5:5+num_joints*2], num_joints, img_id='multi_pose')
    debugger.show_all_imgs(pause=self.pause)