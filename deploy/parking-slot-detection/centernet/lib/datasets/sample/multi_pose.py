from __future__ import absolute_import
from __future__ import division
from __future__ import print_function

import torch.utils.data as data
import numpy as np
import xml.etree.ElementTree as ET
import cv2
import os, copy
from utils.image import flip, color_aug
from utils.image import get_affine_transform, affine_transform
from utils.image import gaussian_radius, draw_umich_gaussian, draw_msra_gaussian
from utils.image import draw_dense_reg
from .. import labels
from ad_ext.LabelingStandards import *
import math

cv2.setNumThreads(1) # avoid using too much cpu


def draw_mask_from_objects(width, height, mask_objects, label_to_idx):
    """
    Draw mask from parsed mask objects.
    
    Args:
        width: Image width
        height: Image height
        mask_objects: List of mask objects with 'label' and 'polygons'
        label_to_idx: Dict mapping label name to pixel value (1-indexed, 0=background)
    
    Returns:
        mask: Single channel mask with class indices as pixel values (0=background)
    """
    mask = np.zeros((height, width), dtype=np.uint8)
    
    for obj in mask_objects:
        label = obj['label']
        if label not in label_to_idx:
            continue
        color = label_to_idx[label]
        
        for polygon in obj['polygons']:
            exterior = polygon['exterior']
            interiors = polygon['interiors']
            
            # Draw exterior (fill)
            if len(exterior) >= 3:
                pts = np.array(exterior, dtype=np.int32)
                cv2.fillPoly(mask, [pts], color)
            
            # Draw interiors (holes) - fill with background
            for interior in interiors:
                if len(interior) >= 3:
                    pts = np.array(interior, dtype=np.int32)
                    cv2.fillPoly(mask, [pts], 0)
    
    return mask

