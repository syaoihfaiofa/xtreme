
import os
import cv2

from ad_ext import CameraCalibParams
from ad_ext import CameraProjection
from ad_ext.CameraImageIndex import *
from ad_ext import TopdownProjection
from ad_ext import StitchingConfig
from ad_ext import ConfigSelector
from ad_ext import CarConfig
from ad_ext import Utils

import numpy as np
import math, copy

# Checks if a matrix is a valid rotation matrix.
def isRotationMatrix(R) :
    Rt = np.transpose(R)
    shouldBeIdentity = np.dot(Rt, R)
    I = np.identity(3, dtype = R.dtype)
    n = np.linalg.norm(I - shouldBeIdentity)
    return n < 1e-6

# Calculates rotation matrix to euler angles
# The result is the same as MATLAB except the order
# of the euler angles ( x and z are swapped ).
def rotationMatrixToEulerAngles(R) :

    assert(isRotationMatrix(R))

    sy = math.sqrt(R[0,0] * R[0,0] +  R[1,0] * R[1,0])

    singular = sy < 1e-6

    if  not singular :
        x = math.atan2(R[2,1] , R[2,2])
        y = math.atan2(-R[2,0], sy)
        z = math.atan2(R[1,0], R[0,0])
    else :
        x = math.atan2(-R[1,2], R[1,1])
        y = math.atan2(-R[2,0], sy)
        z = 0

    return np.array([x, y, z])


