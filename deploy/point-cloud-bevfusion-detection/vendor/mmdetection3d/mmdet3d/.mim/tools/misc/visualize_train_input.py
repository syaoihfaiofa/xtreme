#!/usr/bin/env python3
"""Visualize point clouds and labels after the training pipeline."""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Sequence

import cv2
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import torch
from matplotlib.axes import Axes
from mmengine.config import Config
from mmengine.dataset import Compose
from mmengine.registry import init_default_scope

from mmdet3d.datasets.transforms.vehicle_point_filter import (
    compute_vehicle_exclusion_region,
    load_car_info,
)
from mmdet3d.registry import DATASETS, TRANSFORMS
from mmdet3d.structures import LiDARInstance3DBoxes

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))
from visualize_nuscense import (  # noqa: E402
    draw_box_on_image,
    draw_fisheye_box_on_image,
    interpolate_box_edges,
    project_lidar_points_to_image,
)

CAMERA_CHANNELS: tuple[str, ...] = (
    'CAM_FRONT',
    'CAM_RIGHT',
    'CAM_BACK',
    'CAM_LEFT',
)
CAMERA_LABELS: tuple[str, ...] = (
    'Front',
    'Right',
    'Back',
    'Left',
)

CLASS_COLORS: dict[str, tuple[float, float, float]] = {
    'Car': (0.0, 0.6, 1.0),
    'Cone': (1.0, 0.5, 0.0),
    'Pillar': (0.6, 0.2, 0.8),
}

BOX_EDGES: tuple[tuple[int, int], ...] = (
    (0, 1), (1, 2), (2, 3), (3, 0),
    (4, 5), (5, 6), (6, 7), (7, 4),
    (0, 4), (1, 5), (2, 6), (3, 7),
)


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Visualize training inputs after the full train pipeline.')
    parser.add_argument(
        '--config',
        type=Path,
        default=Path(
            'projects/BEVFusion/configs/bevfusion_lidar_voxel0075_custom-nus-3class.py'),
        help='Training config that defines the dataset pipeline.')
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('outputs/vis/train-input'),
        help='Directory to save rendered images.')
    parser.add_argument(
        '--mode',
        type=str,
        default='all',
        choices=['bev', 'camera', 'all'],
        help='bev: top-down only; camera: four camera views; all: cameras + BEV.')
    parser.add_argument(
        '--data-root',
        type=Path,
        default=Path('data/nuscenes'),
        help='Dataset root used to resolve camera images and calibration.')
    parser.add_argument(
        '--metadata-version',
        type=str,
        default='v1.0-trainval',
        help='nuScenes metadata version folder under data-root.')
    parser.add_argument('--num-samples', type=int, default=12)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument(
        '--max-points',
        type=int,
        default=120000,
        help='Maximum number of points to draw per sample.')
    parser.add_argument(
        '--bev-range',
        type=float,
        nargs=4,
        default=(-21.0, 21.0, -21.0, 21.0),
        metavar=('XMIN', 'XMAX', 'YMIN', 'YMAX'))
    parser.add_argument(
        '--z-range',
        type=float,
        nargs=2,
        default=(-5.0, 4.0),
        metavar=('ZMIN', 'ZMAX'),
        help='Height range used by front/side LiDAR views.')
    parser.add_argument(
        '--car-config',
        type=Path,
        default=Path('outputs/car.json'),
        help='Vehicle geometry JSON used to draw the excluded ego region.')
    parser.add_argument('--blind-zone-front', type=float, default=1.3)
    parser.add_argument('--blind-zone-rear', type=float, default=1.3)
    return parser.parse_args()


class NuScenesCalibrationLookup:
    """Load calibrated_sensor records indexed by sample_data token."""

    def __init__(self, data_root: Path, version: str) -> None:
        version_dir = data_root / version
        sample_data = json.loads(
            (version_dir / 'sample_data.json').read_text(encoding='utf-8'))
        calibrated_sensor = json.loads(
            (version_dir / 'calibrated_sensor.json').read_text(encoding='utf-8'))
        calibrated_by_token = {
            record['token']: record for record in calibrated_sensor
        }
        self._by_sample_data_token: dict[str, dict] = {}
        for record in sample_data:
            calibrated_token = record['calibrated_sensor_token']
            if calibrated_token in calibrated_by_token:
                self._by_sample_data_token[record['token']] = (
                    calibrated_by_token[calibrated_token])

    def get(self, sample_data_token: str) -> dict:
        """Return calibrated_sensor for one sample_data token."""
        if sample_data_token not in self._by_sample_data_token:
            raise KeyError(
                f'calibrated_sensor not found for sample_data token '
                f'{sample_data_token}')
        return self._by_sample_data_token[sample_data_token]


