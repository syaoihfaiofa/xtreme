#!/usr/bin/env python3
"""Visualize nuScenes-format data exported by Xtreme1.

Uses the official nuscenes-devkit API for metadata lookup.
Camera projection follows Xtreme1 pc-tool conventions:
- cameraExternal reconstructed from calibrated_sensor
- Y/Z axis flip before projection
- equidistant fisheye distortion (k1-k4)
- 3D boxes interpreted in per-frame lidar/ego coordinates

ASCII PCD point clouds are loaded with a custom parser because devkit only
supports binary LiDAR files.
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Set, Tuple

import cv2
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.axes import Axes
from matplotlib.figure import Figure
from nuscenes.nuscenes import NuScenes

# Display order for 2x2 grid:
# [Front] [Right]
# [Back ] [Left ]
CAMERA_CHANNELS: Tuple[str, ...] = (
    'CAM_FRONT',
    'CAM_RIGHT',
    'CAM_BACK',
    'CAM_LEFT',
)

CAMERA_LABELS: Tuple[str, ...] = (
    'Front',
    'Right',
    'Back',
    'Left',
)

LEGACY_CAMERA_CHANNELS: Dict[str, str] = {
    'CAM_RIGHT': 'CAM_BACK',
    'CAM_BACK': 'CAM_BACK_RIGHT',
    'CAM_LEFT': 'CAM_FRONT_RIGHT',
}

CATEGORY_COLORS: Dict[str, Tuple[float, float, float]] = {
    'Car': (0.0, 0.6, 1.0),
    'Cone': (1.0, 0.5, 0.0),
    'Person': (1.0, 0.2, 0.2),
    'Pillar': (0.6, 0.2, 0.8),
    'No Parking Board': (0.2, 0.8, 0.2),
    'Parking Lock (Locked)': (0.9, 0.9, 0.2),
    'Parking Lock (Unlocked)': (0.5, 0.5, 0.5),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Visualize nuScenes-format data under data/nuscense')
    parser.add_argument(
        '--data-root',
        type=str,
        default='data/nuscense',
        help='Dataset root containing version folder and samples/')
    parser.add_argument(
        '--version',
        type=str,
        default='v1.0-trainval',
        choices=['v1.0-trainval', 'v1.0-test'],
        help='Metadata version folder name')
    parser.add_argument(
        '--mode',
        type=str,
        default='all',
        choices=['bev', 'camera', 'all'],
        help='Visualization mode')
    parser.add_argument(
        '--sample-index',
        type=int,
        default=0,
        help='Sample index in sample.json')
    parser.add_argument(
        '--sample-token',
        type=str,
        default=None,
        help='Sample token; overrides --sample-index when set')
    parser.add_argument(
        '--scene-index',
        type=int,
        default=None,
        help='Use first sample of the selected scene')
    parser.add_argument(
        '--num-samples',
        type=int,
        default=1,
        help='Number of consecutive samples to visualize')
    parser.add_argument(
        '--output-dir',
        type=str,
        default=None,
        help='Directory to save rendered images')
    parser.add_argument(
        '--show',
        action='store_true',
        help='Show figures interactively')
    parser.add_argument(
        '--max-points',
        type=int,
        default=80000,
        help='Maximum number of point-cloud points to draw')
    parser.add_argument(
        '--bev-range',
        type=float,
        nargs=4,
        default=[-40.0, 40.0, -40.0, 40.0],
        metavar=('XMIN', 'XMAX', 'YMIN', 'YMAX'),
        help='Bird-eye view range in meters')
    parser.add_argument(
        '--dpi',
        type=int,
        default=150,
        help='DPI when saving figures')
    parser.add_argument(
        '--seed',
        type=int,
        default=0,
        help='Random seed for point-cloud downsampling')
    parser.add_argument(
        '--classes',
        type=str,
        nargs='+',
        default=None,
        help='Only display the listed annotation categories')
    return parser.parse_args()


def load_pcd_ascii(file_path: Path) -> np.ndarray:
    """Load ASCII PCD file with fields x y z intensity."""
    with file_path.open('r', encoding='utf-8') as file_obj:
        lines = file_obj.readlines()

    data_start = 0
    for index, line in enumerate(lines):
        if line.strip().startswith('DATA'):
            data_start = index + 1
            break

    points: List[List[float]] = []
    for line in lines[data_start:]:
        stripped = line.strip()
        if not stripped:
            continue
        values = stripped.split()
        if len(values) < 3:
            continue
        points.append([float(values[0]), float(values[1]), float(values[2])])
    if not points:
        raise ValueError(f'No points found in PCD file: {file_path}')
    return np.asarray(points, dtype=np.float64)


def downsample_points(points: np.ndarray, max_points: int, seed: int) -> np.ndarray:
    if points.shape[0] <= max_points:
        return points
    rng = random.Random(seed)
    indices = rng.sample(range(points.shape[0]), max_points)
    return points[indices]


def quaternion_to_matrix(quaternion: Sequence[float]) -> np.ndarray:
    """Convert quaternion [w, x, y, z] to a 3x3 rotation matrix."""
    w, x, y, z = quaternion
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float64)


def get_lidar_to_camera_matrix(calibrated_sensor: dict) -> np.ndarray:
    """Return the lidar/ego-to-camera transform from nuScenes calibration."""
    sensor_to_ego = np.eye(4, dtype=np.float64)
    sensor_to_ego[:3, :3] = quaternion_to_matrix(
        calibrated_sensor['rotation'])
    sensor_to_ego[:3, 3] = np.asarray(
        calibrated_sensor['translation'], dtype=np.float64)
    return np.linalg.inv(sensor_to_ego)


def transform_points_matrix(points: np.ndarray, transform: np.ndarray) -> np.ndarray:
    """Transform Nx3 points with a 4x4 homogeneous matrix."""
    homo = np.concatenate([points, np.ones((points.shape[0], 1), dtype=np.float64)], axis=1)
    transformed = (transform @ homo.T).T
    return transformed[:, :3]


def project_camera_to_fisheye_image(
        camera_points: np.ndarray,
        fx: float,
        fy: float,
        cx: float,
        cy: float,
        distortion: dict) -> np.ndarray:
    """Project camera-frame points using Xtreme1 equidistant fisheye model."""
    x = camera_points[:, 0]
    y = -camera_points[:, 1]
    z = -camera_points[:, 2]
    radius = np.hypot(x, y)
    theta = np.arctan2(radius, z)
    theta2 = theta * theta
    theta4 = theta2 * theta2
    theta6 = theta4 * theta2
    theta8 = theta4 * theta4
    k1 = float(distortion.get('k1', 0.0))
    k2 = float(distortion.get('k2', 0.0))
    k3 = float(distortion.get('k3', 0.0))
    k4 = float(distortion.get('k4', 0.0))
    theta_d = theta * (1 + k1 * theta2 + k2 * theta4 + k3 * theta6 + k4 * theta8)
    scale = np.ones_like(radius)
    valid = radius > 1e-6
    scale[valid] = theta_d[valid] / radius[valid]
    u = fx * x * scale + cx
    v = fy * y * scale + cy
    return np.stack([u, v], axis=1)


def project_camera_to_pinhole_image(
        camera_points: np.ndarray,
        fx: float,
        fy: float,
        cx: float,
        cy: float) -> np.ndarray:
    """Project camera-frame points with a pinhole model."""
    x = camera_points[:, 0]
    y = -camera_points[:, 1]
    z = -camera_points[:, 2]
    projected = np.full((camera_points.shape[0], 2), np.nan, dtype=np.float64)
    valid = z > 0.1
    if not np.any(valid):
        return projected
    projected[valid, 0] = fx * x[valid] / z[valid] + cx
    projected[valid, 1] = fy * y[valid] / z[valid] + cy
    return projected


def project_lidar_corners_to_image(
        corners_lidar: np.ndarray,
        calibrated_sensor: dict) -> np.ndarray:
    """Project 3x8 lidar-frame corners to 8x2 image coordinates."""
    return project_lidar_points_to_image(corners_lidar.T, calibrated_sensor)


def project_lidar_points_to_image(
        points_lidar: np.ndarray,
        calibrated_sensor: dict) -> np.ndarray:
    """Project Nx3 lidar-frame points to image coordinates."""
    lidar_to_camera = get_lidar_to_camera_matrix(calibrated_sensor)
    points_camera = transform_points_matrix(points_lidar, lidar_to_camera)

    intrinsic = np.asarray(calibrated_sensor['camera_intrinsic'], dtype=np.float64)
    fx = float(intrinsic[0, 0])
    fy = float(intrinsic[1, 1])
    cx = float(intrinsic[0, 2])
    cy = float(intrinsic[1, 2])
    camera_model = str(calibrated_sensor.get('camera_model', 'pinhole')).lower()
    if camera_model == 'fisheye':
        return project_camera_to_fisheye_image(
            points_camera, fx, fy, cx, cy, calibrated_sensor.get('distortion', {}))
    return project_camera_to_pinhole_image(points_camera, fx, fy, cx, cy)


BOX_EDGES: Tuple[Tuple[int, int], ...] = (
    (0, 1), (1, 2), (2, 3), (3, 0),
    (4, 5), (5, 6), (6, 7), (7, 4),
    (0, 4), (1, 5), (2, 6), (3, 7),
)


def interpolate_box_edges(
        corners: np.ndarray,
        segments: int) -> List[np.ndarray]:
    """Sample each 3D box edge, including both endpoints."""
    if segments < 1:
        raise ValueError(f'segments must be at least 1, got {segments}')
    edge_points: List[np.ndarray] = []
    for start_index, end_index in BOX_EDGES:
        edge_points.append(np.linspace(
            corners[:, start_index], corners[:, end_index], segments + 1))
    return edge_points


def get_category_color(category_name: str) -> Tuple[float, float, float]:
    if category_name in CATEGORY_COLORS:
        return CATEGORY_COLORS[category_name]
    rng = np.random.default_rng(abs(hash(category_name)) % (2**32))
    return tuple(rng.random(3).tolist())


def get_category_name(nusc: NuScenes, ann_token: str) -> str:
    annotation = nusc.get('sample_annotation', ann_token)
    instance = nusc.get('instance', annotation['instance_token'])
    category = nusc.get('category', instance['category_token'])
    return category['name']


def yaw_from_quaternion(quaternion: Sequence[float]) -> float:
    """Extract Z-yaw from quaternion [w, x, y, z]."""
    w, _, _, z = quaternion
    return 2.0 * np.arctan2(z, w)


def get_box_corners_xtreme1(annotation: dict) -> np.ndarray:
    """Return 3x8 box corners in Xtreme1 lidar/ego coordinates."""
    # nuScenes export stores size as [width(y), length(x), height(z)].
    width = float(annotation['size'][0])
    length = float(annotation['size'][1])
    height = float(annotation['size'][2])
    center = np.asarray(annotation['translation'], dtype=np.float64)
    yaw = yaw_from_quaternion(annotation['rotation'])

    half_length = length / 2.0
    half_width = width / 2.0
    half_height = height / 2.0
    local_corners = np.array([
        [half_length, -half_width, half_height],
        [half_length, -half_width, -half_height],
        [half_length, half_width, -half_height],
        [half_length, half_width, half_height],
        [-half_length, -half_width, half_height],
        [-half_length, -half_width, -half_height],
        [-half_length, half_width, -half_height],
        [-half_length, half_width, half_height],
    ], dtype=np.float64)

    cosine = np.cos(yaw)
    sine = np.sin(yaw)
    rotation = np.array([
        [cosine, -sine, 0.0],
        [sine, cosine, 0.0],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)
    world_corners = local_corners @ rotation.T + center
    return world_corners.T


def get_box_corners_lidar(nusc: NuScenes, ann_token: str) -> np.ndarray:
    """Return 3x8 box corners in ego/lidar coordinates."""
    annotation = nusc.get('sample_annotation', ann_token)
    return get_box_corners_xtreme1(annotation)


def get_lidar_path(nusc: NuScenes, sample: dict) -> Path:
    sample_data = nusc.get('sample_data', sample['data']['LIDAR_TOP'])
    return Path(nusc.dataroot) / sample_data['filename']


def resolve_camera_channel(sample: dict, channel: str) -> str:
    """Resolve physical camera names for current and legacy exports."""
    if channel in sample['data']:
        return channel
    legacy_channel = LEGACY_CAMERA_CHANNELS.get(channel)
    if legacy_channel is not None and legacy_channel in sample['data']:
        return legacy_channel
    raise KeyError(
        f'Camera channel {channel} is unavailable; '
        f'found {sorted(sample["data"].keys())}')


def load_camera_image(nusc: NuScenes, sample: dict, channel: str) -> np.ndarray:
    resolved_channel = resolve_camera_channel(sample, channel)
    sample_data = nusc.get('sample_data', sample['data'][resolved_channel])
    image_path = Path(nusc.dataroot) / sample_data['filename']
    image_bgr = cv2.imread(str(image_path))
    if image_bgr is None:
        raise FileNotFoundError(f'Failed to read image: {image_path}')
    return cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)


def get_calibrated_sensor(
        nusc: NuScenes,
        sample: dict,
        channel: str) -> dict:
    resolved_channel = resolve_camera_channel(sample, channel)
    sample_data = nusc.get('sample_data', sample['data'][resolved_channel])
    return nusc.get('calibrated_sensor', sample_data['calibrated_sensor_token'])


def has_camera_intrinsic(calibrated_sensor: dict) -> bool:
    intrinsic = calibrated_sensor.get('camera_intrinsic', [])
    return len(intrinsic) > 0


def draw_box_on_bev(
        ax: Axes,
        corners: np.ndarray,
        color: Tuple[float, float, float],
        label: Optional[str] = None) -> None:
    top_indices = [0, 1, 2, 3, 0]
    xs = corners[0, top_indices]
    ys = corners[1, top_indices]
    ax.plot(xs, ys, color=color, linewidth=1.5, label=label)
    heading_x = [corners[0, 0], corners[0, 1]]
    heading_y = [corners[1, 0], corners[1, 1]]
    ax.plot(heading_x, heading_y, color=color, linewidth=2.5)


def draw_box_on_image(
        image: np.ndarray,
        projected: np.ndarray,
        color: Tuple[int, int, int],
        thickness: int = 2) -> None:
    if projected.shape[0] < 8:
        return

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

    face_indices = [0, 1, 2, 3]
    face_points = projected[face_indices]
    if np.isfinite(face_points).all():
        overlay = image.copy()
        polygon = face_points.astype(np.int32).reshape((-1, 1, 2))
        cv2.fillPoly(overlay, [polygon], color)
        cv2.addWeighted(overlay, 0.15, image, 0.85, 0.0, image)


def draw_fisheye_box_on_image(
        image: np.ndarray,
        projected_edges: Sequence[np.ndarray],
        color: Tuple[int, int, int],
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


OCCLUDED_VISIBILITY_TOKEN = '1'


def is_annotation_visible(nusc: NuScenes, ann_token: str) -> bool:
    """Return False for Xtreme1-exported occluded annotations."""
    annotation = nusc.get('sample_annotation', ann_token)
    return annotation['visibility_token'] != OCCLUDED_VISIBILITY_TOKEN


def should_display_category(
        category_name: str,
        classes: Optional[Sequence[str]]) -> bool:
    """Return whether a category passes the optional include filter."""
    return classes is None or category_name in classes


def draw_sample_boxes_on_bev(
        nusc: NuScenes,
        ax: Axes,
        sample: dict,
        classes: Optional[Sequence[str]]) -> None:
    used_labels: set[str] = set()
    for ann_token in sample['anns']:
        if not is_annotation_visible(nusc, ann_token):
            continue
        category_name = get_category_name(nusc, ann_token)
        if not should_display_category(category_name, classes):
            continue
        color = get_category_color(category_name)
        corners = get_box_corners_lidar(nusc, ann_token)
        label = category_name if category_name not in used_labels else None
        if label is not None:
            used_labels.add(category_name)
        draw_box_on_bev(ax, corners, color=color, label=label)
    if used_labels:
        ax.legend(loc='upper right', fontsize=8)


def draw_sample_boxes_on_image(
        nusc: NuScenes,
        image: np.ndarray,
        sample: dict,
        channel: str,
        classes: Optional[Sequence[str]]) -> None:
    calibrated_sensor = get_calibrated_sensor(nusc, sample, channel)
    if not has_camera_intrinsic(calibrated_sensor):
        return

    for ann_token in sample['anns']:
        if not is_annotation_visible(nusc, ann_token):
            continue
        category_name = get_category_name(nusc, ann_token)
        if not should_display_category(category_name, classes):
            continue
        color_float = get_category_color(category_name)
        color_bgr = (
            int(color_float[2] * 255),
            int(color_float[1] * 255),
            int(color_float[0] * 255),
        )
        corners = get_box_corners_lidar(nusc, ann_token)
        camera_model = str(
            calibrated_sensor.get('camera_model', 'pinhole')).lower()
        if camera_model == 'fisheye':
            projected_edges = [
                project_lidar_points_to_image(edge, calibrated_sensor)
                for edge in interpolate_box_edges(corners, segments=16)
            ]
            draw_fisheye_box_on_image(
                image, projected_edges, color_bgr, thickness=2)
        else:
            projected = project_lidar_corners_to_image(
                corners, calibrated_sensor)
            draw_box_on_image(image, projected, color_bgr, thickness=2)


def render_bev(
        nusc: NuScenes,
        sample: dict,
        max_points: int,
        bev_range: Sequence[float],
        seed: int,
        classes: Optional[Sequence[str]]) -> Figure:
    fig, ax = plt.subplots(figsize=(8, 8))
    lidar_path = get_lidar_path(nusc, sample)
    points = downsample_points(load_pcd_ascii(lidar_path), max_points, seed)

    x_min, x_max, y_min, y_max = bev_range
    mask = (
        (points[:, 0] >= x_min) & (points[:, 0] <= x_max) &
        (points[:, 1] >= y_min) & (points[:, 1] <= y_max))
    points = points[mask]

    ax.scatter(points[:, 0], points[:, 1], s=0.2, c=points[:, 2], cmap='viridis', alpha=0.8)
    draw_sample_boxes_on_bev(nusc, ax, sample, classes)

    ax.set_xlim(x_min, x_max)
    ax.set_ylim(y_min, y_max)
    ax.set_aspect('equal', adjustable='box')
    ax.set_xlabel('X (m)')
    ax.set_ylabel('Y (m)')
    ax.set_title(f'BEV | sample {sample["token"][:8]}')
    ax.grid(True, linestyle='--', alpha=0.3)
    fig.tight_layout()
    return fig


def render_camera_grid(
        nusc: NuScenes,
        sample: dict,
        classes: Optional[Sequence[str]]) -> Figure:
    fig, axes = plt.subplots(2, 2, figsize=(14, 8))
    axes_list = axes.flatten()
    for axis, channel, label in zip(axes_list, CAMERA_CHANNELS, CAMERA_LABELS):
        image_rgb = load_camera_image(nusc, sample, channel)
        calibrated_sensor = get_calibrated_sensor(nusc, sample, channel)
        if has_camera_intrinsic(calibrated_sensor):
            draw_sample_boxes_on_image(
                nusc, image_rgb, sample, channel, classes)

        axis.imshow(image_rgb)
        axis.set_title(
            f'{label} ({channel})' if has_camera_intrinsic(calibrated_sensor)
            else f'{label} (no intrinsic)')
        axis.axis('off')

    fig.suptitle(f'Multi-camera view | sample {sample["token"][:8]}', fontsize=14)
    fig.tight_layout()
    return fig


def render_all(
        nusc: NuScenes,
        sample: dict,
        max_points: int,
        bev_range: Sequence[float],
        seed: int,
        classes: Optional[Sequence[str]]) -> Figure:
    fig = plt.figure(figsize=(16, 9))
    grid = fig.add_gridspec(2, 3, width_ratios=[1, 1, 1.2])

    camera_axes = [
        fig.add_subplot(grid[0, 0]),
        fig.add_subplot(grid[0, 1]),
        fig.add_subplot(grid[1, 0]),
        fig.add_subplot(grid[1, 1]),
    ]
    bev_ax = fig.add_subplot(grid[:, 2])

    for axis, channel, label in zip(camera_axes, CAMERA_CHANNELS, CAMERA_LABELS):
        image_rgb = load_camera_image(nusc, sample, channel)
        calibrated_sensor = get_calibrated_sensor(nusc, sample, channel)
        if has_camera_intrinsic(calibrated_sensor):
            draw_sample_boxes_on_image(
                nusc, image_rgb, sample, channel, classes)
        axis.imshow(image_rgb)
        axis.set_title(f'{label} ({channel})', fontsize=9)
        axis.axis('off')

    lidar_path = get_lidar_path(nusc, sample)
    points = downsample_points(load_pcd_ascii(lidar_path), max_points, seed)
    x_min, x_max, y_min, y_max = bev_range
    mask = (
        (points[:, 0] >= x_min) & (points[:, 0] <= x_max) &
        (points[:, 1] >= y_min) & (points[:, 1] <= y_max))
    points = points[mask]
    bev_ax.scatter(points[:, 0], points[:, 1], s=0.2, c=points[:, 2], cmap='viridis', alpha=0.8)
    draw_sample_boxes_on_bev(nusc, bev_ax, sample, classes)

    bev_ax.set_xlim(x_min, x_max)
    bev_ax.set_ylim(y_min, y_max)
    bev_ax.set_aspect('equal', adjustable='box')
    bev_ax.set_title('BEV')
    bev_ax.grid(True, linestyle='--', alpha=0.3)

    fig.suptitle(f'nuScense visualization | sample {sample["token"][:8]}', fontsize=14)
    fig.tight_layout()
    return fig


def save_or_show(
        figure: Figure,
        output_path: Optional[Path],
        show: bool,
        dpi: int) -> None:
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        figure.savefig(output_path, dpi=dpi, bbox_inches='tight')
        print(f'Saved: {output_path}')
    if show:
        plt.show()
    plt.close(figure)


def validate_metadata(data_root: Path, version: str) -> None:
    """Validate nuScenes metadata before initializing the devkit."""
    version_dir = data_root / version
    if not version_dir.is_dir():
        raise FileNotFoundError(
            f'Metadata version directory not found: {version_dir}')

    calibrated_sensor_path = version_dir / 'calibrated_sensor.json'
    sample_data_path = version_dir / 'sample_data.json'
    for path in (calibrated_sensor_path, sample_data_path):
        if not path.is_file():
            raise FileNotFoundError(f'Required metadata file not found: {path}')

    calibrated_sensor = json.loads(calibrated_sensor_path.read_text(encoding='utf-8'))
    sample_data = json.loads(sample_data_path.read_text(encoding='utf-8'))
    calibrated_tokens: Set[str] = {record['token'] for record in calibrated_sensor}
    referenced_tokens: Set[str] = {
        record['calibrated_sensor_token'] for record in sample_data
    }
    missing_tokens = sorted(referenced_tokens - calibrated_tokens)
    if missing_tokens:
        preview = ', '.join(token[:12] for token in missing_tokens[:3])
        raise ValueError(
            f'{version}/sample_data.json references {len(missing_tokens)} '
            f'calibrated_sensor token(s) missing from '
            f'{version}/calibrated_sensor.json, e.g. {preview}. '
            'Fix the token references or regenerate the metadata split.')


def find_sample_index(nusc: NuScenes, sample_token: str) -> int:
    for index, sample in enumerate(nusc.sample):
        if sample['token'] == sample_token:
            return index
    raise KeyError(f'Sample token not found: {sample_token}')


def resolve_start_sample(
        nusc: NuScenes,
        args: argparse.Namespace) -> Tuple[dict, int]:
    if args.sample_token is not None:
        sample = nusc.get('sample', args.sample_token)
        sample_index = find_sample_index(nusc, args.sample_token)
        return sample, sample_index
    if args.scene_index is not None:
        if args.scene_index < 0 or args.scene_index >= len(nusc.scene):
            raise IndexError(
                f'Scene index out of range: {args.scene_index} '
                f'(total {len(nusc.scene)})')
        scene = nusc.scene[args.scene_index]
        sample = nusc.get('sample', scene['first_sample_token'])
        sample_index = find_sample_index(nusc, sample['token'])
        return sample, sample_index
    if args.sample_index < 0 or args.sample_index >= len(nusc.sample):
        raise IndexError(
            f'Sample index out of range: {args.sample_index} '
            f'(total {len(nusc.sample)})')
    sample = nusc.sample[args.sample_index]
    return sample, args.sample_index


def main() -> None:
    args = parse_args()
    if not args.show and args.output_dir is None:
        raise ValueError('Specify --show and/or --output-dir')

    data_root = Path(args.data_root)
    if not data_root.is_absolute():
        data_root = Path.cwd() / data_root

    validate_metadata(data_root, args.version)
    nusc = NuScenes(version=args.version, dataroot=str(data_root), verbose=False)
    start_sample, start_index = resolve_start_sample(nusc, args)

    print(
        f'Dataset: {data_root} ({args.version}), '
        f'samples={len(nusc.sample)}, scenes={len(nusc.scene)}')
    print(f'Start sample index={start_index}, token={start_sample["token"]}')

    for offset in range(args.num_samples):
        sample_index = start_index + offset
        if sample_index >= len(nusc.sample):
            print(f'Stop at index {sample_index}: out of range')
            break
        sample = nusc.sample[sample_index]
        suffix = f'{sample_index:05d}_{sample["token"][:8]}'

        if args.mode in ('bev', 'all'):
            figure = (
                render_all(
                    nusc, sample, args.max_points, args.bev_range,
                    args.seed + offset, args.classes)
                if args.mode == 'all' else
                render_bev(
                    nusc, sample, args.max_points, args.bev_range,
                    args.seed + offset, args.classes))
            output_path = None
            if args.output_dir is not None:
                output_path = Path(args.output_dir) / f'{args.mode}_{suffix}.png'
            save_or_show(figure, output_path, args.show, args.dpi)
            continue

        figure = render_camera_grid(nusc, sample, args.classes)
        output_path = None
        if args.output_dir is not None:
            output_path = Path(args.output_dir) / f'camera_{suffix}.png'
        save_or_show(figure, output_path, args.show, args.dpi)


if __name__ == '__main__':
    main()
