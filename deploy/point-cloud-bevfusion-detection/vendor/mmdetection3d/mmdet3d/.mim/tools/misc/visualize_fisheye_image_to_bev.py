#!/usr/bin/env python3
"""Project fisheye camera images onto a fixed LiDAR ground plane."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

import cv2
import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import mmengine
import numpy as np
import torch
from mmengine.config import Config

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPOSITORY_ROOT = _SCRIPT_DIR.parents[1]
for module_path in (_SCRIPT_DIR, _REPOSITORY_ROOT):
    if str(module_path) not in sys.path:
        sys.path.insert(0, str(module_path))

from projects.BEVFusion.bevfusion.camera_geometry import (  # noqa: E402
    project_camera_points,
)
from visualize_nuscense import (  # noqa: E402
    get_lidar_to_camera_matrix,
    transform_points_matrix,
)
from visualize_train_input import NuScenesCalibrationLookup  # noqa: E402


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Project fisheye images onto a LiDAR ground plane.')
    parser.add_argument(
        '--config',
        type=Path,
        default=Path(
            'projects/BEVFusion/configs/'
            'bevfusion_lidar-cam_voxel0075_custom-nus-3class.py'))
    parser.add_argument(
        '--data-root', type=Path, default=Path('data/nuscenes'))
    parser.add_argument(
        '--metadata-version', type=str, default='v1.0-trainval')
    parser.add_argument('--sample-index', type=int, default=0)
    parser.add_argument('--ground-height', type=float, default=-0.325)
    parser.add_argument(
        '--bev-range',
        type=float,
        nargs=4,
        default=[-21.0, 21.0, -21.0, 21.0],
        metavar=('XMIN', 'XMAX', 'YMIN', 'YMAX'))
    parser.add_argument('--bev-resolution', type=float, default=0.05)
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('outputs/vis/fisheye-image-bev'))
    return parser.parse_args()


def calibration_tensors(
        calibration: dict) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor,
                                    torch.Tensor]:
    """Convert one config calibration to batched Torch tensors."""
    intrinsics = torch.tensor(
        calibration['camera_intrinsic'],
        dtype=torch.float32).reshape(1, 1, 3, 3)
    distortion = torch.tensor(
        calibration['distortion'],
        dtype=torch.float32).reshape(1, 1, 4)
    fisheye_mask = torch.tensor([[calibration['camera_model'] == 'fisheye']])
    axis_signs = torch.tensor(
        calibration['axis_signs'],
        dtype=torch.float32).reshape(1, 1, 3)
    return intrinsics, distortion, fisheye_mask, axis_signs


def build_ground_grid(
        bev_range: Sequence[float],
        resolution: float,
        ground_height: float) -> tuple[np.ndarray, tuple[int, int]]:
    """Build a BEV grid with forward (+X) at the image top."""
    if resolution <= 0:
        raise ValueError(f'bev-resolution must be positive, got {resolution}')
    x_min, x_max, y_min, y_max = bev_range
    height = int(round((x_max - x_min) / resolution))
    width = int(round((y_max - y_min) / resolution))
    if height <= 0 or width <= 0:
        raise ValueError(
            f'Invalid bev-range={list(bev_range)} for resolution={resolution}')
    x_values = x_max - (np.arange(height) + 0.5) * resolution
    y_values = y_max - (np.arange(width) + 0.5) * resolution
    grid_x, grid_y = np.meshgrid(x_values, y_values, indexing='ij')
    ground_points = np.stack(
        (grid_x, grid_y, np.full_like(grid_x, ground_height)), axis=-1)
    return ground_points.reshape(-1, 3), (height, width)


def resolve_image_path(
        data_root: Path,
        channel: str,
        image_path: str) -> Path:
    """Resolve an image path stored either as a filename or relative path."""
    configured_path = Path(image_path)
    candidates = [
        configured_path,
        data_root / configured_path,
        data_root / 'samples' / channel / configured_path.name,
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(
        f'Camera image not found: channel={channel}, image_path={image_path}, '
        f'candidates={[str(candidate) for candidate in candidates]}')


def project_image_to_ground_bev(
        image_rgb: np.ndarray,
        ground_points: np.ndarray,
        bev_shape: tuple[int, int],
        lidar_to_camera: np.ndarray,
        calibration: dict) -> tuple[np.ndarray, np.ndarray]:
    """Inverse-map a fisheye image onto the fixed LiDAR ground grid."""
    camera_points = transform_points_matrix(
        ground_points, lidar_to_camera).astype(np.float32)
    pixels, _, valid = project_camera_points(
        torch.from_numpy(camera_points).reshape(1, 1, -1, 3),
        *calibration_tensors(calibration))
    pixels_numpy = pixels[0, 0].numpy()
    valid_numpy = valid[0, 0].numpy()
    image_height, image_width = image_rgb.shape[:2]
    valid_numpy &= (
        (pixels_numpy[:, 0] >= 0) &
        (pixels_numpy[:, 0] < image_width - 1) &
        (pixels_numpy[:, 1] >= 0) &
        (pixels_numpy[:, 1] < image_height - 1))

    map_x = pixels_numpy[:, 0].reshape(bev_shape).astype(np.float32)
    map_y = pixels_numpy[:, 1].reshape(bev_shape).astype(np.float32)
    valid_map = valid_numpy.reshape(bev_shape)
    map_x[~valid_map] = -1
    map_y[~valid_map] = -1
    bev_image = cv2.remap(
        image_rgb,
        map_x,
        map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0)

    border_distance = np.minimum.reduce([
        pixels_numpy[:, 0],
        image_width - 1 - pixels_numpy[:, 0],
        pixels_numpy[:, 1],
        image_height - 1 - pixels_numpy[:, 1],
    ])
    weights = np.clip(border_distance / 80.0, 0.0, 1.0)
    weights[~valid_numpy] = 0.0
    return bev_image, weights.reshape(bev_shape)


def render_bev_axis(
        axis,
        bev_image: np.ndarray,
        bev_range: Sequence[float],
        title: str) -> None:
    """Render a BEV image with LiDAR coordinates and direction labels."""
    x_min, x_max, y_min, y_max = bev_range
    axis.imshow(
        bev_image,
        extent=[y_max, y_min, x_min, x_max],
        origin='upper')
    axis.scatter([0.0], [0.0], marker='x', c='white', s=45)
    axis.annotate(
        '+X forward',
        xy=(0.0, x_max * 0.9),
        xytext=(0.0, x_max * 0.55),
        color='white',
        ha='center',
        arrowprops=dict(arrowstyle='->', color='white'))
    axis.set_xlabel('Y (m), left is positive')
    axis.set_ylabel('X (m), forward is positive')
    axis.set_title(title)


def save_camera_overview(
        source_images: Sequence[np.ndarray],
        bev_images: Sequence[np.ndarray],
        channels: Sequence[str],
        bev_range: Sequence[float],
        output_path: Path) -> None:
    """Save source images and their ground-plane BEV projections."""
    figure, axes = plt.subplots(
        2, len(channels), figsize=(20, 9), layout='constrained')
    for index, channel in enumerate(channels):
        axes[0, index].imshow(source_images[index])
        axes[0, index].set_title(f'{channel}: fisheye source')
        axes[0, index].axis('off')
        render_bev_axis(
            axes[1, index], bev_images[index], bev_range,
            f'{channel}: projected ground BEV')
    figure.suptitle(
        'Fisheye images projected to the fixed LiDAR ground plane',
        fontsize=16,
        fontweight='bold')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close(figure)


def main() -> None:
    """Generate per-camera and fused image-to-ground BEV projections."""
    args = parse_args()
    cfg = Config.fromfile(str(args.config))
    calibration_configs = cfg.model.view_transform.get('camera_calibrations')
    calibrations = [
        dict(calibration) for calibration in calibration_configs
    ] if calibration_configs else []
    if not calibrations:
        raise ValueError(
            f'No camera_calibrations found in config: {args.config}')

    training_dataset_config = cfg.train_dataloader.dataset
    while training_dataset_config.get('dataset') is not None:
        training_dataset_config = training_dataset_config.dataset
    annotation_path = (
        args.data_root / training_dataset_config.ann_file)
    annotation = mmengine.load(annotation_path)
    data_list = annotation['data_list']
    if args.sample_index < 0 or args.sample_index >= len(data_list):
        raise IndexError(
            f'sample-index={args.sample_index} is outside data length '
            f'{len(data_list)}')
    sample_info = data_list[args.sample_index]
    lookup = NuScenesCalibrationLookup(
        args.data_root.resolve(), args.metadata_version)
    ground_points, bev_shape = build_ground_grid(
        args.bev_range, args.bev_resolution, args.ground_height)

    channels = []
    source_images = []
    bev_images = []
    blend_sum = np.zeros((*bev_shape, 3), dtype=np.float64)
    blend_weight = np.zeros(bev_shape, dtype=np.float64)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for calibration in calibrations:
        channel = str(calibration['camera_name'])
        image_info = sample_info['images'][channel]
        image_path = resolve_image_path(
            args.data_root, channel, image_info['img_path'])
        image_bgr = cv2.imread(str(image_path))
        if image_bgr is None:
            raise FileNotFoundError(
                f'Failed to read camera image: {image_path}')
        image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        calibrated_sensor = lookup.get(image_info['sample_data_token'])
        bev_image, weights = project_image_to_ground_bev(
            image_rgb=image_rgb,
            ground_points=ground_points,
            bev_shape=bev_shape,
            lidar_to_camera=get_lidar_to_camera_matrix(calibrated_sensor),
            calibration=calibration)
        channels.append(channel)
        source_images.append(image_rgb)
        bev_images.append(bev_image)
        blend_sum += bev_image.astype(np.float64) * weights[..., None]
        blend_weight += weights
        camera_output = (
            args.output_dir /
            f'sample_{args.sample_index:05d}_{channel.lower()}_ground_bev.png')
        cv2.imwrite(
            str(camera_output), cv2.cvtColor(bev_image, cv2.COLOR_RGB2BGR))

    fused_bev = (
        blend_sum / np.maximum(blend_weight[..., None], 1e-6)).clip(
            0, 255).astype(np.uint8)
    fused_path = (
        args.output_dir /
        f'sample_{args.sample_index:05d}_fused_ground_bev.png')
    cv2.imwrite(
        str(fused_path), cv2.cvtColor(fused_bev, cv2.COLOR_RGB2BGR))
    overview_path = (
        args.output_dir /
        f'sample_{args.sample_index:05d}_image_to_ground_bev.png')
    save_camera_overview(
        source_images, bev_images, channels, args.bev_range, overview_path)
    print(f'Saved camera overview: {overview_path}')
    print(f'Saved fused ground BEV: {fused_path}')
    print(
        f'Ground assumption: z={args.ground_height:.3f}m, '
        f'BEV shape={bev_shape}, resolution={args.bev_resolution:.3f}m')


if __name__ == '__main__':
    main()
