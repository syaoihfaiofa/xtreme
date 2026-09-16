
import os
import cv2
import numpy as np

def BoxIntersect(a, b):
    # Rectangles with negative dimensions are allowed, so we must handle them correctly

    # Compute the min and max of the first rectangle on both axes
    r1MinX = min(a[0], a[2])
    r1MaxX = max(a[0], a[2])
    r1MinY = min(a[1], a[3])
    r1MaxY = max(a[1], a[3])

    # Compute the min and max of the second rectangle on both axes
    r2MinX = min(b[0], b[2])
    r2MaxX = max(b[0], b[2])
    r2MinY = min(b[1], b[3])
    r2MaxY = max(b[1], b[3])

    # Compute the intersection boundaries
    interLeft   = max(r1MinX, r2MinX)
    interTop    = max(r1MinY, r2MinY)
    interRight  = min(r1MaxX, r2MaxX)
    interBottom = min(r1MaxY, r2MaxY)

    # If the intersection is valid (positive non zero area), then there is an intersection
    if (interLeft < interRight) and (interTop < interBottom):
        return [interLeft, interTop, interRight, interBottom]
    else:
        return None




def FoldernameFromFilename(filename):
    stem = os.path.splitext(os.path.basename(filename))[0]
    strs = stem.split("_")
    date_str = None
    time_str = None
    for astr in strs:
        if date_str is None and len(astr) == 8 and astr.isdigit():
            date_str = astr[0:4] + '-' + astr[4:6] + '-' + astr[6:8] 
        elif time_str is None and len(astr) == 6 and astr.isdigit():
            time_str = astr[0:2] + '-' + astr[2:4] + '-' + astr[4:6] 
    
    return date_str if time_str is None else date_str + '-' + time_str
    
def TimestampFromFilename(filename):
    stem = os.path.splitext(os.path.basename(filename))[0]
    strs = stem.split("_")
    if len(strs[-1]) < 4 or not strs[-1].isdigit(): # may have suffix like _0.jpg
        ts = int(strs[-3]+strs[-2].rjust(9,'0'))
    else:
        ts = int(strs[-2]+strs[-1].rjust(9,'0'))
    return ts

def IsImageFile(filename):
    img_file_exts = ['.png','.jpg','.jpeg','.bmp']
    ext = os.path.splitext(os.path.basename(filename))[1]
    return ext.lower() in img_file_exts

def IsAnnoFile(filename):
    img_file_exts = ['.xml','.json']
    ext = os.path.splitext(os.path.basename(filename))[1]
    return ext.lower() in img_file_exts

def GetAnnoFileFromImageFile(image_file, anno_dir):
    stem = os.path.splitext(os.path.basename(image_file))[0]
    dir = os.path.split(image_file)[0]
    parent_dir = os.path.basename(dir)

    # if len(self.data_record_dir) == 1:
    #     anno_dir = os.path.join(self.data_record_dir[0], 'anno', parent_dir)
    # elif len(self.data_record_dir) > 1:
    #     anno_dir = self.data_record_dir[1]
    

    anno_file = os.path.join(anno_dir, stem + ".xml")
    #print ("===anno_file", image_file, anno_file)
    #print('test', stem, dir, parent_dir, anno_dir)
    return anno_file

def GetCameraIndexFromImageOrAnnoFile(image_file):
    stem = os.path.splitext(os.path.basename(image_file))[0]
    strs = stem.split("_")
    if len(strs[-1]) < 4:
        file_suffix = int(strs[-1])
        return file_suffix
    else:
        return None

def FindCorrespondStitchImage(cam_image_file, stitch_image_list):
    ts_cam = TimestampFromFilename(cam_image_file)
    min_elem = min(stitch_image_list, key=lambda x: abs(x[0] - ts_cam))
    MAX_DIFF = 0.2*1e9 #ns
    if abs(min_elem[0] - ts_cam) >= MAX_DIFF:
        raise ValueError("Related stitch image not found")
    return min_elem[1]

def InvertRT(rvec, tvec):

    R, _ = cv2.Rodrigues(rvec)
    Rinv = cv2.transpose(R)

    T = tvec.reshape((3,1))
    T_inv = - np.matmul(Rinv, T)

    rvec_inv, _ = cv2.Rodrigues(Rinv)

    return rvec_inv, T_inv

def GetCameraPose(cam_param):

    rvec, tvec = InvertRT(np.array(cam_param.rvec), np.array(cam_param.tvec))

    z_dir = np.array([0, 0, 1.0]).reshape((3,1))
    
    rotation_matrix, _ = cv2.Rodrigues(rvec)
    z_dir = np.matmul(rotation_matrix, z_dir) + tvec

    #np.set_printoptions(precision=4, suppress=True)
    #print ('get_camera_pose', conf_key, cam_idx, tvec.reshape(-1), z_dir.reshape(-1))

    return tvec.reshape(-1).tolist(), z_dir.reshape(-1).tolist()