AUGMENTATION_TRANSFORMS: frozenset[str] = frozenset({
    'GlobalRotScaleTrans',
    'BEVFusionGlobalRotScaleTrans',
    'BEVFusionRandomFlip3D',
    'RandomFlip3D',
})


def build_dataset(config_path: Path):
    """Build the inner training dataset with the configured train pipeline."""
    cfg = Config.fromfile(str(config_path))
    init_default_scope(cfg.get('default_scope', 'mmdet3d'))
    dataset_cfg = cfg.train_dataloader.dataset
    if dataset_cfg['type'] == 'CBGSDataset':
        dataset_cfg = dataset_cfg['dataset']
    if dataset_cfg['type'] == 'RepeatDataset':
        dataset_cfg = dataset_cfg['dataset']
    dataset_cfg = dataset_cfg.copy()
    dataset_cfg['filter_empty_gt'] = False
    return DATASETS.build(dataset_cfg), cfg


def build_pre_augmentation_compose(cfg: Config) -> Compose:
    """Build a compose that loads sensor-aligned geometry before random aug."""
    pre_aug_steps = [
        step for step in cfg.train_pipeline
        if step['type'] not in AUGMENTATION_TRANSFORMS
        and step['type'] != 'ObjectSample'
        and step['type'] != 'Pack3DDetInputs'
        and step['type'] not in (
            'PointsRangeFilter',
            'ObjectRangeFilter',
            'ObjectNameFilter',
            'FilterBoxesWithoutPoints',
            'PointShuffle',
        )
    ]
    return Compose([TRANSFORMS.build(step) for step in pre_aug_steps])


def load_camera_frame_data(
        dataset,
        dataset_idx: int,
        pre_aug_compose: Compose) -> tuple[np.ndarray, LiDARInstance3DBoxes,
                                          torch.Tensor]:
    """Load points and boxes in the original LiDAR frame for camera projection."""
    data_info = copy.deepcopy(dataset.get_data_info(dataset_idx))
    data_info['box_type_3d'] = dataset.box_type_3d
    data_info['box_mode_3d'] = dataset.box_mode_3d
    pipeline_output = pre_aug_compose(data_info)
    points = pipeline_output['points'].tensor.numpy()
    boxes = pipeline_output['gt_bboxes_3d']
    labels = pipeline_output['gt_labels_3d']
    if not isinstance(labels, torch.Tensor):
        labels = torch.as_tensor(labels, dtype=torch.long)
    return points, boxes, labels


def downsample_points(points: np.ndarray, max_points: int,
                      rng: np.random.Generator) -> np.ndarray:
    """Return at most max_points selected without replacement."""
    if len(points) <= max_points:
        return points
    indices = rng.choice(len(points), size=max_points, replace=False)
    return points[indices]


def _to_numpy(value) -> np.ndarray:
    """Convert tensors or arrays to numpy."""
    if isinstance(value, torch.Tensor):
        return value.detach().cpu().numpy()
    return np.asarray(value)


def draw_box_bev(
        axis: Axes,
        box_corners: np.ndarray,
        color: tuple[float, float, float],
        label: str | None = None) -> None:
    """Draw one 3D box projected to the X-Y plane."""
    draw_box_orthographic(
        axis, box_corners, axis_x=0, axis_y=1, color=color, label=label,
        heading_corners=(4, 7))


