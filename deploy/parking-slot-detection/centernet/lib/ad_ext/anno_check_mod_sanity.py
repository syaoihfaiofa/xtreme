

from __future__ import absolute_import
from __future__ import division
from __future__ import print_function


import os, sys

from lxml import etree
import PIL.Image

import shapely
from shapely import geometry


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

def check_anno_file(anno_file, keypoint_num, correct_orientation):
  #print ("check_anno", anno_file)

  tree = etree.parse(anno_file)
  root = tree.getroot()

  #if len(root.findall('object')) == 0:
  #  print ('Warning: empty objects in anno', anno_file)
  
  anno_file_name = os.path.basename(anno_file)
  need_overwrite = False 
  for el_obj in root.findall('object'):
    el_bndbox = el_obj.find('bndbox')
    label_name = el_obj.find("name").text

    xmin = float(el_bndbox.find('xmin').text)
    ymin = float(el_bndbox.find('ymin').text)
    xmax = float(el_bndbox.find('xmax').text)
    ymax = float(el_bndbox.find('ymax').text)

    #print ('bndbox', xmin, ymin, xmax, ymax)

    keypoints = []
    el_keypoints = el_obj.find('keypoints')
    if el_keypoints is None:
      print("No keypoints", label_name, "at (", xmin, ymin, ") in file", anno_file_name)
      raise ValueError("No keypoints")

    for el_point in el_keypoints.findall('point'):
      x = float(el_point.find('x').text)
      y = float(el_point.find('y').text)
      keypoints.append((x, y))

    if len(keypoints) != keypoint_num:
      print("Bad keypoint num", label_name, "at (", xmin, ymin, ") in file", anno_file_name)
      raise ValueError("Bad keypoint num")

    if len(keypoints) > 0:
      poly = geometry.Polygon(keypoints)
      if not poly.is_valid:
        raise ValueError("Keypoints not poly", label_name, "in file", anno_file_name)

      # shapely is using normal xy coordinate instead of image coordinate (y downward)
      if poly.exterior.is_ccw:
        print ("bad orientation detected:", label_name, keypoints)
        keypoints = keypoints[::-1]
        for el_point, point in zip(el_keypoints.findall('point'), keypoints):
          el_point.find('x').text = str(int(round(point[0])))
          el_point.find('y').text = str(int(round(point[1])))

        need_overwrite = True

  if need_overwrite:
    if correct_orientation:
      tree.write(anno_file, pretty_print=True)
      print("overwrite to correct orientation in anno file", anno_file_name)
    else:
      print("need to correct orientation in anno file", anno_file_name)

    
def main():
  if len(sys.argv) < 2:
    print ("Usage", os.path.basename(sys.argv[0]), "anno_dir")
    return

  anno_dir = sys.argv[1]
  correct_orientation = True

  keypoint_num = 4

  if not os.path.isdir(anno_dir):
    print ('directory not exist:', anno_dir)
    return

  filelist = scanAllFiles(anno_dir, [".xml"])
  print ('Find files:', len(filelist))
  for file in filelist:
    check_anno_file(file, keypoint_num, correct_orientation)

  print ('Check finished')


if __name__ == '__main__':
  main()
