

from __future__ import absolute_import
from __future__ import division
from __future__ import print_function


import os, sys, math
import copy

from lxml import etree
import PIL.Image

import shapely
from shapely import geometry
import numpy as np

from ad_ext import math_utils
from ad_ext import Utils
from ad_ext.CameraImageIndex import *
from libs.constants import *

def scanAllFiles(folderPath, extensions):
  filelist = []

  for root, dirs, files in os.walk(folderPath):
      for file in files:
          if file.lower().endswith(tuple(extensions)):
              relativePath = os.path.join(root, file)
              path = os.path.abspath(relativePath)
              filelist.append(path)
  filelist.sort(key=lambda x: x.lower())
  return filelist

def GetCenter(keypoints):
  x = 0.0
  y = 0.0
  for kp in keypoints:
    x += kp[0]
    y += kp[1]

  return x / len(keypoints), y / len(keypoints)

def GetMinDistance(keypoints):
  # use min dist, in case some wrong point is far away
  dists = [math.hypot(kp[0], kp[1]) for kp in keypoints]
  return min(dists)

def GetMinMax(keypoints):
  xmin = None
  ymin = None
  xmax = None
  ymax = None
  for kp in keypoints:
    if xmin is None or kp[0] < xmin:
      xmin = kp[0]
    if ymin is None or kp[1] < ymin:
      ymin = kp[1]
    if xmax is None or kp[0] > xmax:
      xmax = kp[0]
    if ymax is None or kp[1] > ymax:
      ymax = kp[1]
  return xmin, ymin, xmax, ymax

def GetMaxSideLen(keypoints):
  lens = []
  for i in range(len(keypoints)-1):
    kp0 = keypoints[i]
    kp1 = keypoints[i+1]
    d = math.hypot(kp0[0] - kp1[0], kp0[1] - kp1[1])
    lens.append(d)
  return max(lens)

def IsInBox(keypoints, box):
  is_in = True
  for kp in keypoints:
    if kp[0] > box[0] and kp[0] < box[2] \
      and kp[1] > box[1] and kp[1] < box[3]:
      continue
    else:
      is_in = False
      break

  return is_in

def CalcAngle(p0, p1, p2):
  # Calculate vectors p1p0 and p1p2
  vector_p1p0 = p0 - p1
  vector_p1p2 = p2 - p1

  # Calculate the dot product of the two vectors
  dot_product = np.dot(vector_p1p0, vector_p1p2)

  # Calculate the magnitudes (norms) of the vectors
  magnitude_p1p0 = np.linalg.norm(vector_p1p0)
  magnitude_p1p2 = np.linalg.norm(vector_p1p2)

  # Calculate the angle between the vectors in radians using arccosine
  angle_radians = np.arccos(dot_product / (magnitude_p1p0 * magnitude_p1p2))

  # Ensure the angle is within [0, pi]
  if angle_radians < 0:
      angle_radians = np.pi - angle_radians
  
  return angle_radians

def checkIntersects(keypoints):
    if len(keypoints) < 3:
      return False

    if len(keypoints) > 30:
      print("skip too many points for performance issue", len(keypoints))
      return False

    combo = []
    for c in range(len(keypoints)-1):
        combo.append((c, c+1))

    def judge(s, n, combo, keypoints):
        
        while n < len(combo):
            if combo[s][0] != combo[n][0] and combo[s][1] != combo[n][1] and \
                combo[s][0] != combo[n][1] and combo[s][1] != combo[n][0]:
                line0 = geometry.LineString((keypoints[combo[s][0]][:2], keypoints[combo[s][1]][:2]))
                line1 = geometry.LineString((keypoints[combo[n][0]][:2], keypoints[combo[n][1]][:2]))
                if line0.intersects(line1):
                    return True
            n += 1
        return False

    s = 0
    while s < len(combo)-1:
        n = s+1
        if judge(s, n, combo, keypoints):
            # print("exsit intersects!")
            return True
        s += 1
    
    return False

def IsSamePoint(p1, p2):
  if len(p1) != len(p2):
    return False
  for a, b in zip(p1, p2):
    if (a is None and b is not None) or (b is None and a is not None):
      return False
    if a is not None and b is not None and abs(a-b) > 0.01:
      return False
    
  return True

