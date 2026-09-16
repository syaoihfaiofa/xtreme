
import json, os
import numpy as np
import cv2

from ad_ext.CameraImageIndex import *

camera_index_convert_table = [
    # idx, config name, meta name, sensor name
    [CAMERA_SURROUND_RIGHT, "surround_right", "right", "CAM_SURROUND_RIGHT"],
    [CAMERA_SURROUND_BACK, "surround_back", "rear", "CAM_SURROUND_BACK"],
    [CAMERA_SURROUND_LEFT, "surround_left", "left", "CAM_SURROUND_LEFT"],
    [CAMERA_SURROUND_FRONT, "surround_front", "front", "CAM_SURROUND_FRONT"],
    [CAMERA_FRONT_NEAR, "front_wide", "front_wide", "CAM_FRONT_NEAR"],
    [CAMERA_FRONT_MIDDLE, "front_middle", "front_middle", "CAM_FRONT_MIDDLE"],
    [CAMERA_FRONT_FAR, "front_far", "front_far", "CAM_FRONT_FAR"],
]

camera_map_config_name_to_index = {}
camera_map_meta_name_to_index = {}
camera_map_sensor_name_to_index = {}
camera_map_index_to_sensor_name = {}

# init maps
for item in camera_index_convert_table:
    idx, config_name, meta_name, sensor_name = item
    camera_map_config_name_to_index[config_name] = idx
    camera_map_meta_name_to_index[meta_name] = idx
    camera_map_sensor_name_to_index[sensor_name] = idx
    camera_map_index_to_sensor_name[idx] = sensor_name

def CameraIndexFromConfigName(name):
    if name in camera_map_config_name_to_index:
        return camera_map_config_name_to_index[name]
    
    print("CameraIndex2ConfigName: Unsupported camera name: ", name)
    return None

def CameraIndexFromMetaName(name):

    if name in camera_map_meta_name_to_index:
        return camera_map_meta_name_to_index[name]

    print("CameraIndexFromMetaName: Unsupported camera name: ", name, ", function:", function)
    return None

def CameraIndexFromSensorName(name):
    if name in camera_map_sensor_name_to_index:
        return camera_map_sensor_name_to_index[name]
    
    print("CameraIndexFromSensorName: Unsupported camera name: ", name)
    return None

def CameraIndexToSensorName(name):
    if name in camera_map_index_to_sensor_name:
        return camera_map_index_to_sensor_name[name]
    
    print("CameraIndexToSensorName: Unsupported camera name: ", name)
    return None

class BaseCameraConfig():

    kPinhole, kFisheye, kOmnidir = range(3)

    def __init__(self):
        self.camera_type = None
        self.width = None
        self.height = None
        self.fx = None
        self.fy = None
        self.cx = None
        self.cy = None
        self.s = None
        self.xi = None
        self.px = None
        self.py = None

        self.rvec = None
        self.tvec = None
        self.origin_tvec = None

        self.calib_origin = [0,0,0]
        self.ground_z = 0

    def FromJson(self, jobj):
        self.width = jobj['width']
        self.height = jobj['height']
        self.fx = jobj['fx']
        self.fy = jobj['fy']
        self.cx = jobj['cx']
        self.cy = jobj['cy']

        self.rvec = jobj['rvec']
        self.tvec = jobj['tvec']


class PinholeCameraConfig(BaseCameraConfig):
    def __init__(self):
        super().__init__()
        self.camera_type = BaseCameraConfig.kPinhole
        self.k1 = None
        self.k2 = None
        self.p1 = None
        self.p2 = None
        self.k3 = None

    def FromJson(self, jobj):
        super().FromJson(jobj)

        self.k1 = jobj['k1']
        self.k2 = jobj['k2']
        self.p1 = jobj['p1']
        self.p2 = jobj['p2']
        self.k3 = jobj['k3']

    
class FisheyeCameraConfig(BaseCameraConfig):

    def __init__(self):
        super().__init__()
        self.camera_type = BaseCameraConfig.kFisheye
        self.k1 = None
        self.k2 = None
        self.k3 = None
        self.k4 = None

    def FromJson(self, jobj):
        super().FromJson(jobj)

        self.k1 = jobj['k1']
        self.k2 = jobj['k2']
        self.k3 = jobj['k3']
        self.k4 = jobj['k4']

class OmnidirCameraConfig(BaseCameraConfig):

    def __init__(self):
        super().__init__()
        self.camera_type = BaseCameraConfig.kOmnidir
        self.k1 = None
        self.k2 = None
        self.p1 = None
        self.p2 = None

    def FromJson(self, jobj):
        super().FromJson(jobj)

        self.k1 = jobj['k1']
        self.k2 = jobj['k2']
        self.p1 = jobj['p1']
        self.p2 = jobj['p2']
        self.xi = jobj['xi']
        self.s = jobj['s'] if 's' in jobj else 0


class PinholeDivCameraConfig(BaseCameraConfig):

    def __init__(self):
        super().__init__()
        self.camera_type = BaseCameraConfig.kPinholeDiv
        self.k1 = None
        self.k2 = None
        self.k3 = None
        self.k4 = None
        self.k5 = None
        self.k6 = None

    def FromJson(self, jobj):
        super().FromJson(jobj)
        self.px = jobj['px']
        self.py = jobj['py']

        self.k1 = jobj['k1']
        self.k2 = jobj['k2']
        self.k3 = jobj['k3']
        self.k4 = jobj['k4']
        self.k5 = jobj['k5']
        self.k6 = jobj['k6']