def draw_box_orthographic(
        axis: Axes,
        box_corners: np.ndarray,
        axis_x: int,
        axis_y: int,
        color: tuple[float, float, float],
        label: str | None = None,
        heading_corners: tuple[int, int] | None = None) -> None:
    """Draw one 3D box wireframe on a 2D orthographic plane."""
    labeled = False
    for start_idx, end_idx in BOX_EDGES:
        legend_label = None
        if not labeled and label is not None:
            legend_label = label
            labeled = True
        axis.plot(
            [box_corners[start_idx, axis_x], box_corners[end_idx, axis_x]],
            [box_corners[start_idx, axis_y], box_corners[end_idx, axis_y]],
            color=color,
            linewidth=1.2,
            label=legend_label)
    if heading_corners is not None:
        start_idx, end_idx = heading_corners
        axis.plot(
            [box_corners[start_idx, axis_x], box_corners[end_idx, axis_x]],
            [box_corners[start_idx, axis_y], box_corners[end_idx, axis_y]],
            color=color,
            linewidth=2.5)


def draw_box_on_image(
        image: np.ndarray,
        projected: np.ndarray,
        color: tuple[int, int, int],
        thickness: int = 2) -> None:
    """Draw a pinhole-projected 3D box on an RGB image."""
    image_height, image_width = image.shape[:2]
    for start_idx, end_idx in BOX_EDGES:
        start_uv = projected[start_idx]
        end_uv = projected[end_idx]
        if not np.isfinite(start_uv).all() or not np.isfinite(end_uv).all():
            continue
        if (start_uv[0] < -image_width or start_uv[0] > 2 * image_width or
                start_uv[1] < -image_height or start_uv[1] > 2 * image_height):
            continue
        cv2.line(
            image,
            (int(round(start_uv[0])), int(round(start_uv[1]))),
            (int(round(end_uv[0])), int(round(end_uv[1]))),
            color,
            thickness,
            lineType=cv2.LINE_AA)


def draw_fisheye_box_on_image(
        image: np.ndarray,
        projected_edges: Sequence[np.ndarray],
        color: tuple[int, int, int],
        thickness: int = 2) -> None:
    """Draw curved 3D box edges after fisheye projection."""
    for projected_edge in projected_edges:
        finite = np.isfinite(projected_edge).all(axis=1)
        if np.count_nonzero(finite) < 2:
            continue
        curve = projected_edge[finite].astype(np.int32).reshape((-1, 1, 2))
        cv2.polylines(
            image, [curve], isClosed=False, color=color, thickness=thickness,
            lineType=cv2.LINE_AA)


def color_to_bgr(color: tuple[float, float, float]) -> tuple[int, int, int]:
    """Convert matplotlib RGB color to OpenCV BGR."""
    return (
        int(color[2] * 255),
        int(color[1] * 255),
        int(color[0] * 255),
    )


def exclusion_region_corners(
        exclusion_region: tuple[float, float, float, float]) -> np.ndarray:
    """Return rectangle corners in the pre-augmentation LiDAR frame."""
    x_min, x_max, y_min, y_max = exclusion_region
    return np.array([
        [x_min, y_min, 0.0],
        [x_max, y_min, 0.0],
        [x_max, y_max, 0.0],
        [x_min, y_max, 0.0],
        [x_min, y_min, 0.0],
    ], dtype=np.float64)


def transform_exclusion_corners(corners: np.ndarray, data_sample) -> np.ndarray:
    """Apply the same point-cloud augmentation used in the train pipeline."""
    transformed = corners.copy()
    if hasattr(data_sample, 'pcd_rotation'):
        rotation = _to_numpy(data_sample.pcd_rotation)
        transformed = transformed @ rotation
    if hasattr(data_sample, 'pcd_scale_factor'):
        transformed = transformed * float(_to_numpy(data_sample.pcd_scale_factor))
    if hasattr(data_sample, 'pcd_trans'):
        transformed = transformed + _to_numpy(data_sample.pcd_trans)
    if hasattr(data_sample, 'lidar_aug_matrix'):
        aug_matrix = _to_numpy(data_sample.lidar_aug_matrix)
        homogeneous = np.concatenate(
            [transformed, np.ones((transformed.shape[0], 1), dtype=np.float64)],
            axis=1)
        transformed = (aug_matrix @ homogeneous.T).T[:, :3]
    return transformed


