# https://github.com/yukkyo/voc2coco

'''
python3 ../../src/lib/datasets/voc2coco.py \
    --ann_dir /media/data/BUCKET/myVOCFisheye/Annotations/ \
    --ann_ids /media/data/BUCKET/myVOCFisheye/ImageSets/train.txt \
    --labels ../../src/lib/datasets/my_labels.txt --output my.json --ext xml \
    --num_keypoints 2
'''

import os
import argparse
import json
import xml.etree.ElementTree as ET
from typing import Dict, List
from tqdm import tqdm
import re
import ntpath


def get_label2id(labels_path: str) -> Dict[str, int]:
    """id is 1 start"""
    with open(labels_path, 'r') as f:
        labels_str = f.read().split()
    labels_ids = list(range(1, len(labels_str)+1))
    return dict(zip(labels_str, labels_ids))


def get_annpaths(ann_dir_path: str = None,
                 ann_ids_path: str = None,
                 ext: str = '',
                 annpaths_list_path: str = None) -> List[str]:
    # If use annotation paths list
    if annpaths_list_path is not None:
        with open(annpaths_list_path, 'r') as f:
            ann_paths = f.read().split()
        return ann_paths

    # If use annotaion ids list
    ext_with_dot = '.' + ext if ext != '' else ''
    with open(ann_ids_path, 'r') as f:
        ann_ids = f.read().split()
    ann_paths = [os.path.join(ann_dir_path, aid+ext_with_dot) for aid in ann_ids]
    return ann_paths


def get_image_info(annotation_root, extract_num_from_imgid=True):
    path = annotation_root.findtext('path')
    if path is None:
        filename = annotation_root.findtext('filename')
    else:
        filename = os.path.basename(path)
    if filename == path:
        # if this happens, this may because path is a window's path, so let's try windows parser.
        filename = ntpath.basename(path)

    img_name = os.path.basename(filename)
    img_id = os.path.splitext(img_name)[0]
    if extract_num_from_imgid and isinstance(img_id, str):
        img_id = int(re.findall(r'\d+', img_id)[0])

    size = annotation_root.find('size')
    width = int(size.findtext('width'))
    height = int(size.findtext('height'))

    image_info = {
        'file_name': filename,
        'height': height,
        'width': width,
        'id': img_id
    }
    return image_info

def generate_bbox_from_points(keypoints):
    if len(keypoints) <= 0:
        return None
    #print ('keypoints',keypoints)
    xmin = min(keypoints, key=lambda x:x[0])[0]
    ymin = min(keypoints, key=lambda x:x[1])[1]
    xmax = max(keypoints, key=lambda x:x[0])[0]
    ymax = max(keypoints, key=lambda x:x[1])[1]

    return xmin, ymin, xmax, ymax


def get_coco_annotation_from_obj(obj, label2id, num_keypoints, filepath):
    label = obj.findtext('name')
    if label not in label2id:
        print ("Error: {} is not in label2id !".format(label), filepath)
        raise ValueError()
    category_id = label2id[label]
    
    ann_keypoints = []
    keypoints_list = []
    if num_keypoints > 0:
        keypoints = obj.find('keypoints')
        if keypoints is None:
            print ("No keypoints find in", filepath)
            raise ValueError()
        for point in keypoints.findall('point'):
            xk = float(point.findtext('x'))
            yk = float(point.findtext('y'))
            ann_keypoints.extend([xk, yk, 2])
            keypoints_list.append([xk, yk])

    has_bndbox = False
    bndbox = obj.find('bndbox')
    if bndbox is not None:
        xmin_text = bndbox.findtext('xmin')
        ymin_text = bndbox.findtext('ymin')
        xmax_text = bndbox.findtext('xmax')
        ymax_text = bndbox.findtext('ymax')
        if xmin_text is not None and ymin_text is not None and xmax_text is not None and ymax_text is not None:
            has_bndbox = True
    
    if has_bndbox:
        xmin = float(xmin_text)
        ymin = float(ymin_text)
        xmax = float(xmax_text)
        ymax = float(ymax_text) 

    else:
        # current training code depends on bbox, we generate fake bbox as workaround
        xmin, ymin, xmax, ymax = generate_bbox_from_points(keypoints_list)

    assert xmax > xmin and ymax > ymin, "Box size error !: (xmin, ymin, xmax, ymax): {xmin, ymin, xmax, ymax}"
    o_width = xmax - xmin
    o_height = ymax - ymin

    ann = {
        'area': o_width * o_height,
        'iscrowd': 0,
        'bbox': [xmin, ymin, o_width, o_height],
        'category_id': category_id,
        'ignore': 0,
        'segmentation': []  # This script is not for segmentation
    }
    if obj.findtext('score'):
        ann['score'] = float(obj.findtext('score')) # for eval detection results

    if num_keypoints > 0:
        if len(ann_keypoints) != num_keypoints * 3:
            print ("keypoints num is not", num_keypoints, "in", filepath)
            raise ValueError()
        ann['keypoints'] = ann_keypoints
        ann['num_keypoints'] = int(len(ann_keypoints) / 3)

    return ann