class CheryFisheyeCameraConfig(FisheyeCameraConfig):

    def __init__(self, w, h):
        super().__init__()
        self.width = w
        self.height = h

    def FromJson(self, jobj):
        
        self.fx = jobj['focal_u']
        self.fy = jobj['focal_v']
        self.cx = jobj['cu']
        self.cy = jobj['cv']
        self.s = jobj['s'] if 's' in jobj else 0

        self.rvec = jobj['rvec']
        self.tvec = jobj['tvec']

        j_coeffs = jobj['distort_coeffs']
        self.k1 = j_coeffs[0]
        self.k2 = j_coeffs[1]
        self.k3 = j_coeffs[2]
        self.k4 = j_coeffs[3]


class CheryOmnidirCameraConfig(OmnidirCameraConfig):

    def __init__(self, w, h):
        super().__init__()
        self.width = w
        self.height = h

    def FromJson(self, jobj):
        
        self.fx = jobj['focal_u']
        self.fy = jobj['focal_v']
        self.cx = jobj['cu']
        self.cy = jobj['cv']
        self.s = jobj['s'] if 's' in jobj else 0

        self.rvec = jobj['rvec']
        self.tvec = jobj['tvec']

        j_coeffs = jobj['distort_coeffs']
        self.k1 = j_coeffs[0]
        self.k2 = j_coeffs[1]
        self.p1 = j_coeffs[2]
        self.p2 = j_coeffs[3]
        self.xi = j_coeffs[4]


class CameraCalibParams():
    def __init__(self):
        self.configs = {}
        self.description = None

        self.calib_origin = [0,0,0]
        self.ground_z = 0
        
    def GetGroundZ(self):
        return self.ground_z + self.calib_origin[2]

    def LoadFromFile(self, file):
        filepath = file
        payload_format = "auto"

        def is_json_file(filename):
            return len(filename) > 5 and filename.endswith(".json")
        
        if is_json_file(file):
            with open(file) as f:
                json_obj = json.load(f)

            if "payload" in json_obj:
                if "format" in json_obj["payload"]:
                    payload_format = json_obj["payload"]["format"]
                if "path" in json_obj["payload"]:
                    filepath = json_obj["payload"]["path"]

        if "YUN" == payload_format:
            pass
        elif "BRD" == payload_format:
            pass
        elif "CCXF" == payload_format:
            self.LoadCCXFConf(filepath)
        elif "standard" == payload_format:
            self.LoadStandardConf(filepath)
        else:
            # auto, legacy
            # print ("loading as legacy camera configs")

            if is_json_file(filepath):
                self.LoadStandardConf(filepath)
            else:
                self.LoadCCXFConf(filepath)
            
        self.Standardize()

    def LoadStandardConf(self, json_file):
        with open(json_file) as f:
            jobj = json.loads(f.read())
        if 'description' in jobj:
            self.description = jobj['description']
        if 'origin' in jobj:
            j_origin = jobj['origin']
            self.calib_origin = j_origin['xyz']
            self.ground_z = j_origin['ground_z']
            #print ('LoadFromFile', self.calib_origin, self.ground_z)
        
        for j_cam_name in jobj['cameras']:
            j_cam = jobj['cameras'][j_cam_name]
            cam_type = j_cam['type']
            cam_idx = CameraIndexFromConfigName(j_cam_name)
            cam_config = None
            if cam_type == 'fisheye':
                cam_config = FisheyeCameraConfig()
            elif cam_type == 'pinhole':
                cam_config = PinholeCameraConfig()
            elif cam_type == 'omnidir':
                cam_config = OmnidirCameraConfig()
            
            if cam_config is not None:
                cam_config.FromJson(j_cam)
                self.configs[cam_idx] = cam_config

    def LoadCCXFConf(self, filepath):
        config_path = filepath
        cameras_meta =  os.path.join(config_path, "cameras_meta.json")

        with open(cameras_meta) as f:
            jobj = json.loads(f.read())
        if 'description' in jobj:
            self.description = jobj['description']
        if 'origin' in jobj:
            j_origin = jobj['origin']
            self.calib_origin = j_origin['xyz']
            self.ground_z = j_origin['ground_z']
            #print ('LoadFromFile', self.calib_origin, self.ground_z)
        
        j_cams = jobj['cameras']
        general_directory = jobj["directory"] if "directory" in jobj else config_path
        for j_cam_name in j_cams:
            j_cam = j_cams[j_cam_name]
            dir = j_cam["directory"] if "directory" in j_cam else general_directory
            param_config =  os.path.join(dir, j_cam_name + ".json")
            with open(param_config) as f:
                param_json = json.loads(f.read())
            cam_type = j_cam['type']
            cam_idx = CameraIndexFromMetaName(j_cam_name, j_cam["function"])
            cam_config = None

            if cam_type == 'fisheye':
                cam_config = CheryFisheyeCameraConfig(j_cam["width"], j_cam["height"])
            elif cam_type == 'omnidir':
                cam_config = CheryOmnidirCameraConfig(j_cam["width"], j_cam["height"])
            
            if cam_config is not None:
                cam_config.FromJson(param_json)
                self.configs[cam_idx] = cam_config

    def Standardize(self):
        # convert extrinsics to using standard origin (rear-axis center)
        for key in self.configs:
            config = self.configs[key]
            
            rvec = np.array(config.rvec).reshape(3,1)
            R, _ = cv2.Rodrigues(rvec)
            T = np.array(config.tvec).reshape(3,1)
            To = np.array(self.calib_origin).reshape(3,1)
            To = -To
            T_new = np.matmul(R, To) + T

            config.origin_tvec = config.tvec[:]
            config.tvec = T_new.flatten().tolist()
            #print (key, "tvec", config.origin_tvec, '->', config.tvec)
        
        # print ("Standardize", self.calib_origin, self.ground_z)