def draw_vehicle_region_orthographic(
        axis: Axes,
        corners: np.ndarray,
        axis_x: int,
        axis_y: int) -> None:
    """Draw the ego exclusion polygon on one orthographic plane."""
    axis.fill(
        corners[:, axis_x],
        corners[:, axis_y],
        facecolor='red',
        edgecolor='red',
        alpha=0.15,
        linewidth=1.0,
        label='ego blind zone')
    axis.plot(
        corners[:, axis_x],
        corners[:, axis_y],
        color='red',
        linewidth=1.0)


def draw_vehicle_region(axis: Axes, corners_xy: np.ndarray) -> None:
    """Draw the ego vehicle exclusion polygon in the augmented BEV frame."""
    draw_vehicle_region_orthographic(axis, corners_xy, axis_x=0, axis_y=1)


def resolve_camera_image_path(data_root: Path, channel: str,
                              img_path: str) -> Path:
    """Resolve one camera image path from dataset info."""
    return data_root / 'samples' / channel / img_path


def load_camera_image(image_path: Path) -> np.ndarray:
    """Load one camera image as RGB."""
    image_bgr = cv2.imread(str(image_path))
    if image_bgr is None:
        raise FileNotFoundError(f'Failed to read image: {image_path}')
    return cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)


def draw_boxes_on_camera(
        image: np.ndarray,
        box_corners: np.ndarray,
        labels: Sequence[int],
        class_names: Sequence[str],
        calibrated_sensor: dict) -> None:
    """Project original-frame 3D boxes to one camera image."""
    camera_model = str(calibrated_sensor.get('camera_model', 'pinhole')).lower()
    for corners, label_idx in zip(box_corners, labels):
        class_name = class_names[label_idx]
        color_bgr = color_to_bgr(CLASS_COLORS.get(class_name, (0.8, 0.8, 0.8)))
        if camera_model == 'fisheye':
            projected_edges = [
                project_lidar_points_to_image(edge, calibrated_sensor)
                for edge in interpolate_box_edges(corners.T, segments=16)
            ]
            draw_fisheye_box_on_image(image, projected_edges, color_bgr)
        else:
            projected = project_lidar_points_to_image(corners, calibrated_sensor)
            draw_box_on_image(image, projected, color_bgr)


def draw_points_on_camera(
        image: np.ndarray,
        points: np.ndarray,
        calibrated_sensor: dict,
        max_points: int,
        rng: np.random.Generator) -> None:
    """Overlay a sparse LiDAR projection on one camera image."""
    visible_points = downsample_points(points, max_points, rng)
    projected = project_lidar_points_to_image(
        visible_points[:, :3], calibrated_sensor)
    image_height, image_width = image.shape[:2]
    for uv in projected:
        if not np.isfinite(uv).all():
            continue
        u, v = int(round(uv[0])), int(round(uv[1]))
        if 0 <= u < image_width and 0 <= v < image_height:
            image[v, u] = (0, 255, 255)


POINT_CLOUD_VIEWS: tuple[dict[str, object], ...] = (
    {
        'title': 'BEV (X-Y)',
        'axis_x': 0,
        'axis_y': 1,
        'xlabel': 'X (m)',
        'ylabel': 'Y (m)',
        'heading_corners': (4, 7),
        'range_keys': ('x_min', 'x_max', 'y_min', 'y_max'),
    },
    {
        'title': 'Front (X-Z)',
        'axis_x': 0,
        'axis_y': 2,
        'xlabel': 'X (m)',
        'ylabel': 'Z (m)',
        'heading_corners': (4, 5),
        'range_keys': ('x_min', 'x_max', 'z_min', 'z_max'),
    },
    {
        'title': 'Side (Y-Z)',
        'axis_x': 1,
        'axis_y': 2,
        'xlabel': 'Y (m)',
        'ylabel': 'Z (m)',
        'heading_corners': (4, 5),
        'range_keys': ('y_min', 'y_max', 'z_min', 'z_max'),
    },
)


def build_point_cloud_ranges(
        bev_range: tuple[float, float, float, float],
        z_range: tuple[float, float]) -> dict[str, float]:
    """Return axis limits for all orthographic LiDAR views."""
    x_min, x_max, y_min, y_max = bev_range
    z_min, z_max = z_range
    return {
        'x_min': x_min,
        'x_max': x_max,
        'y_min': y_min,
        'y_max': y_max,
        'z_min': z_min,
        'z_max': z_max,
    }