def CheckRemoveDuplicatePoint(keypoints):
  if len(keypoints) < 2:
    return False
  dup_removed = False
  for idx in range(len(keypoints)-1, -1, -1):
    p1 = keypoints[idx]
    p2 = keypoints[idx-1]
    #print('check pt', p1, p2)
    if IsSamePoint(p1, p2):
      #print ('remove dup pt', p1)
      keypoints.pop(idx)
      dup_removed = True
  return dup_removed    

def write_keypoints(el_keypoints, keypoints):
  for child in el_keypoints.findall('point'):
    el_keypoints.remove(child)
  for point in keypoints:
    el_point = etree.Element('point')
    el_x = etree.Element('x')
    el_x.text = str(float(point[0]))
    el_point.append(el_x)
    el_y = etree.Element('y')
    el_y.text = str(float(point[1]))
    el_point.append(el_y)
    if point[2] is not None:
      el_elevation = etree.Element('world_z')
      el_elevation.text = str(float(point[2]))
      el_point.append(el_elevation)
    if point[3] is not None:
      el_height = etree.Element('height')
      el_height.text = str(float(point[3]))
      el_point.append(el_height)
    if point[4] is not None:
      el_world_x = etree.Element('world_x')
      el_world_x.text = str(float(point[4]))
      el_point.append(el_world_x)
    if point[5] is not None:
      el_world_y = etree.Element('world_y')
      el_world_y.text = str(float(point[5]))
      el_point.append(el_world_y)

    el_keypoints.append(el_point)