class DataSuite():
    def __init__(self, data_record_dir, need_image_remap, generateCurve=False, default_configs_dir=None):
        self.data_record_dir = data_record_dir
        self.camera_params = {}
        self.camera_projections = {}
        self.topdown_proj = {}
        #self.topdown_coord = None
        #self.car_config = None
        #self.stitch_image_dir = None

        if (generateCurve):
            if len(data_record_dir) == 3:
                camera_config_file, stitching_config_file, car_config_file = data_record_dir[:]
            else:
                camera_config_file, stitching_config_file = data_record_dir[:]
            self.camera_params = CameraCalibParams.CameraCalibParams()
            self.camera_params.LoadFromFile(camera_config_file)
            # print ("cam params", self.camera_params.configs[0].rvec, self.camera_params.configs[0].tvec)
            for conf_name in self.camera_params.configs:
                conf = self.camera_params.configs[conf_name]
                proj = CameraProjection.CameraProjection(conf)
                self.camera_projections[conf_name] = proj

            self.stitching_config = StitchingConfig.StitchingConfig()
            self.stitching_config.LoadFromFile(stitching_config_file)

            # car_config_file = os.path.join(data_record_dir, "car_info.json")
            if len(data_record_dir) == 3:
                self.car_config = CarConfig.CarConfig()
                self.car_config.LoadFromFile(car_config_file)

            self.z_plane = self.camera_params.GetGroundZ()
            self.topdown_proj = TopdownProjection.TopdownProjection(self.camera_projections, 
                                                                    self.z_plane, 
                                                                    self.stitching_config)
            if need_image_remap:
                from ad_ext import ProjectionCache
                fingerprint = ProjectionCache.compute_calib_fingerprint(
                    camera_config_file, stitching_config_file)
                cache_dir = os.path.dirname(os.path.abspath(camera_config_file))
                self.topdown_proj.LoadOrGenerateMap(cache_dir, fingerprint)

            # self.stitch_image_dir = os.path.join(data_record_dir, "image", "stitched")
        
        else:

            conf_dirs = []

            self.conf_selector = ConfigSelector.ConfigSelector(default_configs_dir)
            if data_record_dir is None:
                conf_dirs = self.conf_selector.GetAllConfigDirs()
            else:
                if len(data_record_dir) == 1:
                    conf_dirs = [data_record_dir[0]]
                elif len(data_record_dir) > 1:
                    image_dir = data_record_dir[0]
                    conf_dir = self.conf_selector.GetConfigDir(image_dir)
                    if conf_dir:
                        conf_dirs = [conf_dir]
                    else:
                        # not found, try load all
                        conf_dirs = self.conf_selector.GetAllConfigDirs()
                else:
                    print ('data_record_dir', data_record_dir)
                    raise ValueError('wrong param')

            for conf_dir in conf_dirs:

                camera_config_file = os.path.join(conf_dir, "camera_config.json")
                stitching_config_file = os.path.join(conf_dir, "stitching_config.json")
                if not os.path.isfile(stitching_config_file):
                    parent_dir = os.path.dirname(os.path.dirname(camera_config_file))
                    parent_config = os.path.join(parent_dir, "stitching_config.json")
                    if os.path.isfile(parent_config):
                        stitching_config_file = parent_config # using default confs


                self.camera_params[conf_dir] = CameraCalibParams.CameraCalibParams()
                self.camera_params[conf_dir].LoadFromFile(camera_config_file)
                # print ("=====================cam params", conf_dir, 
                #     self.camera_params[conf_dir].configs[0].rvec, self.camera_params[conf_dir].configs[0].tvec)

                self.camera_projections[conf_dir] = {}
                for conf_name in self.camera_params[conf_dir].configs:
                    conf = self.camera_params[conf_dir].configs[conf_name]
                    proj = CameraProjection.CameraProjection(conf)
                    self.camera_projections[conf_dir][conf_name] = proj
                
                stitching_config = StitchingConfig.StitchingConfig()
                stitching_config.LoadFromFile(stitching_config_file)
                # self.topdown_coord = TopdownCoordinate.TopdownCoordinate(stitching_config.output_far)

                #car_config_file = os.path.join(data_record_dir, "car_info.json")
                #self.car_config = CarConfig.CarConfig()
                #self.car_config.LoadFromFile(car_config_file)

                z_plane = self.camera_params[conf_dir].GetGroundZ()
                self.topdown_proj[conf_dir] = TopdownProjection.TopdownProjection(self.camera_projections[conf_dir], z_plane, stitching_config)
                if need_image_remap:
                    from ad_ext import ProjectionCache
                    fingerprint = ProjectionCache.compute_calib_fingerprint(
                        camera_config_file, stitching_config_file)
                    self.topdown_proj[conf_dir].LoadOrGenerateMap(conf_dir, fingerprint)

                #self.stitch_image_dir = os.path.join(data_record_dir, "image", "stitched")


    def GenerateTopdownImage(self, cam_image_file, conf_key):
        img = cv2.imread(cam_image_file)
        cam_idx = Utils.GetCameraIndexFromImageOrAnnoFile(cam_image_file)

        img = cv2.remap(img, self.topdown_proj[conf_key].map_xys[cam_idx], None, cv2.INTER_LINEAR)
        return img

    def GenerateExtendTopdownImage(self, cam_image_file, conf_key):
        img0 = cv2.imread(cam_image_file)
        cam_idx0 = Utils.GetCameraIndexFromImageOrAnnoFile(cam_image_file)

        topdown_proj = self.topdown_proj[conf_key]
        cam_conf = self.camera_params[conf_key].configs[cam_idx0]
        if img0.shape[1] != cam_conf.height or img0.shape[0] != cam_conf.width:
            # for thumbnail image, resize to the original size
            img0 = cv2.resize(img0, (cam_conf.width, cam_conf.height))
        img0 = cv2.remap(img0, topdown_proj.map_xys[cam_idx0], None, cv2.INTER_LINEAR)

        bbox = topdown_proj.coord_utils[cam_idx0].bbox_ext

        width = (bbox[3] - bbox[1])
        height = (bbox[2] - bbox[0])
        img = np.zeros((height, width, img0.shape[-1]), dtype=img0.dtype)
        img[:,:,:] = [128,128,128]

        kIndicateMargin = 20

        def CoordToIndex(x, y, bbox):
            i_x = bbox[3] - y
            i_y = bbox[2] - x
            return i_x, i_y

        def CopyImage(src_img, src_box, dst_img, dst_box):
            inter_box = Utils.BoxIntersect(src_box, dst_box)
            if inter_box is not None:
                p0_dst = CoordToIndex(inter_box[0], inter_box[1], dst_box)
                p1_dst = CoordToIndex(inter_box[2], inter_box[3], dst_box)
                p0_src = CoordToIndex(inter_box[0], inter_box[1], src_box)
                p1_src = CoordToIndex(inter_box[2], inter_box[3], src_box)

                dst_img[p1_dst[1]:p0_dst[1],p1_dst[0]:p0_dst[0],:] = src_img[p1_src[1]:p0_src[1],p1_src[0]:p0_src[0],:]
      
        def GetTopdownImage(cam_image_file, cam_index):

            file_dir = os.path.dirname(cam_image_file)
            file_stem, file_ext = os.path.splitext(os.path.basename(cam_image_file))
            file_stem_strs = file_stem.split("_")[:-1]
            image_path = os.path.join(file_dir, '_'.join(file_stem_strs + [str(cam_index)])+file_ext)
            if os.path.exists(image_path):
                img = cv2.imread(image_path)
            else:
                for i in range(4):
                    if i != cam_index:
                        other_image_path = os.path.join(file_dir, '_'.join(file_stem_strs + [str(i)])+file_ext)
                        if os.path.exists(other_image_path):
                            image_shape = cv2.imread(other_image_path).shape
                print(image_path,"is not exist!!!")
                img = np.zeros(image_shape,dtype=int).astype("uint8")
            img = cv2.remap(img, self.topdown_proj[conf_key].map_xys[cam_index], None, cv2.INTER_LINEAR)
            bbox = self.topdown_proj[conf_key].coord_utils[cam_index].bbox_in_pixel

            return img, bbox

        def CopyAssistImage(cam_idx):
            a_img, a_box = GetTopdownImage(cam_image_file, cam_idx)
            a_img = a_img / 2 # darken it
            CopyImage(a_img, a_box, img, bbox)

        if cam_idx0 == CAMERA_SURROUND_FRONT:
            # copy order: least important image first

            CopyAssistImage(CAMERA_SURROUND_BACK)
            CopyAssistImage(CAMERA_SURROUND_LEFT)
            CopyAssistImage(CAMERA_SURROUND_RIGHT)
            
            # draw some border to indicate non-current image
            img[:,0:kIndicateMargin,:] = 255
            img[:,-kIndicateMargin:img.shape[1],:] = 255

        elif cam_idx0 == CAMERA_SURROUND_BACK:
            CopyAssistImage(CAMERA_SURROUND_FRONT)
            CopyAssistImage(CAMERA_SURROUND_LEFT)
            CopyAssistImage(CAMERA_SURROUND_RIGHT)
            
            img[:,0:kIndicateMargin,:] = 255
            img[:,-kIndicateMargin:img.shape[1],:] = 255

        elif cam_idx0 == CAMERA_SURROUND_LEFT:
            CopyAssistImage(CAMERA_SURROUND_RIGHT)
            CopyAssistImage(CAMERA_SURROUND_FRONT)
            CopyAssistImage(CAMERA_SURROUND_BACK)
            
            img[0:kIndicateMargin,:,:] = 255
            img[-kIndicateMargin:img.shape[0],:,:] = 255

        elif cam_idx0 == CAMERA_SURROUND_RIGHT:
            CopyAssistImage(CAMERA_SURROUND_LEFT)
            CopyAssistImage(CAMERA_SURROUND_FRONT)
            CopyAssistImage(CAMERA_SURROUND_BACK)
            
            img[0:kIndicateMargin,:,:] = 255
            img[-kIndicateMargin:img.shape[0],:,:] = 255

        elif cam_idx0 == CAMERA_FRONT_NEAR or cam_idx0 == CAMERA_FRONT_MIDDLE:
            # front views has a different timestamp, so no assist images
            # CopyAssistImage(CAMERA_SURROUND_BACK)
            # CopyAssistImage(CAMERA_SURROUND_LEFT)
            # CopyAssistImage(CAMERA_SURROUND_RIGHT)
            
            img[:,0:kIndicateMargin,:] = 255
            img[:,-kIndicateMargin:img.shape[1],:] = 255

        bbox0 = self.topdown_proj[conf_key].coord_utils[cam_idx0].bbox_in_pixel
        CopyImage(img0, bbox0, img, bbox)

        return img

    def TransformPoint(self, x, y, z, camera_index, is_topdown_image_coord, is_image_to_world, conf_key):
        global data_suite
        #print ("=====input xy===", x, y)

        projs = self.camera_projections.get(conf_key)
        if projs is None or camera_index not in projs:
            return None
        if is_topdown_image_coord:
            td = self.topdown_proj.get(conf_key)
            if td is None or camera_index not in td.coord_utils:
                return None

        if is_image_to_world:
            xy = self.camera_projections[conf_key][camera_index].CoordImageToWorld(x, y, z)
            if xy is None:
                return None
            
            x, y = xy
            #print ("=====world xy===", x, y)
            if is_topdown_image_coord:
                x, y = self.topdown_proj[conf_key].coord_utils[camera_index].CoordCarToImage(x, y, True)
            #print ("=====image xy===", x, y)
        else:
            if is_topdown_image_coord:
                x, y = self.topdown_proj[conf_key].coord_utils[camera_index].CoordImageToCar(x, y, True)

            #print ("=====world xy===", x, y)
            xy = self.camera_projections[conf_key][camera_index].CoordWorldToImage(x, y, z)
            #print ("=====image xy===", xy)
            if xy is None:
                return None
            
            x, y = xy

        # work around for pinhole
        if abs(x) > 10000 or abs(y) > 10000:
            return None

        return x,y


    def TransformShapes(self, shape_list, camera_index, is_topdown_image_coord, is_image_to_world, conf_key):
        
        z_plane = self.camera_params[conf_key].GetGroundZ()

        for a_shape in shape_list:
            # bbox
            # for pt in shape[1]:
            #     pt[0] *= 0.5
            #     pt[1] *= 0.5
            if type(a_shape) is tuple or type(a_shape) is list:
                
                #print('===a_shape', a_shape)
                keypoints = a_shape[2]

                new_kps = []
                for pt in keypoints:
                    pt_z = z_plane
                    if len(pt) > 2 and pt[2] is not None:
                        pt_z += pt[2]
                    new_pt = self.TransformPoint(pt[0], pt[1], pt_z, camera_index, is_topdown_image_coord, is_image_to_world, conf_key)
                    #print('a convert', pt, '->', new_pt)
                    new_kps.append(new_pt)
                #print('===a_shape[2]', a_shape[2],"new_kps",new_kps)
                a_shape[2].clear()
                for pt in new_kps:
                    a_shape[2].append(pt)

                #print('===a_shape new', a_shape)

            else:
                for index in range(len(a_shape.keypoint.points)):
                    kp = a_shape.keypoint.points[index]
                    pt_z = z_plane
                    if index < len(a_shape.keypoint.point_elevations):
                        pt_z += a_shape.keypoint.point_elevations[index]
                    new_pt = self.TransformPoint(kp.x(), kp.y(), pt_z, camera_index, is_topdown_image_coord, is_image_to_world, conf_key)
                    #print ('transform shape', a_shape.label, kp.x(), kp.y(), '->', new_pt)
                    kp.setX(new_pt[0])
                    kp.setY(new_pt[1])
                    

    # point format: 
    # 1) image coord and height(or None): [[x, y], height]
    # 2) world coord: [x, y, z]
    def InterpolatePointsInWorldIteratively(self, start_point, end_point, max_pixel_error, camera_index, conf_key):
        ground_z = self.camera_params[conf_key].GetGroundZ()
        kps = [start_point, end_point]
        
        kps_world = []
        for pt in kps:
            if len(pt) == 3: # it's a 3d point
                kps_world.append(pt)
            elif len(pt) == 2:

                uv = pt[0]
                if pt[1] is not None:
                    pt_z = ground_z + pt[1]
                else:
                    pt_z = ground_z

                xy = self.TransformPoint(uv[0], uv[1], pt_z, camera_index, False, True, conf_key)
                if xy is None:
                    return [start_point[0], end_point[0]] 
                kps_world.append(np.array([xy[0], xy[1], pt_z]))
            else:
                raise ValueError('bad point format')

        INTERP_DONE, INTERP_FAIL, INTERP_NEED_ITER = range(3)
        kps_world_interp = [[x, INTERP_NEED_ITER] for x in kps_world]
        need_iter = True
        kMaxIterpPoints = 200
        #print ('start interp', len(kps_world_interp))
        while need_iter and len(kps_world_interp) < kMaxIterpPoints:
            has_err = False
            #print ('1 interp', len(kps_world_interp))
            for idx in reversed(range(1, len(kps_world_interp))): # reverse to insert on fly
                if kps_world_interp[idx][1] != INTERP_NEED_ITER:
                    continue

                kps_world0 = kps_world_interp[idx-1][0]
                kps_world1 = kps_world_interp[idx][0]
                kNumPoints = 1
                interp_points_3d = self.InterpolateWorldPointsInternal(kps_world0, kps_world1, kNumPoints)
                if interp_points_3d is None or len(interp_points_3d) != kNumPoints + 2:
                    kps_world_interp[idx][1] = INTERP_FAIL
                    continue
                interp_pt = interp_points_3d[1] # mid point of 3 points
                interp_pt_uv = self.TransformPoint(interp_pt[0], interp_pt[1], interp_pt[2], camera_index, False, False, conf_key)
                kps_uv0 = self.TransformPoint(kps_world0[0], kps_world0[1], kps_world0[2], camera_index, False, False, conf_key)
                kps_uv1 = self.TransformPoint(kps_world1[0], kps_world1[1], kps_world1[2], camera_index, False, False, conf_key)
                if interp_pt_uv is None or kps_uv0 is None or kps_uv1 is None:
                    kps_world_interp[idx][1] = INTERP_FAIL
                    continue
                center_kps_uv = [(kps_uv0[0] + kps_uv1[0])/2, (kps_uv0[1] + kps_uv1[1])/2]
                pixel_err = max(abs(center_kps_uv[0] - interp_pt_uv[0]), abs(center_kps_uv[1] - interp_pt_uv[1]))
                flag = INTERP_DONE
                if pixel_err > max_pixel_error:
                    flag = INTERP_NEED_ITER
                    has_err = True
                kps_world_interp[idx][1] = flag
                kps_world_interp.insert(idx, [interp_pt, flag])
                #print ('2 interp', idx, interp_pt)

                if len(kps_world_interp) >= kMaxIterpPoints:
                    break

            need_iter = has_err

        #print ('finish interp', len(kps_world_interp))
        point_list = []
        for pt_info in kps_world_interp:
            pt = pt_info[0]
            xy = self.TransformPoint(pt[0], pt[1], pt[2], camera_index, False, False, conf_key)
            if xy is None:
                continue
            point_list.append(xy)
        #print ('interp iteratly', len(point_list))
        return point_list

    def InterpolateImagePointsInWorld(self, start_point, end_point, interval_in_pixel, camera_index, conf_key):
        ground_z = self.camera_params[conf_key].GetGroundZ()
        kps = [np.array(start_point), np.array(end_point)]
        vec = kps[1] - kps[0]
        line_length = np.linalg.norm(vec)
        num_points = int(line_length // interval_in_pixel) 
        if num_points <= 0:
            return [start_point, end_point] 

        kps_world = []
        for pt in kps:
            xy = self.TransformPoint(pt[0], pt[1], ground_z, camera_index, False, True, conf_key)
            if xy is None:
                return [start_point, end_point] 
            kps_world.append(np.array([xy[0], xy[1], ground_z]))

        inter_points_3d = self.InterpolateWorldPointsInternal(kps_world[0], kps_world[1], num_points)
        if inter_points_3d is None:
            return [start_point, end_point] 

        point_list = []
        for pt in inter_points_3d:
            xy = self.TransformPoint(pt[0], pt[1], pt[2], camera_index, False, False, conf_key)
            if xy is None:
                continue
            point_list.append(xy)

        return point_list
    
    def InterpolateWorldPoints(self, start_point, end_point, interval_in_pixel, camera_index, conf_key):

        def PointsWorldToImage(points, camera_index, conf_key):
            kps_image = []
            for pt in points:
                #print('xyz', pt[0], pt[1], pt[2])
                xy = self.TransformPoint(pt[0], pt[1], pt[2], camera_index, False, False, conf_key)
                if xy is None:
                    kps_image.append(xy)
                #print ('xy',xy)
                else:
                    kps_image.append([xy[0], xy[1]])
            
            return kps_image
        
        image_pts = PointsWorldToImage([start_point, end_point], camera_index, conf_key)
        if image_pts is None or len(image_pts) != 2 or image_pts[0] is None or image_pts[1] is None:
            return [start_point, end_point]

        kps = np.array(image_pts)
        vec = kps[1] - kps[0]
        line_length = np.linalg.norm(vec)
        num_points = int(line_length // interval_in_pixel) 
        if num_points <= 0:
            return [start_point, end_point] 

        return self.InterpolateWorldPointsInternal(start_point, end_point, num_points)

    def InterpolateWorldPointsInternal(self, start_point, end_point, num_points):
        
        num_points += 2 # include start end points
        dim = 3
        interpolated_points = np.zeros((num_points, dim))
        for i in range(dim):  # Iterate over each dimension
            interpolated_points[:, i] = np.linspace(start_point[i], end_point[i], num_points)  # Interpolate along each dimension
        
        point_list = []
        for i in range(num_points):
            pt = interpolated_points[i, :]
            point_list.append((pt[0], pt[1], pt[2]))

        return point_list

    # point format: 
    # 1) image coord and height(or None): [[x, y], height]
    # 2) world coord: [x, y, z]
    def LiftPointInWorld(self, point, height, camera_index, conf_key):

        if len(point) == 3:
            lifted_xyz = [point[0], point[1], point[2] + height]
        else:
            ground_z = self.camera_params[conf_key].GetGroundZ()
            pt_z = ground_z
            if point[1] is not None:
                pt_z += point[1]
            point_xy = self.TransformPoint(point[0][0], point[0][1], pt_z, camera_index, False, True, conf_key)
            if point_xy is None:
                return None
            lifted_xyz = list(point_xy) + [pt_z + height]

        lifted_uv = self.TransformPoint(lifted_xyz[0], lifted_xyz[1], lifted_xyz[2], camera_index, False, False, conf_key)
        return lifted_uv, lifted_xyz

    def PixelErrTest(self):
        
        camera_index = CAMERA_SURROUND_FRONT #CAMERA_FRONT_MIDDLE
        x = 828.0
        y = 199.0

        a_param = next(iter(self.camera_params.values()))
        a_proj = next(iter(self.camera_projections.values()))
        z_plane = a_param.GetGroundZ()

        coord = a_proj[camera_index].CoordImageToWorld(x, y, z_plane)
        print ("PixelErrTest")
        print ("coord", x,y, coord)

        coord_x = a_proj[camera_index].CoordImageToWorld(x+1, y, z_plane)
        print ("coord", x+1,y, coord_x)

        coord_y = a_proj[camera_index].CoordImageToWorld(x, y+1, z_plane)
        print ("coord", x,y+1, coord_y)


