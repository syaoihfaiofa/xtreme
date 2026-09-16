import json
import math
import os

from ad_ext.CameraImageIndex import *

DEFAULT_CAR_NAME = 'BYD_QinPro_white'
DEFAULT_COIL_RADIUS_M = 8.0
ARC_STEP_DEG = 2.0

CAM_INDEX_TO_KEY = {
    CAMERA_SURROUND_FRONT: 'front',
    CAMERA_SURROUND_LEFT: 'left',
    CAMERA_SURROUND_BACK: 'rear',
    CAMERA_SURROUND_RIGHT: 'right',
}

# Only sample the ground arc in each camera's forward hemisphere to avoid
# wrap-around gaps after image clipping (especially on front camera index 0).
CAMERA_VISIBLE_ANGLE_RANGES = {
    'front': (-90.0, 90.0),
    'rear': (90.0, 270.0),
    'left': (0.0, 180.0),
    'right': (180.0, 360.0),
}

def load_car_info(conf_dir):
    car_info_file = os.path.join(os.path.dirname(conf_dir), 'car_info.json')
    if not os.path.isfile(car_info_file):
        return None
    with open(car_info_file, 'r', encoding='utf-8') as f:
        jobj = json.load(f)
    return jobj.get('car_info')


def get_camera_center(car_info, camera_key):
    wheel_base = car_info['wheel_base']
    front_overhang = car_info['front_overhang']
    rear_overhang = car_info['rear_overhang']
    car_width = car_info['car_width']
    return {
        'front': (wheel_base + front_overhang, 0),
        'left': (wheel_base - 0.2, car_width / 2),
        'rear': (-rear_overhang, 0),
        'right': (wheel_base - 0.2, -car_width / 2),
    }.get(camera_key)


def compute_coil_circle_points(car_info, camera_key, radius=DEFAULT_COIL_RADIUS_M, step_deg=ARC_STEP_DEG):
    """Sample a continuous ground-plane circle arc visible to the given surround camera."""
    center = get_camera_center(car_info, camera_key)
    angle_range = CAMERA_VISIBLE_ANGLE_RANGES.get(camera_key)
    if center is None or angle_range is None:
        return None

    cx, cy = center
    start_deg, end_deg = angle_range
    points = []
    angle = start_deg
    while angle <= end_deg + 1e-6:
        rad = math.radians(angle)
        points.append((cx + radius * math.cos(rad), cy + radius * math.sin(rad)))
        angle += step_deg
    return points


def _project_points_to_image_segments(data_suite, conf_key, camera_index, world_points, ground_z):
    """Project world points to image; split when projection fails."""
    segments = []
    current = []
    for wx, wy in world_points:
        pt = data_suite.TransformPoint(wx, wy, ground_z, camera_index, False, False, conf_key)
        if pt is not None:
            current.append(pt)
        else:
            if len(current) >= 2:
                segments.append(current)
            current = []
    if len(current) >= 2:
        segments.append(current)
    return segments


def _point_in_image(pt, image_width, image_height):
    return 0.0 <= pt[0] <= image_width and 0.0 <= pt[1] <= image_height


def _clamp_point_to_image(pt, image_width, image_height):
    return [min(max(pt[0], 0.0), image_width), min(max(pt[1], 0.0), image_height)]


def _clip_segments_to_image(segments, image_width, image_height):
    """Keep in-image portion; clamp edge crossings instead of splitting arcs."""
    if image_width is None or image_height is None or image_width <= 0 or image_height <= 0:
        return segments

    clipped = []
    for seg in segments:
        current = []
        for pt in seg:
            if _point_in_image(pt, image_width, image_height):
                current.append(pt)
            else:
                boundary_pt = _clamp_point_to_image(pt, image_width, image_height)
                if current:
                    current.append(boundary_pt)
                    if len(current) >= 2:
                        clipped.append(current)
                    current = []
                else:
                    current = [boundary_pt]
        if len(current) >= 2:
            clipped.append(current)
    return clipped


def _scale_polyline(shape_shifter, polyline):
    if shape_shifter is None:
        return polyline
    return [shape_shifter._scale_point_from_config(pt) for pt in polyline]


def compute_coil_guide_polylines(data_suite, shape_shifter, radius=DEFAULT_COIL_RADIUS_M):
    """Return polylines (image coordinates) for the ground circle guide."""
    if data_suite is None or shape_shifter is None:
        return []

    conf_key = shape_shifter.labeling_conf_key
    camera_index = shape_shifter.labeling_cam_idx
    if conf_key is None or camera_index is None:
        return []

    camera_key = CAM_INDEX_TO_KEY.get(camera_index)
    if camera_key is None:
        return []

    if conf_key not in data_suite.camera_params:
        return []

    car_info = load_car_info(conf_key)
    if car_info is None:
        return []

    world_points = compute_coil_circle_points(car_info, camera_key, radius=radius)
    if not world_points:
        return []

    ground_z = data_suite.camera_params[conf_key].GetGroundZ()
    segments = _project_points_to_image_segments(
        data_suite, conf_key, camera_index, world_points, ground_z)

    if not segments:
        return []

    segments = [_scale_polyline(shape_shifter, seg) for seg in segments if len(seg) >= 2]
    return _clip_segments_to_image(
        segments, shape_shifter.image_width, shape_shifter.image_height)