class MODAnnoChecker():
  def __init__(self, keypoint_num, correct_orientation, data_suite, batch_mode = False, adjust_facing = False):
    self.keypoint_num = keypoint_num
    self.correct_orientation = correct_orientation
    self.data_suite = data_suite
    self.batch_mode = batch_mode
    self.adjust_facing = adjust_facing

  def check_anno_file(self, anno_file, image_width, image_height):
    #print ("check_anno", anno_file)

    labeling_cam_idx = Utils.GetCameraIndexFromImageOrAnnoFile(anno_file)
    conf_key = self.data_suite.conf_selector.GetConfigDir(anno_file)

    parser = etree.XMLParser(remove_blank_text=True)
    tree = etree.parse(anno_file, parser)
    root = tree.getroot()
    
    anno_file_name = os.path.basename(anno_file)
    
    # 检查 XML 中的 size 是否与 image size 一致
    elem_size = root.find('size')
    assert elem_size is not None, "size not found in anno file"
    elem_width = elem_size.find('width')
    elem_height = elem_size.find('height')
    assert elem_width is not None and elem_height is not None, "width or height not found in size"
    xml_width = int(elem_width.text)
    xml_height = int(elem_height.text)
    assert xml_width == image_width and xml_height == image_height, "XML size mismatch with image"
    
    need_overwrite = False 
    for el_obj in root.findall('object'):
      el_bndbox = el_obj.find('bndbox')
      label_name = el_obj.find("name").text

      min_point = None
      bndbox = None
      if el_bndbox is not None:

        xmin_elem = el_bndbox.find('xmin')
        ymin_elem = el_bndbox.find('ymin')
        xmax_elem = el_bndbox.find('xmax')
        ymax_elem = el_bndbox.find('ymax')
        if xmin_elem is not None and ymin_elem is not None and xmax_elem is not None and ymax_elem is not None:
            xmin = float(xmin_elem.text)
            ymin = float(ymin_elem.text)
            xmax = float(xmax_elem.text)
            ymax = float(ymax_elem.text)
            min_point = (xmin, ymin)
            bndbox = [xmin, ymin, xmax, ymax]
      
      #print ('bndbox', xmin, ymin, xmax, ymax)

      keypoints = []
      el_keypoints = el_obj.find('keypoints')
      if el_keypoints is None:
        return ("No keypoints", label_name, min_point, anno_file_name)

      for el_point in el_keypoints.findall('point'):
        x = float(el_point.find('x').text)
        y = float(el_point.find('y').text)
        z_elem = el_point.find('world_z')
        z = float(z_elem.text) if z_elem is not None else None
        h_elem = el_point.find('height')
        height = float(h_elem.text) if h_elem is not None else None
        world_x_elem = el_point.find('world_x')
        world_x = float(world_x_elem.text) if world_x_elem is not None else None
        world_y_elem = el_point.find('world_y')
        world_y = float(world_y_elem.text) if world_y_elem is not None else None
        keypoints.append((x, y, z, height, world_x, world_y))

        if min_point is None:
          min_point = (x, y)
        else:
          if x < min_point[0]:
            min_point = (x, min_point[1])
          if y < min_point[1]:
            min_point = (min_point[0], y)

      if CheckRemoveDuplicatePoint(keypoints):
        print ('duplicate points', label_name, min_point, anno_file_name)
        write_keypoints(el_keypoints, keypoints)
        need_overwrite = True 

      if IsFreeShapeLabel(label_name):
        if checkIntersects(keypoints):
          return ("polyline intersects itself", label_name, min_point, anno_file_name)
      elif IsImageLabel(label_name):
        continue
      else:
        if len(keypoints) != self.keypoint_num:
          return ("Bad keypoint num", label_name, min_point, anno_file_name)

        if len(keypoints) > 0:
          
          if labeling_cam_idx in self.data_suite.camera_projections[conf_key]:

            shape_ok, need_reorder, adjust_facing_index = \
              self.CheckShape(label_name, bndbox, keypoints, image_width, image_height, labeling_cam_idx, conf_key)
            if not shape_ok:
              return ("Shape not good", label_name, keypoints[0], anno_file_name)
            #print ("====trans_shape",trans_shape)

            

            # shapely is using normal xy coordinate instead of image coordinate (y downward)
            if need_reorder:
              print ("bad orientation detected:", label_name, keypoints, anno_file)
              keypoints = keypoints[::-1]
              write_keypoints(el_keypoints, keypoints)
              #print ('corrected points', keypoints)
              need_overwrite = True 

            if self.adjust_facing and adjust_facing_index is not None and adjust_facing_index != len(keypoints)-1:
              print ('corrected facing', label_name, keypoints, anno_file, adjust_facing_index)
              keypoints = keypoints[adjust_facing_index+1:] + keypoints[:adjust_facing_index+1]
              write_keypoints(el_keypoints, keypoints)
              need_overwrite = True 

    if need_overwrite:
      if self.correct_orientation:
        etree.indent(tree, space="\t") # format it
        tree.write(anno_file, pretty_print=True)
        print("overwrite to correct err in anno file", anno_file_name)
      else:
        print("need to correct err in anno file", anno_file_name)
    
    return None

  def CheckShape(self, label_name, bbox, in_keypoints, image_width, image_height, camera_index, conf_key):
    kMarginThresh = 16
    truncated = False
    if bbox and len(bbox) >= 4 and (bbox[0] < kMarginThresh or bbox[1] < kMarginThresh \
      or (image_width - bbox[2]) < kMarginThresh or (image_height - bbox[3]) < kMarginThresh):
      truncated = True

    if len(in_keypoints) < 4:
      return False, False, None
    if bbox and len(bbox) >= 4:
      width = bbox[2] - bbox[0]
    else:
      kps_box = GetMinMax(in_keypoints)
      width = kps_box[2] - kps_box[0]
    
    # 检查图像尺寸与 config 是否一致，如果不一致需要缩放坐标
    keypoints_for_transform = in_keypoints
    try:
      cam_conf = self.data_suite.camera_params[conf_key].configs[camera_index]
      conf_width = cam_conf.width
      conf_height = cam_conf.height
      if image_width != conf_width or image_height != conf_height:
        scale_x = conf_width / image_width
        scale_y = conf_height / image_height
        keypoints_for_transform = [[pt[0] * scale_x, pt[1] * scale_y] + list(pt[2:]) if len(pt) > 2 else [pt[0] * scale_x, pt[1] * scale_y] for pt in in_keypoints]
    except (KeyError, AttributeError):
      pass
    
    a_shape = [label_name, [], keypoints_for_transform]
    trans_shape = copy.deepcopy([a_shape])
    self.data_suite.TransformShapes(trans_shape, camera_index, False, True, conf_key)
    #print ("TransformShapes", a_shape, trans_shape)

    keypoints = trans_shape[0][2]
    
    try:
      poly = geometry.Polygon(keypoints)
    except:
      print ('poly err', label_name, keypoints)
      return False, False, None
    if not poly.is_valid:
      return False, False, None
    
    need_reorder = not poly.exterior.is_ccw

    if need_reorder:
      keypoints_ordered = keypoints[::-1]
    else:
      keypoints_ordered = keypoints[:]

    adjust_facing_index = None
    if (label_name == 'pillar' or label_name == 'cone' or label_name == 'pole' \
      or label_name == 'barrier') and len(keypoints) == 4:

      min_angle = None
      min_index = None

      ref_point = np.array([1.7, 0]) # x is left/right camera's position, ~ 1.7 m

      # find facing edge (AB) to ref point (O)
      # facing edge is the edge with smallest angle of midpoint(AB)-O-polyCenter

      poly = geometry.Polygon(keypoints_ordered)
      poly_area = poly.area
      np_pts = np.array(keypoints_ordered)[..., :2] # n * 2
      poly_center = np.mean(np_pts, axis=0)
      # print ('np_pts', np_pts)
      # print ('poly_center', poly_center)
      # print ('poly_area', poly_area)
      for index, point in enumerate(np_pts):
          next_point = np_pts[(index+1) % len(np_pts)]
          
          # filter edge with triangle OAB intersect with poly it self
          triangle = geometry.Polygon([point, ref_point, next_point])
          inter_area = triangle.intersection(poly).area
          if inter_area > 0.001 * poly_area:
            #print('ignore non-facing edge', point, next_point)
            continue

          mid_point = (point + next_point) / 2

          angle = CalcAngle(mid_point, ref_point, poly_center)
          #print ('candidate facing edge', point, math.degrees(angle))
          if min_angle is None or angle < min_angle:
              min_angle = angle
              min_index = index

      adjust_facing_index = min_index
    
    kAngleThresh1 = 15
    kAngleThresh2 = 30
    kAngleThresh3 = 60
    kAngleThresh4 = -1
    angle_thresh = kAngleThresh1

    side_len = GetMaxSideLen(keypoints)

    if side_len < 2 or width < 90:
      angle_thresh = kAngleThresh2 # enlarge thresh for small object
    if side_len < 0.6 or width < 40:
      angle_thresh = kAngleThresh3 # enlarge thresh for small object
    
    distance = GetMinDistance(keypoints)
    kDist1 = 8
    kDist2 = 20
    if camera_index == CAMERA_FRONT_MIDDLE:
      kDist1 = 18
      kDist2 = 25

    if distance > kDist2 and (side_len < 0.6 or width < 40):
      angle_thresh = kAngleThresh4 # enlarge thresh for object out of range
    elif distance > kDist1:
      angle_thresh = kAngleThresh3

    if width < 25:
      angle_thresh = kAngleThresh4
    
    topdown_bbox = self.data_suite.topdown_proj[conf_key].coord_utils[camera_index].GetWorldBBox()
    in_box = IsInBox(keypoints, topdown_bbox)

    if not in_box:
      angle_thresh = kAngleThresh4

    if not self.batch_mode:
      print ("==angle_thresh", side_len, width, distance, in_box, topdown_bbox, angle_thresh)

    if angle_thresh < 0:
      return True, need_reorder, adjust_facing_index
    
    side_align = math_utils.linesAlign([keypoints[0],keypoints[1]], [keypoints[3],keypoints[2]], angle_thresh)
    open_align = math_utils.linesAlign([keypoints[0],keypoints[3]], [keypoints[1],keypoints[2]], angle_thresh)
    open_perpend = math_utils.linesPerpendicular([keypoints[0],keypoints[3]], [keypoints[0],keypoints[1]], angle_thresh)
    close_perpend = math_utils.linesPerpendicular([keypoints[1],keypoints[2]], [keypoints[2],keypoints[3]], angle_thresh)
    
    # if truncated:
    #   return side_align and (open_perpend or close_perpend)
    # else:
    if label_name == 'parkingspace':
      shape_ok = side_align and (open_perpend or close_perpend or open_align)
    else:
      shape_ok = side_align and open_align and open_perpend and close_perpend
    
    return shape_ok, need_reorder, adjust_facing_index

  def Check(self, anno_file, image_file):
    if not anno_file.endswith(".xml"):
      raise ValueError("Not a xml file: " + anno_file)
    if not os.path.isfile(anno_file):
      raise ValueError("Not a file: " + anno_file)
    if not os.path.isfile(image_file):
      raise ValueError("Not a file: " + image_file)
    
    with PIL.Image.open(image_file) as img:
      image_width, image_height = img.size

    result = self.check_anno_file(anno_file, image_width, image_height)
    if result is None:
      print ("Anno file verified", anno_file)
    
    return result