def render_pointcloud_panel(
        axis: Axes,
        points: np.ndarray,
        boxes: LiDARInstance3DBoxes,
        labels: torch.Tensor,
        class_names: Sequence[str],
        view_cfg: dict[str, object],
        point_ranges: dict[str, float],
        max_points: int,
        seed: int,
        exclusion_region: tuple[float, float, float, float] | None,
        data_sample,
        sample_idx: int,
        show_legend: bool = False) -> None:
    """Draw one orthographic LiDAR view with points and 3D boxes."""
    axis_x = int(view_cfg['axis_x'])
    axis_y = int(view_cfg['axis_y'])
    range_keys = view_cfg['range_keys']
    axis_min = point_ranges[range_keys[0]]
    axis_max = point_ranges[range_keys[1]]
    cross_min = point_ranges[range_keys[2]]
    cross_max = point_ranges[range_keys[3]]

    rng = np.random.default_rng(seed)
    visible_points = downsample_points(points, max_points, rng)
    mask = (
        (visible_points[:, axis_x] >= axis_min) &
        (visible_points[:, axis_x] <= axis_max) &
        (visible_points[:, axis_y] >= cross_min) &
        (visible_points[:, axis_y] <= cross_max))
    visible_points = visible_points[mask]

    axis.scatter(
        visible_points[:, axis_x],
        visible_points[:, axis_y],
        c=visible_points[:, 4],
        cmap='viridis',
        s=0.2,
        alpha=0.7,
        vmin=0)
    if exclusion_region is not None and view_cfg['title'] == 'BEV (X-Y)':
        region_corners = transform_exclusion_corners(
            exclusion_region_corners(exclusion_region), data_sample)
        draw_vehicle_region_orthographic(
            axis, region_corners, axis_x=axis_x, axis_y=axis_y)

    used_labels: set[str] = set()
    heading_corners = view_cfg.get('heading_corners')
    if len(boxes) > 0:
        corners = boxes.corners.cpu().numpy()
        for box_corners, label_idx in zip(corners, labels.tolist()):
            class_name = class_names[label_idx]
            color = CLASS_COLORS.get(class_name, (0.8, 0.8, 0.8))
            legend_label = class_name if class_name not in used_labels else None
            if legend_label is not None:
                used_labels.add(class_name)
            draw_box_orthographic(
                axis,
                box_corners,
                axis_x=axis_x,
                axis_y=axis_y,
                color=color,
                label=legend_label,
                heading_corners=heading_corners)

    axis.set_xlim(axis_min, axis_max)
    axis.set_ylim(cross_min, cross_max)
    axis.set_aspect('equal', adjustable='box')
    axis.set_xlabel(str(view_cfg['xlabel']))
    axis.set_ylabel(str(view_cfg['ylabel']))
    axis.grid(True, linestyle='--', alpha=0.3)
    axis.set_title(
        f"{view_cfg['title']} | sample {sample_idx} | "
        f'{len(points):,} pts, {len(boxes)} boxes',
        fontsize=9)
    if show_legend and (used_labels or exclusion_region is not None):
        axis.legend(loc='upper right', fontsize=7)


def render_pointcloud_views(
        axes: Sequence[Axes],
        points: np.ndarray,
        boxes: LiDARInstance3DBoxes,
        labels: torch.Tensor,
        class_names: Sequence[str],
        bev_range: tuple[float, float, float, float],
        z_range: tuple[float, float],
        max_points: int,
        seed: int,
        exclusion_region: tuple[float, float, float, float] | None,
        data_sample,
        sample_idx: int,
        show_legend: bool = False) -> None:
    """Render BEV, front, and side LiDAR views."""
    point_ranges = build_point_cloud_ranges(bev_range, z_range)
    for axis, view_cfg in zip(axes, POINT_CLOUD_VIEWS):
        render_pointcloud_panel(
            axis=axis,
            points=points,
            boxes=boxes,
            labels=labels,
            class_names=class_names,
            view_cfg=view_cfg,
            point_ranges=point_ranges,
            max_points=max_points,
            seed=seed,
            exclusion_region=exclusion_region,
            data_sample=data_sample,
            sample_idx=sample_idx,
            show_legend=show_legend and view_cfg['title'] == 'BEV (X-Y)')