def convert_xmls_to_cocojson(annotation_paths: List[str],
                             label2id: Dict[str, int],
                             output_jsonpath: str,
                             num_keypoints: int,
                             extract_num_from_imgid: bool = True):
    output_json_dict = {
        "images": [],
        "type": "instances",
        "annotations": [],
        "categories": []
    }
    bnd_id = 1  # START_BOUNDING_BOX_ID, TODO input as args ?
    unique_img_id = 1
    print('Start converting !')
    for a_path in tqdm(annotation_paths):
        # Read annotation xml
        ann_tree = ET.parse(a_path)
        ann_root = ann_tree.getroot()

        img_info = get_image_info(annotation_root=ann_root,
                                  extract_num_from_imgid=extract_num_from_imgid)
        if not extract_num_from_imgid:
            img_info['id'] = unique_img_id
            unique_img_id = unique_img_id + 1

        img_id = img_info['id']
        output_json_dict['images'].append(img_info)

        for obj in ann_root.findall('object'):
            ann = get_coco_annotation_from_obj(obj, label2id, num_keypoints, a_path)
            if ann:
                ann.update({'image_id': img_id, 'id': bnd_id})
                output_json_dict['annotations'].append(ann)
                bnd_id = bnd_id + 1

    for label, label_id in label2id.items():
        category_info = {'supercategory': 'none', 'id': label_id, 'name': label}
        if num_keypoints > 0:
            category_info['keypoints'] = ['kp'+str(i) for i in range(num_keypoints)]
            category_info['skeleton'] = [[i,i+1] for i in range(num_keypoints-1)]
        output_json_dict['categories'].append(category_info)

    with open(output_jsonpath, 'w') as f:
        output_json = json.dumps(output_json_dict)
        f.write(output_json)


def main():
    parser = argparse.ArgumentParser(
        description='This script support converting voc format xmls to coco format json')
    parser.add_argument('--ann_dir', type=str, default=None,
                        help='path to annotation files directory. It is not need when use --ann_paths_list')
    parser.add_argument('--ann_ids', type=str, default=None,
                        help='path to annotation files ids list. It is not need when use --ann_paths_list')
    parser.add_argument('--ann_paths_list', type=str, default=None,
                        help='path of annotation paths list. It is not need when use --ann_dir and --ann_ids')
    parser.add_argument('--labels', type=str, default=None,
                        help='path to label list.')
    parser.add_argument('--output', type=str, default='output.json', help='path to output json file')
    parser.add_argument('--ext', type=str, default='xml', help='additional extension of annotation file')
    parser.add_argument('--num_keypoints', type=int, default=0, help='num of keypoints for each object in annotation file')
    args = parser.parse_args()
    label2id = get_label2id(labels_path=args.labels)
    ann_paths = get_annpaths(
        ann_dir_path=args.ann_dir,
        ann_ids_path=args.ann_ids,
        ext=args.ext,
        annpaths_list_path=args.ann_paths_list
    )
    convert_xmls_to_cocojson(
        annotation_paths=ann_paths,
        label2id=label2id,
        output_jsonpath=args.output,
        num_keypoints=args.num_keypoints, 
        extract_num_from_imgid=False
    )


if __name__ == '__main__':
    main()
