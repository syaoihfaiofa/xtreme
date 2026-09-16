
from ad_ext import CameraCalibParams
from ad_ext import TopdownCoordinate
from ad_ext import ProjectionCache

import time
import numpy as np
import multiprocessing

from ad_ext.CameraImageIndex import *


    
class TopdownProjection:
    def __init__(self, camera_projections, ground_z, stitching_config):
        self.camera_projections = camera_projections
        self.ground_z = ground_z
        self.stitching_config = stitching_config

        self.cam_indexes = [CAMERA_SURROUND_FRONT, CAMERA_SURROUND_LEFT, CAMERA_SURROUND_BACK, CAMERA_SURROUND_RIGHT,
            CAMERA_FRONT_NEAR, CAMERA_FRONT_MIDDLE]

        out_conf = stitching_config.output_far
        #print('out_conf', out_conf.car_origin_x,out_conf.car_origin_y,out_conf.blind_x,out_conf.blind_y,out_conf.blind_width,out_conf.blind_height)
        blind_area_config = [
            out_conf.car_origin_y-out_conf.blind_y, # front
            out_conf.blind_y+out_conf.blind_height-out_conf.car_origin_y, # back
            out_conf.car_origin_x-out_conf.blind_x, # left
            out_conf.blind_x+out_conf.blind_width-out_conf.car_origin_x, # right
            ]
        #print('blind_area_config', blind_area_config)
        self.blind_area_config = [x / out_conf.pixels_per_meter for x in blind_area_config]
        self.coord_utils = {}
        for idx in self.cam_indexes:
            self.coord_utils[idx] = TopdownCoordinate.TopdownCoordinate(25, self.blind_area_config, idx)

        self.map_xys = {}

    # map coord in projected image to camera image
    def MapSurroundToCamera(self, x, y, index):
        world_x, world_y = self.coord_utils[index].CoordImageToCar(x, y, False)

        image_point = self.camera_projections[index].CoordWorldToImage(world_x,world_y,self.ground_z)

        return image_point

    def MapSurroundToCameraNumpy(self, x, y, index):
        world_x, world_y = self.coord_utils[index].CoordImageToCar(x, y, False)
        world_z = np.zeros_like(world_x) + self.ground_z
        world_xyz = np.stack([world_x, world_y, world_z])
        image_point = self.camera_projections[index].CoordWorldToImageNumpy(world_xyz)

        return image_point

    def GenerateMapTask(self, cam_idx):
        if not cam_idx in self.camera_projections:
            print ('====== skip', cam_idx)
            return # some old data dosen't have front view cameras

        coord_util = self.coord_utils[cam_idx]
        dst_width, dst_height = coord_util.image_size
        print('Generating map for camera ... ', cam_idx)
        # np.mgrid[0:3:1, 0:4:1].reshape(2,-1).T
        
        x, y = np.meshgrid(np.arange(dst_width), np.arange(dst_height))
        xy = np.stack([x.ravel(), y.ravel()]).astype(np.float32) # 2*N array, as xy per points
        src_xy = self.MapSurroundToCameraNumpy(xy[0,:], xy[1,:], cam_idx)

        map_float = np.transpose(src_xy, [1, 0]).reshape((dst_height, dst_width, 2))
        # cv2.remap map1 只接受 float32/int16；新版 numpy 链路里 src_xy 常为 float64
        map_float = map_float.astype(np.float32, copy=False)
        
        # map_float = np.zeros((dst_height, dst_width, 2), dtype=np.float32)
        # for y in range(dst_height):
        #     for x in range(dst_width):
        #         src_x, src_y = self.MapSurroundToCamera(x, y, cam_idx)
        #         map_float[y][x] = [src_x, src_y]
        #         #print("coord ", x, y, " -> ", src_x, src_y)
            
        #     if y % 100 == 0:
        #         print("coord", cam_idx, " line", y, "of", dst_height)
            
        
        return map_float
        
    def GenerateMap(self):

        if len(self.cam_indexes) == 0:
            return

        t1 = time.time()

        pool = multiprocessing.Pool(processes=len(self.cam_indexes))
        results = pool.map(self.GenerateMapTask, [cam_idx for cam_idx in self.cam_indexes])
        pool.close()
        pool.join()

        for cam_idx, result in zip(self.cam_indexes, results):
            self.map_xys[cam_idx] = result
        
        t2 = time.time()

        print ("GenerateMap timecost", t2-t1)

    def _expected_map_shapes(self):
        """期望的各相机 map 形状 {cam_idx: (height, width)}，用于缓存校验。"""
        expected = {}
        for cam_idx in self.cam_indexes:
            if cam_idx not in self.camera_projections:
                continue
            dst_width, dst_height = self.coord_utils[cam_idx].image_size
            expected[cam_idx] = (dst_height, dst_width)
        return expected

    def LoadOrGenerateMap(self, conf_dir, fingerprint):
        """优先读取本地缓存的 IPM remap 表；缺失/校验失败则在线计算并落盘。

        缓存有效性以 fingerprint（标定文件指纹）+ 版本 + 相机集合 + 各表形状综合判定，
        以避免标定被临时修改后仍误用过期缓存。
        """
        if not fingerprint:
            # 无法计算指纹（如缺标定路径），退回在线计算，不缓存
            self.GenerateMap()
            return

        expected = self._expected_map_shapes()
        if len(expected) == 0:
            self.GenerateMap()
            return

        read_file = ProjectionCache.cache_file_for(conf_dir, fingerprint, writable=False)
        cached = ProjectionCache.load_topdown_map(read_file, fingerprint, expected)
        if cached is not None:
            self.map_xys = cached
            print("GenerateMap loaded from cache:", read_file)
            return

        # 缓存缺失或失效：在线计算
        self.GenerateMap()

        # 写盘供下次复用（失败不影响主流程）
        write_file = ProjectionCache.cache_file_for(conf_dir, fingerprint, writable=True)
        if ProjectionCache.save_topdown_map(write_file, fingerprint, self.map_xys):
            print("GenerateMap cached to:", write_file)

        
    
        
    