def render_bev_panel(
        axis: Axes,
        points: np.ndarray,
        boxes: LiDARInstance3DBoxes,
        labels: torch.Tensor,
        class_names: Sequence[str],
        bev_range: tuple[float, float, float, float],
        z_range: tuple[float, float],
        max_points: int,
        seed: int,
        exclusion_region: tuple[float, float, float, float] | None,
        data_sample,
        sample_idx: int,
        show_legend: bool = True) -> None:
    """Draw only the BEV panel."""
    render_pointcloud_panel(
        axis=axis,
        points=points,
        boxes=boxes,
        labels=labels,
        class_names=class_names,
        view_cfg=POINT_CLOUD_VIEWS[0],
        point_ranges=build_point_cloud_ranges(bev_range, z_range),
        max_points=max_points,
        seed=seed,
        exclusion_region=exclusion_region,
        data_sample=data_sample,
        sample_idx=sample_idx,
        show_legend=show_legend)


def render_camera_panel(
        axis: Axes,
        image_rgb: np.ndarray,
        channel: str,
        label: str) -> None:
    """Draw one camera image on a matplotlib axis."""
    axis.imshow(image_rgb)
    axis.set_title(f'{label} ({channel})', fontsize=9)
    axis.axis('off')


def render_train_input(
        points: np.ndarray,
        boxes: LiDARInstance3DBoxes,
        labels: torch.Tensor,
        camera_points: np.ndarray,
        camera_boxes: LiDARInstance3DBoxes,
        camera_labels: torch.Tensor,
        class_names: Sequence[str],
        sample_idx: int,
        output_path: Path,
        bev_range: tuple[float, float, float, float],
        z_range: tuple[float, float],
        max_points: int,
        seed: int,
        exclusion_region: tuple[float, float, float, float] | None,
        data_sample,
        mode: str,
        data_info: dict,
        data_root: Path,
        calibration_lookup: NuScenesCalibrationLookup | None) -> None:
    """Save BEV and/or multi-camera images for one training sample."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if mode == 'bev':
        figure, axes = plt.subplots(1, 3, figsize=(18, 6), layout='constrained')
        render_pointcloud_views(
            axes=axes,
            points=points,
            boxes=boxes,
            labels=labels,
            class_names=class_names,
            bev_range=bev_range,
            z_range=z_range,
            max_points=max_points,
            seed=seed,
            exclusion_region=exclusion_region,
            data_sample=data_sample,
            sample_idx=sample_idx,
            show_legend=True)
        figure.suptitle(
            f'Train input LiDAR views (augmented) | sample {sample_idx}',
            fontsize=14)
        figure.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close(figure)
        return

    if calibration_lookup is None:
        raise ValueError('calibration_lookup is required for camera/all modes.')

    camera_images: dict[str, np.ndarray] = {}
    camera_box_corners = (
        camera_boxes.corners.cpu().numpy() if len(camera_boxes) > 0 else
        np.empty((0, 8, 3)))
    camera_label_list = camera_labels.tolist()
    rng = np.random.default_rng(seed)

    for channel, label in zip(CAMERA_CHANNELS, CAMERA_LABELS):
        image_info = data_info['images'][channel]
        image_path = resolve_camera_image_path(
            data_root, channel, image_info['img_path'])
        image_rgb = load_camera_image(image_path).copy()
        calibrated_sensor = calibration_lookup.get(
            image_info['sample_data_token'])
        if len(camera_box_corners) > 0:
            draw_boxes_on_camera(
                image_rgb,
                camera_box_corners,
                camera_label_list,
                class_names,
                calibrated_sensor)
        draw_points_on_camera(
            image_rgb,
            camera_points,
            calibrated_sensor,
            max_points=min(max_points // 8, 20000),
            rng=rng)
        camera_images[channel] = image_rgb

    if mode == 'camera':
        figure, axes = plt.subplots(2, 2, figsize=(14, 8), layout='constrained')
        for axis, channel, label in zip(
                axes.flatten(), CAMERA_CHANNELS, CAMERA_LABELS):
            render_camera_panel(axis, camera_images[channel], channel, label)
        figure.suptitle(
            f'Train input cameras (sensor frame) | sample {sample_idx} | '
            f'{len(camera_points):,} points, {len(camera_boxes)} boxes',
            fontsize=14)
        figure.savefig(output_path, dpi=150, bbox_inches='tight')
        plt.close(figure)
        return

    figure = plt.figure(figsize=(20, 12), layout='constrained')
    grid = figure.add_gridspec(3, 3, width_ratios=[1.0, 1.0, 1.15])
    camera_axes = [
        figure.add_subplot(grid[0, 0]),
        figure.add_subplot(grid[0, 1]),
        figure.add_subplot(grid[1, 0]),
        figure.add_subplot(grid[1, 1]),
    ]
    pointcloud_axes = [
        figure.add_subplot(grid[0, 2]),
        figure.add_subplot(grid[1, 2]),
        figure.add_subplot(grid[2, 2]),
    ]
    for axis, channel, label in zip(camera_axes, CAMERA_CHANNELS, CAMERA_LABELS):
        render_camera_panel(axis, camera_images[channel], channel, label)
    render_pointcloud_views(
        axes=pointcloud_axes,
        points=points,
        boxes=boxes,
        labels=labels,
        class_names=class_names,
        bev_range=bev_range,
        z_range=z_range,
        max_points=max_points,
        seed=seed,
        exclusion_region=exclusion_region,
        data_sample=data_sample,
        sample_idx=sample_idx,
        show_legend=True)
    figure.suptitle(
        f'Train input | sample {sample_idx} | '
        f'cameras: sensor frame, LiDAR views: augmented | '
        f'{len(points):,} points, {len(boxes)} boxes',
        fontsize=14)
    figure.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close(figure)


def main() -> None:
    """Render randomly selected training inputs."""
    args = parse_args()
    dataset, cfg = build_dataset(args.config)
    class_names = cfg.metainfo['classes']
    data_root = args.data_root
    if not data_root.is_absolute():
        data_root = Path.cwd() / data_root

    calibration_lookup = None
    pre_aug_compose = None
    if args.mode in ('camera', 'all'):
        calibration_lookup = NuScenesCalibrationLookup(
            data_root, args.metadata_version)
        pre_aug_compose = build_pre_augmentation_compose(cfg)

    exclusion_region = None
    if args.car_config.is_file():
        exclusion_region = compute_vehicle_exclusion_region(
            load_car_info(args.car_config),
            blind_zone_front=args.blind_zone_front,
            blind_zone_rear=args.blind_zone_rear)

    rng = np.random.default_rng(args.seed)
    indices = rng.choice(len(dataset), size=args.num_samples, replace=False)
    for plot_idx, dataset_idx in enumerate(indices):
        item = dataset[int(dataset_idx)]
        points = item['inputs']['points'].numpy()
        instances = item['data_samples'].gt_instances_3d
        boxes = instances.bboxes_3d
        labels = instances.labels_3d
        sample_idx = int(item['data_samples'].sample_idx)
        data_info = dataset.get_data_info(int(dataset_idx))
        camera_points = points
        camera_boxes = boxes
        camera_labels = labels
        if pre_aug_compose is not None:
            camera_points, camera_boxes, camera_labels = load_camera_frame_data(
                dataset, int(dataset_idx), pre_aug_compose)
        output_path = (
            args.output_dir /
            f'train_input_{plot_idx:02d}_idx{dataset_idx:03d}_sample{sample_idx:05d}.png')
        render_train_input(
            points=points,
            boxes=boxes,
            labels=labels,
            camera_points=camera_points,
            camera_boxes=camera_boxes,
            camera_labels=camera_labels,
            class_names=class_names,
            sample_idx=sample_idx,
            output_path=output_path,
            bev_range=tuple(args.bev_range),
            z_range=tuple(args.z_range),
            max_points=args.max_points,
            seed=args.seed + plot_idx,
            exclusion_region=exclusion_region,
            data_sample=item['data_samples'],
            mode=args.mode,
            data_info=data_info,
            data_root=data_root,
            calibration_lookup=calibration_lookup)
        print(
            f'Saved: {output_path} '
            f'({len(points):,} points, {len(boxes)} boxes, mode={args.mode})')


if __name__ == '__main__':
    main()