class MultiPoseDataset(data.Dataset):
  def _coco_box_to_bbox(self, box):
    bbox = np.array([box[0], box[1], box[0] + box[2], box[1] + box[3]],
                    dtype=np.float32)
    return bbox

  def _get_border(self, border, size):
    i = 1
    while size - border // i <= border // i:
        i *= 2
    return border // i

  def _generate_bbox_from_points(self, keypoints):
    if len(keypoints) <= 0:
        return None
    #print ('keypoints',keypoints)
    xmin = min(keypoints, key=lambda x:x[0])[0]
    ymin = min(keypoints, key=lambda x:x[1])[1]
    xmax = max(keypoints, key=lambda x:x[0])[0]
    ymax = max(keypoints, key=lambda x:x[1])[1]

    return xmin, ymin, xmax, ymax

  def _parse_xml(self, xml_path):
    """
    Parse XML annotation file.
    
    Returns:
        anns: List of detection objects (bbox, keypoints, category_id, label)
        standard: Labeling standard string
        mask_objects: List of mask objects for segmentation
        img_size: (width, height) tuple
    """
    ann_tree = ET.parse(xml_path)
    ann_root = ann_tree.getroot()
    standard = ann_root.findtext('meta/standard')
    
    # Get image size for mask rendering
    size_elem = ann_root.find('size')
    img_size = None
    if size_elem is not None:
      width = size_elem.findtext('width')
      height = size_elem.findtext('height')
      if width and height:
        img_size = (int(width), int(height))
    
    anns = []
    mask_class_names = self.labels.get_group_names("mask")
    
    for obj in ann_root.findall('object'):
      label = obj.findtext('name')
      if not label:
        continue
      
      # Check if label is valid (in cat2id or mask_class_names)
      is_detection = label in self.cat2id
      is_mask = label in mask_class_names
      if not is_detection and not is_mask:
        continue
      
      ann = {'label': label}
      
      # Parse mask polygons
      mask_elem = obj.find('mask')
      if mask_elem is not None and is_mask:
        polygons = []
        for polygon_elem in mask_elem.findall('polygon'):
          # Parse exterior contour
          exterior = []
          exterior_elem = polygon_elem.find('exterior')
          if exterior_elem is not None:
            for point_elem in exterior_elem.findall('point'):
              x = float(point_elem.find('x').text)
              y = float(point_elem.find('y').text)
              exterior.append([x, y])
          
          # Parse interior contours (holes)
          interiors = []
          interiors_elem = polygon_elem.find('interiors')
          if interiors_elem is not None:
            for interior_elem in interiors_elem.findall('interior'):
              interior = []
              for point_elem in interior_elem.findall('point'):
                x = float(point_elem.find('x').text)
                y = float(point_elem.find('y').text)
                interior.append([x, y])
              if len(interior) > 0:
                interiors.append(interior)
          
          if len(exterior) > 0:
            polygons.append({'exterior': exterior, 'interiors': interiors})
        
        if len(polygons) > 0:
          ann['mask'] = polygons
      
      # Parse detection info (bbox, keypoints)
      if is_detection:
        ann['category_id'] = self.cat2id[label]
        
        # Parse keypoints
        keypoints = []
        keypoints_elem = obj.find('keypoints')
        if keypoints_elem is not None:
          for point in keypoints_elem.findall('point'):
            xk = float(point.findtext('x'))
            yk = float(point.findtext('y'))
            keypoints.append([xk, yk])
          if len(keypoints) > 0:
            ann['keypoints'] = keypoints
        
        # Parse bndbox
        bbox = None
        bndbox = obj.find('bndbox')
        if bndbox is not None:
          xmin_text = bndbox.findtext('xmin')
          ymin_text = bndbox.findtext('ymin')
          xmax_text = bndbox.findtext('xmax')
          ymax_text = bndbox.findtext('ymax')
          if all([xmin_text, ymin_text, xmax_text, ymax_text]):
            bbox = [float(xmin_text), float(ymin_text), float(xmax_text), float(ymax_text)]
        
        # Generate bbox from keypoints if not provided
        if bbox is None and len(keypoints) > 0:
          result = self._generate_bbox_from_points(keypoints)
          if result:
            bbox = list(result)
        
        if bbox is not None:
          xmin, ymin, xmax, ymax = bbox
          if xmax >= xmin and ymax >= ymin:
            ann['bbox'] = [xmin, ymin, xmax - xmin, ymax - ymin]  # x, y, w, h
      
      # Only add if has valid detection info or mask
      if 'bbox' in ann or 'mask' in ann:
        anns.append(ann)
    
    return anns, standard, img_size

  def _load_annotation(self, index):
    relative_path = self.relative_paths[index]
    xml_path = os.path.join(self.anno_dir, relative_path + '.xml')
    return self._parse_xml(xml_path)

  def get_cat_ids(self, index):
    anns, _, _ = self._load_annotation(index)
    return [ann['category_id'] for ann in anns if 'category_id' in ann]

  def __getitem__(self, index):
    relative_path = self.relative_paths[index]
    anns, standard, anno_img_size = self._load_annotation(index)
    # Filter detection objects (those with bbox or non-empty keypoints)
    det_anns = [ann for ann in anns if 'bbox' in ann or 'keypoints' in ann]
    num_objs = min(len(det_anns), self.max_objs)
    
    img_exts = ['jpg', 'png', 'jpeg', 'bmp']
    img_filepath = None
    for ext in img_exts:
      for try_ext in [ext, ext.upper(), ext[0].upper()+ext[1:]]:
        try_filepath = os.path.join(self.img_dir, relative_path + '.' + try_ext)
        if os.path.isfile(try_filepath):
          img_filepath = try_filepath
          break

    assert img_filepath, 'Cannot find image ext for ' + relative_path

    img = cv2.imread(img_filepath)
    if img is None:
      print ("Failed to load image: ", img_filepath)
      raise ValueError("cannot find image")

    height, width = img.shape[0], img.shape[1]
    c = np.array([img.shape[1] / 2., img.shape[0] / 2.], dtype=np.float32)
    s = max(img.shape[0], img.shape[1]) * 1.0
    rot = 0

    flipped = False
    vflipped = False
    if self.split == 'train':
      if not self.opt.not_rand_crop:
        s = s * np.random.choice(np.arange(0.6, 1.4, 0.1))
        w_border = self._get_border(128, img.shape[1])
        h_border = self._get_border(128, img.shape[0])
        c[0] = np.random.randint(low=w_border, high=img.shape[1] - w_border)
        c[1] = np.random.randint(low=h_border, high=img.shape[0] - h_border)
      else:
        sf = self.opt.scale
        cf = self.opt.shift
        c[0] += s * np.clip(np.random.randn()*cf, -2*cf, 2*cf)
        c[1] += s * np.clip(np.random.randn()*cf, -2*cf, 2*cf)
        s = s * np.clip(np.random.randn()*sf + 1, 1 - sf, 1 + sf)
      if np.random.random() < self.opt.aug_rot:
        rf = self.opt.rotate
        rot = np.clip(np.random.randn()*rf, -rf*2, rf*2)

      if np.random.random() < self.opt.flip:
        flipped = True
        img = img[:, ::-1, :]
        c[0] =  width - c[0] - 1

      if np.random.random() < self.opt.vflip:
        vflipped = True
        img = img[::-1, :, :]
        c[1] =  height - c[1] - 1


    trans_input = get_affine_transform(
      c, s, rot, [self.opt.input_res, self.opt.input_res])
    inp = cv2.warpAffine(img, trans_input,
                         (self.opt.input_res, self.opt.input_res),
                         flags=cv2.INTER_LINEAR)
    inp = (inp.astype(np.float32) / 255.)
    if self.split == 'train' and not self.opt.no_color_aug:
      color_aug(self._data_rng, inp, self._eig_val, self._eig_vec)
    inp = (inp - self.mean) / self.std
    inp = inp.transpose(2, 0, 1)

    output_res = self.opt.output_res
    num_joints = self.num_joints
    trans_output_rot = get_affine_transform(c, s, rot, [output_res, output_res])
    trans_output = get_affine_transform(c, s, 0, [output_res, output_res])

    has_basic_heads = 'hm' in self.opt.heads
    if has_basic_heads:
      hm = np.zeros((self.opt.heads['hm'], output_res, output_res), dtype=np.float32)
      if self.opt.hm_hp:
        hm_hp = np.zeros((num_joints, output_res, output_res), dtype=np.float32)
      dense_kps = np.zeros((num_joints, 2, output_res, output_res),
                            dtype=np.float32)
      dense_kps_mask = np.zeros((num_joints, output_res, output_res),
                                dtype=np.float32)
      if self.opt.reg_bbox:
        wh = np.zeros((self.max_objs, 2), dtype=np.float32)
      if self.opt.reg_hps:
        kps = np.zeros((self.max_objs, num_joints * 2), dtype=np.float32)
        kps_mask = np.zeros((self.max_objs, self.num_joints * 2), dtype=np.uint8)
      if self.opt.reg_offset:
        reg = np.zeros((self.max_objs, 2), dtype=np.float32)
      ind = np.zeros((self.max_objs), dtype=np.int64)
      reg_mask = np.zeros((self.max_objs), dtype=np.uint8)
    
      if self.opt.reg_hp_offset:
        hp_offset = np.zeros((self.max_objs * num_joints, 2), dtype=np.float32)
      hp_ind = np.zeros((self.max_objs * num_joints), dtype=np.int64)
      hp_mask = np.zeros((self.max_objs * num_joints), dtype=np.int64)

    use_corner = 'corner_hm' in self.opt.heads
    if use_corner:
      #num_corner_classes = self.labels.get_group_count("corner")
      corner_ind = np.zeros((self.max_objs), dtype=np.int64)
      corner_hm = np.zeros((self.opt.heads['corner_hm'], output_res, output_res), dtype=np.float32)
      corner_hps = np.zeros((self.max_objs, 3 * 2), dtype=np.float32)
      corner_hps_mask = np.zeros((self.max_objs, 3 * 2), dtype=np.uint8)
    
    use_seg = 'seg' in self.opt.heads
    if use_seg:
      # Segmentation output at input resolution (will be upsampled by model)
      seg_input_res = self.opt.input_res
      trans_seg_rot = get_affine_transform(c, s, rot, [seg_input_res, seg_input_res])
      
      # seg_gt is class indices for each pixel (for CrossEntropyLoss)
      # Shape: (H, W), values: 0=background, 1=class1, 2=class2, etc.
      seg_gt = np.zeros((seg_input_res, seg_input_res), dtype=np.int64)
      
      # Extract mask objects from anns (those with 'mask' key)
      mask_objects = [{'label': ann['label'], 'polygons': ann['mask']} 
                      for ann in anns if 'mask' in ann]
      
      # Generate mask from XML annotation
      if len(mask_objects) > 0 and anno_img_size is not None:
        # Build label to pixel value mapping (1-indexed, 0=background)
        mask_class_names = self.labels.get_group_names("mask")
        label_to_idx = {name: idx + 1 for idx, name in enumerate(mask_class_names)}
        
        # Draw mask from parsed objects (0=background, 1=first class, 2=second class, etc.)
        mask_width, mask_height = anno_img_size
        mask_img = draw_mask_from_objects(mask_width, mask_height, mask_objects, label_to_idx)
        
        # Apply same flip augmentation as input image
        if flipped:
          mask_img = mask_img[:, ::-1]
        if vflipped:
          mask_img = mask_img[::-1, :]
        
        # Apply affine transform to mask at input resolution (use nearest neighbor interpolation)
        seg_gt = cv2.warpAffine(mask_img, trans_seg_rot,
                               (seg_input_res, seg_input_res),
                               flags=cv2.INTER_NEAREST).astype(np.int64)

    draw_gaussian = draw_msra_gaussian if self.opt.mse_loss else \
                    draw_umich_gaussian

    gt_det = []
    for k in range(num_objs):
      ann = det_anns[k]
      if self.opt.reg_bbox:
        bbox = self._coco_box_to_bbox(ann['bbox'])
      cls_id = int(ann['category_id'])  # 0-indexed

      if use_corner:
        is_corner_cls = self.labels.is_class_in_group(cls_id, "corner")
      else:
        is_corner_cls = False

      flip_idx = self.flip_idx
      if is_corner_cls:
        flip_idx = self.flip_idx_corner

      # Determine if points are ordered counter-clockwise in image coordinates (y increases downward)
      def IsCCW(pts):
        if pts is None or len(pts) < 3:
          return True
        x = pts[:, 0]
        y = pts[:, 1]
        s = (x * np.roll(y, -1) - y * np.roll(x, -1)).sum()
        # In image coordinates, negative signed area indicates CCW
        return s < 0

      is_thin_line = ann['label'] in ['corner_wheel_stopper', 'corner_parkinglock_locked']

      # keypoints is [[x,y], [x,y], ...], add visibility=2 for each point
      ann_kps = ann['keypoints']
      assert len(ann_kps) > 0, f"keypoints is empty for {ann['label']}"
      pts = np.array([[p[0], p[1], 2] for p in ann_kps], dtype=np.float32)
      
      if use_corner and not is_thin_line and not IsCCW(pts):
        pts = pts[::-1] 
      pts_count = pts.shape[0]

      if flipped:
        if self.opt.reg_bbox:
          bbox[[0, 2]] = width - bbox[[2, 0]] - 1
        pts[:, 0] = width - pts[:, 0] - 1
        for e in flip_idx:
          if e[0] < pts_count and e[1] < pts_count:
            pts[e[0]], pts[e[1]] = pts[e[1]].copy(), pts[e[0]].copy()
      if vflipped:
        if self.opt.reg_bbox:
          bbox[[1, 3]] = height - bbox[[3, 1]] - 1
        pts[:, 1] = height - pts[:, 1] - 1
        for e in flip_idx:
          if e[0] < pts_count and e[1] < pts_count:
            pts[e[0]], pts[e[1]] = pts[e[1]].copy(), pts[e[0]].copy()
      
      pts_xy = np.copy(pts[:,:2])
      #print("====pts_xy",pts_xy)
      for j in range(pts_xy.shape[0]):
        pts_xy[j] = affine_transform(pts_xy[j], trans_output_rot)

      if not is_corner_cls and self.opt.reg_bbox:
        bbox[:2] = affine_transform(bbox[:2], trans_output)
        bbox[2:] = affine_transform(bbox[2:], trans_output)
        bbox = np.clip(bbox, 0, output_res - 1)
        h, w = bbox[3] - bbox[1], bbox[2] - bbox[0]
      else:
        w, h = np.max(pts_xy, axis=0) - np.min(pts_xy, axis=0)
        if is_thin_line:
          line_length = np.linalg.norm(pts_xy[0]-pts_xy[-1])
          line_length = np.sqrt(line_length)
          # fake w h for thin line
          w = line_length
          h = line_length

      if (h > 0 and w > 0) or (rot != 0):
        radius = gaussian_radius((math.ceil(h), math.ceil(w)))
        radius = self.opt.hm_gauss if self.opt.mse_loss else max(0, int(radius))

        ct_kps = pts_xy.mean(axis=0)
        ct_int_kps = ct_kps.astype(np.int32)
          
        if self.opt.reg_bbox:
          ct_bbox = np.array(
              [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], dtype=np.float32)
          ct_int_bbox = ct_bbox.astype(np.int32)
          
        
        if is_corner_cls:
          ct = pts_xy[1] # 2nd pt is corner point
          #side_len1 = np.linalg.norm(pts_xy[0]-pts_xy[1])
          #side_len2 = np.linalg.norm(pts_xy[2]-pts_xy[1])
          #if side_len1 > side_len2:
          #  ct = (pts_xy[0] + pts_xy[1]) / 2.0 # center of 
          #else:
          #  ct = (pts_xy[0] + pts_xy[2]) / 2.0 # center of 
          ct_int = ct.astype(np.int32)
        elif self.opt.eccentric:
          ct_enter = (pts_xy[0] + pts_xy[-1]) / 2.0
          ct = (ct_enter + ct_kps) / 2.0
          ct_int = ct.astype(np.int32)
          #print("====ct eccentric", ct)
        elif self.opt.reg_bbox:
          ct = ct_bbox
          ct_int = ct_int_bbox
          #print("====pts", pts)
          #print("====ct center", ct)
        else:
          ct = ct_kps
          ct_int = ct_int_kps
        
        if is_corner_cls:
          # na
          pass
        elif self.opt.reg_bbox:
          wh[k] = 1. * w, 1. * h
        
        if ct_int[0] < 0 or ct_int[0] >= output_res or \
               ct_int[1] < 0 or ct_int[1] >= output_res:
          continue # skip if hm not in bounds

        ind_value = ct_int[1] * output_res + ct_int[0]
        if is_corner_cls:
          corner_ind[k] = ind_value
        else:
          ind[k] = ind_value

        if is_corner_cls:
          # na
          pass
        elif self.opt.reg_offset:
          reg[k] = ct - ct_int

          reg_mask[k] = 1
          num_kpts = pts[:, 2].sum()
          if num_kpts == 0:
            hm[cls_id, ct_int[1], ct_int[0]] = 0.9999
            reg_mask[k] = 0

        hp_radius = gaussian_radius((math.ceil(h), math.ceil(w)))
        hp_radius = self.opt.hm_gauss \
                    if self.opt.mse_loss else max(0, int(hp_radius))
        for j in range(pts_count):
          if pts[j, 2] > 0:
            pts[j, :2] = affine_transform(pts[j, :2], trans_output_rot)
            if pts[j, 0] >= 0 and pts[j, 0] < output_res and \
               pts[j, 1] >= 0 and pts[j, 1] < output_res:
              if self.opt.reg_hps:
                if is_corner_cls:
                  corner_hps[k, j * 2: j * 2 + 2] = pts[j, :2] - ct_int
                  corner_hps_mask[k, j * 2: j * 2 + 2] = 1
                else:
                  kps[k, j * 2: j * 2 + 2] = pts[j, :2] - ct_int
                  #print("===kps", k, j*2, j*2+2, "value", pts[j, :2], ct_int, "kps", kps[k, j * 2: j * 2 + 2])
                  kps_mask[k, j * 2: j * 2 + 2] = 1
              
              if is_corner_cls:
                #na
                pass
              else:
                pt_int = pts[j, :2].astype(np.int32)
                if self.opt.reg_hp_offset:
                  hp_offset[k * num_joints + j] = pts[j, :2] - pt_int
                hp_ind[k * num_joints + j] = pt_int[1] * output_res + pt_int[0]
                hp_mask[k * num_joints + j] = 1
                if self.opt.dense_hp:
                  # must be before draw center hm gaussian
                  draw_dense_reg(dense_kps[j], hm[cls_id], ct_int,
                                pts[j, :2] - ct_int, radius, is_offset=True)
                  draw_gaussian(dense_kps_mask[j], ct_int, radius)
                if self.opt.hm_hp:
                  draw_gaussian(hm_hp[j], pt_int, hp_radius)
        
        if is_corner_cls:
          draw_gaussian(corner_hm[self.labels.get_class_group_index(cls_id, "corner")], ct_int, radius)
        else:
          draw_gaussian(hm[cls_id], ct_int, radius)

        if self.opt.reg_bbox:
          bbox_info = [bbox[0], bbox[1], bbox[2], bbox[3], 1]
        else:
          bbox_info = [ct_kps[0], ct_kps[1], ct_kps[0], ct_kps[1], 1]
        gt_det.append(bbox_info + pts[:, :2].reshape(pts_count * 2).tolist() + [cls_id])

    if rot != 0:
      hm = hm * 0 + 0.9999
      reg_mask *= 0
      kps_mask *= 0
    ret = {'input': inp}
    if has_basic_heads:
      ret['hm'] = hm
      ret['ind'] = ind
    
      if self.opt.reg_bbox or self.opt.reg_offset:
        ret['reg_mask'] = reg_mask 
      if self.opt.reg_bbox:
        ret['wh'] = wh
      if self.opt.reg_hps:
        ret['hps'] = kps
        ret['hps_mask'] = kps_mask
      if self.opt.dense_hp:
        dense_kps = dense_kps.reshape(num_joints * 2, output_res, output_res)
        dense_kps_mask = dense_kps_mask.reshape(
          num_joints, 1, output_res, output_res)
        dense_kps_mask = np.concatenate([dense_kps_mask, dense_kps_mask], axis=1)
        dense_kps_mask = dense_kps_mask.reshape(
          num_joints * 2, output_res, output_res)
        ret.update({'dense_hps': dense_kps, 'dense_hps_mask': dense_kps_mask})
        del ret['hps'], ret['hps_mask']
      if self.opt.reg_offset:
        ret.update({'reg': reg})
      if self.opt.hm_hp:
        ret.update({'hm_hp': hm_hp})
      if self.opt.reg_hp_offset:
        ret.update({'hp_offset': hp_offset, 'hp_ind': hp_ind, 'hp_mask': hp_mask})
    
    if use_corner:
      ret['corner_ind'] = corner_ind
      ret['corner_hm'] = corner_hm
      ret['corner_hps'] = corner_hps
      ret['corner_hps_mask'] = corner_hps_mask
    
    if use_seg:
      ret['seg'] = seg_gt

    if not self.opt.no_standard_mask:
      if standard in labels.kLabelStandardIndices:
        std_idx = labels.kLabelStandardIndices[standard]
        classes_in_standard = labels.kClassesInStandards[standard]
      else:
        std_idx = labels.kLabelStandardIndices['v0'] # default
        classes_in_standard = labels.kClassesInStandards['v0']
      
      ret['standard'] = np.array(std_idx, dtype=np.uint8)

      if has_basic_heads:
        basic_class_names = self.labels.get_group_names("")  # empty string for basic group
        assert len(basic_class_names) == hm.shape[0]
        basic_cls_mask = np.full((hm.shape[0],), True, dtype=np.bool)
        for i, cls_name in enumerate(basic_class_names):
          if cls_name not in classes_in_standard:
            basic_cls_mask[i] = False
        ret['basic_cls_mask'] = basic_cls_mask

      if use_corner:
        corner_class_names = self.labels.get_group_names("corner")
        assert len(corner_class_names) == corner_hm.shape[0]
        corner_cls_mask = np.full((corner_hm.shape[0],), True, dtype=np.bool)
        for i, cls_name in enumerate(corner_class_names):
          if cls_name[len(kCornerClassPrefix):] not in classes_in_standard:
            corner_cls_mask[i] = False
        ret['corner_cls_mask'] = corner_cls_mask
    
    if self.opt.debug > 0: # or not self.split == 'train':
      # gt_det = np.array(gt_det, dtype=np.float32) if len(gt_det) > 0 else \
      #          np.zeros((1, 40), dtype=np.float32)
      meta = {'c': c, 's': s, 'gt_det': gt_det}
      ret['meta'] = meta
    return ret

