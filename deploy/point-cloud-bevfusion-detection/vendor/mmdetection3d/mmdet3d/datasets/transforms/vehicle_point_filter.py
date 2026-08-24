# Copyright (c) OpenMMLab. All rights reserved.

import json
from pathlib import Path
from typing import Any, Dict, Tuple, Union

import numpy as np
from mmcv.transforms import BaseTransform

from mmdet3d.registry import TRANSFORMS


def load_car_info(car_config_path: Union[str, Path]) -> Dict[str, Any]:
    """Load vehicle geometry from a JSON config file."""
    config_path = Path(car_config_path)
    with config_path.open(encoding='utf-8') as file_obj:
        config_data = json.load(file_obj)
    if 'car_info' not in config_data:
        raise KeyError(f'Missing car_info in vehicle config: {config_path}')
    return config_data['car_info']


def compute_vehicle_exclusion_region(
        car_info: Dict[str, Any],
        blind_zone_front: float,
        blind_zone_rear: float) -> Tuple[float, float, float, float]:
    """Return x/y bounds to exclude in the rear-axle LiDAR frame."""
    rear_extent = -float(car_info['rear_overhang']) - blind_zone_rear
    front_extent = (
        float(car_info['wheel_base']) +
        float(car_info['front_overhang']) +
        blind_zone_front)
    half_width = float(car_info['car_width']) / 2.0
    return rear_extent, front_extent, -half_width, half_width


def mask_points_outside_vehicle_region(
        points: np.ndarray,
        exclusion_region: Tuple[float, float, float, float]) -> np.ndarray:
    """Keep points outside the vehicle body plus front/rear blind zones."""
    x_min, x_max, y_min, y_max = exclusion_region
    inside_vehicle = (
        (points[:, 0] >= x_min) & (points[:, 0] <= x_max) &
        (points[:, 1] >= y_min) & (points[:, 1] <= y_max))
    return points[~inside_vehicle]


@TRANSFORMS.register_module()
class FilterVehicleBlindZone(BaseTransform):
    """Remove points inside the ego vehicle footprint and blind zones.

    The LiDAR frame origin is assumed to be the rear-axle center, with x
    forward and y left.
    """

    def __init__(self,
                 car_config_path: str,
                 blind_zone_front: float,
                 blind_zone_rear: float) -> None:
        car_info = load_car_info(car_config_path)
        self.exclusion_region = compute_vehicle_exclusion_region(
            car_info, blind_zone_front, blind_zone_rear)

    def transform(self, results: dict) -> dict:
        """Filter points that fall inside the configured vehicle region."""
        points = results['points']
        points_numpy = points.numpy()
        filtered_points = mask_points_outside_vehicle_region(
            points_numpy, self.exclusion_region)
        results['points'] = points.new_point(filtered_points)
        return results
