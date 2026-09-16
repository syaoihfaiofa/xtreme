import os
import math

import shapely.geometry
from shapely import geometry
from lxml import etree


def check_anno_file(anno_file):
    tree = etree.parse(anno_file)
    root = tree.getroot()

    # if len(root.findall('object')) == 0:
    #  print ('Warning: empty objects in anno', anno_file)

    anno_file_name = os.path.basename(anno_file)
    need_overwrite = False

    keypoints_list = []

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

        # print ('bndbox', xmin, ymin, xmax, ymax)

        keypoints = []
        el_keypoints = el_obj.find('keypoints')
        if el_keypoints is None:
            return ("No keypoints", label_name, min_point, anno_file_name)

        for el_point in el_keypoints.findall('point'):
            x = float(el_point.find('x').text)
            y = float(el_point.find('y').text)
            keypoints.append((x, y))
        # 判断点数量
        if len(keypoints) != 4 and len(keypoints) != 6:
            return ("Bad keypoint num", label_name, min_point, anno_file_name)

        if len(keypoints) > 0:
            poly = geometry.Polygon(keypoints[0:4])
            # 判断点1-4几何
            if not poly.is_valid:
                return ("Keypoints not poly", label_name, keypoints[0], anno_file_name)
            # 判断点1-4逆时针
            if poly.exterior.is_ccw:
                print("bad orientation detected:", label_name, keypoints)
                if len(keypoints) == 6:
                    keypoints = keypoints[-3::-1] + keypoints[-1:-3:-1]
                else:
                    keypoints = keypoints[::-1]
                need_overwrite = True
            # 如果存在点5 6 则判断点5 6顺序
            if len(keypoints) == 6:
                line1 = geometry.LineString([keypoints[3], keypoints[4]])
                line2 = geometry.LineString([keypoints[5], keypoints[0]])
                # 判断线Keypoints(3，4) (5，0) 是否相交 如果相交则交换keypoints 4和5的位置
                if line1.crosses(line2):
                    temp = keypoints[4]
                    keypoints[4] = keypoints[5]
                    keypoints[5] = temp
                    need_overwrite = True
            if need_overwrite:
                for el_point, point in zip(el_keypoints.findall('point'), keypoints):
                    el_point.find('x').text = str(float(point[0]))
                    el_point.find('y').text = str(float(point[1]))


            if check_shape(keypoints) is False:
                return ("Shape not good", label_name, keypoints[0], anno_file_name)

            if check_label_name(label_name) is False:
                return ("label_name error", label_name, keypoints[0], anno_file_name)

            if len(keypoints) == 6:
                line = geometry.LineString(keypoints[4:])
                if poly.contains(line) is False:
                    return ("限位器不在车位内", label_name, keypoints[0], anno_file_name)

        keypoints_list.append(keypoints)
    if need_overwrite:
        tree.write(anno_file, pretty_print=True)
        print("overwrite to correct orientation in anno file", anno_file_name)
    else:
        print("need to correct orientation in anno file", anno_file_name)
    check_iou_result = check_iou(keypoints_list, anno_file_name)
    if check_iou_result is not None:
        return check_iou_result

    return None


# 检查停车位类型
def check_label_name(label_name):
    label_name_tuple = ('parkinglot', 'parkinglot_parked', 'parkinglot_mechanical', 'parkinglot_handicap')
    return label_name in label_name_tuple


# 检查停车位形状
def check_shape(points):

    a_x = points[0][0]
    a_y = points[0][1]

    b_x = points[1][0]
    b_y = points[1][1]

    c_x = points[2][0]
    c_y = points[2][1]

    d_x = points[3][0]
    d_y = points[3][1]
    #
    b = cal_angle((a_x, a_y), (b_x, b_y), (c_x, c_y))  # b的夹角
    c = cal_angle((b_x, b_y), (c_x, c_y), (d_x, d_y))  # c的夹角
    d = cal_angle((c_x, c_y), (d_x, d_y), (a_x, a_y))  # d的夹角
    a = cal_angle((d_x, d_y), (a_x, a_y), (b_x, b_y))  # a的夹角
    if abs(b - 180) < 20 or abs(c - 180) < 20 or abs(d - 180) < 20 or abs(a - 180) < 20:
        return False
    return True

def cal_angle(point_a, point_b, point_c):
    """
    根据三点坐标计算夹角

                  点a
           点b ∠
                   点c

    :param point_a、point_b、point_c: 数据类型为list,二维坐标形式[x、y]或三维坐标形式[x、y、z]
    :return: 返回角点b的夹角值


    """
    a_x, b_x, c_x = point_a[0], point_b[0], point_c[0]  # 点a、b、c的x坐标
    a_y, b_y, c_y = point_a[1], point_b[1], point_c[1]  # 点a、b、c的y坐标

    if len(point_a) == len(point_b) == len(point_c) == 3:
        # print("坐标点为3维坐标形式")
        a_z, b_z, c_z = point_a[2], point_b[2], point_c[2]  # 点a、b、c的z坐标
    else:
        a_z, b_z, c_z = 0, 0, 0  # 坐标点为2维坐标形式，z 坐标默认值设为0
        # print("坐标点为2维坐标形式，z 坐标默认值设为0")

    # 向量 m=(x1,y1,z1), n=(x2,y2,z2)
    x1, y1, z1 = (a_x - b_x), (a_y - b_y), (a_z - b_z)
    x2, y2, z2 = (c_x - b_x), (c_y - b_y), (c_z - b_z)

    # 两个向量的夹角，即角点b的夹角余弦值
    cos_b = (x1 * x2 + y1 * y2 + z1 * z2) / (
            math.sqrt(x1 ** 2 + y1 ** 2 + z1 ** 2) * (math.sqrt(x2 ** 2 + y2 ** 2 + z2 ** 2)))  # 角点b的夹角余弦值
    b = math.degrees(math.acos(cos_b))  # 角点b的夹角值
    return b


def check_iou(keypoints_list, anno_file_name):
    for i in range(0, len(keypoints_list) - 1):
        for j in range(i + 1, len(keypoints_list)):
            poly1 = geometry.Polygon(keypoints_list[i])
            poly2 = geometry.Polygon(keypoints_list[j])
            iou = poly1.intersection(poly2).area / poly1.union(poly2).area
            is_overlap = iou > 0.2
            if is_overlap:
                return ("车位重叠过大", "", keypoints_list[i][0], anno_file_name)


# if __name__ == '__main__':
#     filepath = r"/media/sf_X_DRIVE/data/shanghai/PSD/2022-06-24-09-23-10_revise/20220624_092310_1656034818_720068256.xml"
#     result = check_anno_file(filepath)
#     print(result)
