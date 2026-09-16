
from ad_ext.CameraImageIndex import *


def IsStitchImage(camera_index):
    return camera_index >= CAMERA_STITCHED

class TopdownCoordinate():
    def __init__(self, pixels_per_meter, blind_area_config, camera_index, print_log=False):
        self.pixels_per_meter = pixels_per_meter
        self.blind_area_config = blind_area_config
        self.camera_index = camera_index

        self.CalculateWorldAreaInPixel()
        self.CalculateImageSize()
        if print_log:
            print("TopdownCoordinate",camera_index, self.bbox_in_pixel, self.image_size)

    def CalculateWorldAreaInPixel(self):
        # bbox of area to show in topdown image, in world coordinate, but unit is pixel

        side_width = 16
        side_height = 24.8
        
        front_height = 15
        front_width = 24.8

        extend_opposite_margin = 4

        if self.camera_index == CAMERA_SURROUND_FRONT:
            bbox = [self.blind_area_config[0], -front_width/2, self.blind_area_config[0] + front_height, front_width/2]
            bbox_ext = bbox[:]
            bbox_ext[0] = -self.blind_area_config[1] - extend_opposite_margin
        elif self.camera_index == CAMERA_SURROUND_BACK:
            bbox = [-self.blind_area_config[1]-front_height, -front_width/2, -self.blind_area_config[1], front_width/2]
            bbox_ext = bbox[:]
            bbox_ext[2] = self.blind_area_config[0] + extend_opposite_margin
        elif self.camera_index == CAMERA_SURROUND_LEFT:
            bbox = [2.3 - side_height/2, self.blind_area_config[2], 2.3 + side_height/2, self.blind_area_config[2] + side_width]
            bbox_ext = bbox[:]
            bbox_ext[1] = -self.blind_area_config[3] - extend_opposite_margin
        elif self.camera_index == CAMERA_SURROUND_RIGHT:
            bbox = [2.3 - side_height/2, -self.blind_area_config[3] - side_width, 2.3 + side_height/2, -self.blind_area_config[3]]
            bbox_ext = bbox[:]
            bbox_ext[3] = self.blind_area_config[2] + extend_opposite_margin
        elif self.camera_index == CAMERA_FRONT_MIDDLE:
            a_front_height = 35
            a_front_width = 24.8
            a_front_offset = 5
            bbox = [a_front_offset, -a_front_width/2, a_front_offset + a_front_height, a_front_width/2]
            bbox_ext = bbox[:]
            bbox_ext[0] = -self.blind_area_config[1]-extend_opposite_margin
        elif self.camera_index == CAMERA_FRONT_NEAR:
            a_front_height = 20
            a_front_width = 24.8
            a_front_offset = 5
            bbox = [a_front_offset, -a_front_width/2, a_front_offset + a_front_height, a_front_width/2]
            bbox_ext = bbox[:]
            bbox_ext[0] = -self.blind_area_config[1]-extend_opposite_margin
        else:
            bbox = None

        # to avoid sub-pixel issue
        if bbox is not None:
            self.bbox_in_pixel = [int(x*self.pixels_per_meter) for x in bbox]
            self.bbox_ext = [int(x*self.pixels_per_meter) for x in bbox_ext]
        else:
            self.bbox_in_pixel = None
            self.bbox_ext = None

        
    def CalculateImageSize(self):

        self.image_size = None

        bbox = self.bbox_in_pixel
        if bbox is None:
            return None

        width = (bbox[3] - bbox[1])
        height = (bbox[2] - bbox[0])
        self.image_size = (width, height)

    def GetWorldBBox(self):
        return [float(x)/self.pixels_per_meter for x in self.bbox_in_pixel]

    def CoordImageToCar(self, x, y, is_extend):
        if IsStitchImage(self.camera_index):
            nx = (self.car_origin_y - y) / self.pixels_per_meter
            ny = (self.car_origin_x - x) / self.pixels_per_meter
        else:
            bbox = self.bbox_ext if is_extend else self.bbox_in_pixel
            nx = (bbox[2] - y) / self.pixels_per_meter
            ny = (bbox[3] - x) / self.pixels_per_meter
        return nx, ny

    def CoordCarToImage(self, x, y, is_extend):
        if IsStitchImage(self.camera_index):
            nx = self.car_origin_x - y * self.pixels_per_meter
            ny = self.car_origin_y - x * self.pixels_per_meter
        else:
            bbox = self.bbox_ext if is_extend else self.bbox_in_pixel
            nx = bbox[3] - y * self.pixels_per_meter
            ny = bbox[2] - x * self.pixels_per_meter
        return nx, ny
