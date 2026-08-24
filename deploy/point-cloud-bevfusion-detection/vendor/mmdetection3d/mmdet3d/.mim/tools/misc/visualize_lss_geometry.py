#!/usr/bin/env python3
"""Validate BEVFusion fisheye geometry on real camera and LiDAR data."""

from __future__ import annotations

import argparse
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
from matplotlib.backends.backend_agg import FigureCanvasAgg
from mmengine.config import Config
from mmengine.registry import init_default_scope
from PIL import Image

_SCRIPT_DIR = Path(__file__).resolve().parent
_REPOSITORY_ROOT = _SCRIPT_DIR.parents[1]
for module_path in (_SCRIPT_DIR, _REPOSITORY_ROOT):
    if str(module_path) not in sys.path:
        sys.path.insert(0, str(module_path))

from projects.BEVFusion.bevfusion.camera_geometry import (  # noqa: E402
    project_camera_points,
    unproject_image_points,
)
from visualize_nuscense import (  # noqa: E402
    get_lidar_to_camera_matrix,
    project_lidar_points_to_image,
    transform_points_matrix,
)
from visualize_train_input import (  # noqa: E402
    NuScenesCalibrationLookup,
    resolve_camera_image_path,
)
from mmdet3d.registry import DATASETS, MODELS  # noqa: E402


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Validate LSS fisheye projection and unprojection.')
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
    parser.add_argument('--max-points', type=int, default=30000)
    parser.add_argument(
        '--depths', type=float, nargs='+', default=[2.0, 5.0, 10.0, 20.0])
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('outputs/vis/lss-geometry'))
    parser.add_argument('--pixel-p99-threshold', type=float, default=0.05)
    parser.add_argument('--xyz-p99-threshold', type=float, default=0.001)
    parser.add_argument('--convergence-threshold', type=float, default=0.9999)
    parser.add_argument('--fail-on-threshold', action='store_true')
    return parser.parse_args()


def percentile_summary(values: np.ndarray) -> dict[str, float]:
    """Return stable error statistics for a one-dimensional array."""
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {'median': float('nan'), 'p95': float('nan'),
                'p99': float('nan'), 'max': float('nan')}
    return {
        'median': float(np.median(finite)),
        'p95': float(np.percentile(finite, 95)),
        'p99': float(np.percentile(finite, 99)),
        'max': float(np.max(finite)),
    }


def render_bev_frame(
        points: np.ndarray,
        colors: np.ndarray,
        title: str,
        bev_limit: float) -> Image.Image:
    """Render one BEV frame for the alternating validation GIF."""
    figure = plt.Figure(figsize=(7, 7), dpi=120)
    canvas = FigureCanvasAgg(figure)
    axis = figure.add_subplot(1, 1, 1)
    axis.scatter(points[:, 0], points[:, 1], c=colors, s=4, alpha=0.8)
    axis.scatter([0.0], [0.0], marker='x', c='black', s=80, label='LiDAR')
    axis.set_xlim(-bev_limit, bev_limit)
    axis.set_ylim(-bev_limit, bev_limit)
    axis.set_aspect('equal')
    axis.set_xlabel('X (m)')
    axis.set_ylabel('Y (m)')
    axis.grid(True, linestyle='--', alpha=0.3)
    axis.set_title(title, fontsize=14)
    axis.legend(loc='upper right')
    canvas.draw()
    rgba = np.asarray(canvas.buffer_rgba())
    return Image.fromarray(rgba[..., :3].copy())


def save_simple_bev_validation(
        image_rgb: np.ndarray,
        image_pixels: np.ndarray,
        original_lidar: np.ndarray,
        recovered_lidar: np.ndarray,
        optical_depths: np.ndarray,
        status: str,
        pixel_p99: float,
        xyz_p99: float,
        output_path: Path) -> tuple[Path, Path]:
    """Save an intuitive image-to-BEV comparison and alternating GIF."""
    if len(original_lidar) == 0:
        raise ValueError(
            f'No visible points available for simple BEV validation: '
            f'output_path={output_path}')
    bev_limit = 30.0
    normalized_depth = np.clip(optical_depths / 30.0, 0.0, 1.0)
    colors = plt.get_cmap('turbo')(normalized_depth)
    figure, axes = plt.subplots(
        1, 3, figsize=(19, 6), layout='constrained')

    axes[0].imshow(image_rgb)
    axes[0].scatter(
        image_pixels[:, 0],
        image_pixels[:, 1],
        c=colors,
        s=5,
        alpha=0.8)
    axes[0].set_title('1. Fisheye image pixels')
    axes[0].axis('off')

    for axis, points, title in (
            (axes[1], original_lidar, '2. Real LiDAR BEV'),
            (axes[2], recovered_lidar,
             '3. BEV recovered by fisheye LSS')):
        axis.scatter(points[:, 0], points[:, 1], c=colors, s=5, alpha=0.8)
        axis.scatter([0.0], [0.0], marker='x', c='black', s=80)
        axis.set_xlim(-bev_limit, bev_limit)
        axis.set_ylim(-bev_limit, bev_limit)
        axis.set_aspect('equal')
        axis.set_xlabel('X (m)')
        axis.set_ylabel('Y (m)')
        axis.grid(True, linestyle='--', alpha=0.3)
        axis.set_title(title)

    status_color = 'green' if status == 'PASS' else 'red'
    figure.suptitle(
        f'{status}: compare panels 2 and 3 | '
        f'pixel P99={pixel_p99:.6f}px | XYZ P99={xyz_p99:.6f}m',
        color=status_color,
        fontsize=16,
        fontweight='bold')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close(figure)

    gif_path = output_path.with_suffix('.gif')
    original_frame = render_bev_frame(
        original_lidar, colors, 'Real LiDAR BEV', bev_limit)
    recovered_frame = render_bev_frame(
        recovered_lidar, colors, 'Fisheye LSS recovered BEV', bev_limit)
    original_frame.save(
        gif_path,
        save_all=True,
        append_images=[recovered_frame],
        duration=700,
        loop=0)
    return output_path, gif_path


def calibration_tensors(
        calibration: dict,
        dtype: torch.dtype) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor,
                                     torch.Tensor]:
    """Convert one config calibration to batched geometry tensors."""
    intrinsics = torch.tensor(
        calibration['camera_intrinsic'], dtype=dtype).reshape(1, 1, 3, 3)
    distortion = torch.tensor(
        calibration['distortion'], dtype=dtype).reshape(1, 1, 4)
    fisheye_mask = torch.tensor([[calibration['camera_model'] == 'fisheye']])
    axis_signs = torch.tensor(
        calibration['axis_signs'], dtype=dtype).reshape(1, 1, 3)
    return intrinsics, distortion, fisheye_mask, axis_signs


def project_with_opencv(
        camera_points: np.ndarray,
        intrinsic: np.ndarray,
        distortion: np.ndarray,
        axis_signs: np.ndarray) -> np.ndarray:
    """Project camera points with OpenCV's independent fisheye API."""
    optical_points = camera_points * axis_signs
    projected, _ = cv2.fisheye.projectPoints(
        optical_points.reshape(-1, 1, 3).astype(np.float64),
        np.zeros((3, 1), dtype=np.float64),
        np.zeros((3, 1), dtype=np.float64),
        intrinsic.astype(np.float64),
        distortion.astype(np.float64).reshape(4, 1))
    return projected.reshape(-1, 2)


def evaluate_actual_lss_frustum(
        cfg: Config,
        metainfo: dict,
        calibrations: Sequence[dict],
        requested_depths: Sequence[float]
) -> dict[str, dict[str, object]]:
    """Run the configured get_geometry path and project its frustum back."""
    view_transform = MODELS.build(dict(cfg.model.view_transform))
    camera_intrinsics = torch.as_tensor(
        np.asarray(metainfo['cam2img']), dtype=torch.float32).unsqueeze(0)
    camera2lidar = torch.as_tensor(
        np.asarray(metainfo['cam2lidar']), dtype=torch.float32).unsqueeze(0)
    img_aug_matrix = torch.as_tensor(
        np.asarray(metainfo['img_aug_matrix']),
        dtype=torch.float32).unsqueeze(0)
    camera2lidar_rots = camera2lidar[..., :3, :3]
    camera2lidar_trans = camera2lidar[..., :3, 3]
    post_rots = img_aug_matrix[..., :3, :3]
    post_trans = img_aug_matrix[..., :3, 3]
    geometry = view_transform.get_geometry(
        camera2lidar_rots,
        camera2lidar_trans,
        camera_intrinsics[..., :3, :3],
        post_rots,
        post_trans)
    frustum = view_transform.frustum
    depth_bins = frustum[:, 0, 0, 2]
    target_pixels = frustum[..., :2]

    results = {}
    for camera_index, calibration in enumerate(calibrations):
        channel = str(calibration['camera_name'])
        lidar_geometry = geometry[0, camera_index]
        lidar2camera = torch.inverse(camera2lidar[0, camera_index])
        homogeneous_lidar = torch.cat(
            (lidar_geometry, torch.ones_like(lidar_geometry[..., :1])),
            dim=-1)
        camera_geometry = lidar2camera.matmul(
            homogeneous_lidar.unsqueeze(-1)).squeeze(-1)[..., :3]
        tensors = calibration_tensors(calibration, torch.float32)
        projected, _, projected_valid = project_camera_points(
            camera_geometry.unsqueeze(0).unsqueeze(0), *tensors)
        projected = projected[0, 0]
        projected_valid = projected_valid[0, 0]
        homogeneous_pixels = torch.cat(
            (projected, torch.ones_like(projected[..., :1])), dim=-1)
        augmented_pixels = img_aug_matrix[0, camera_index, :3, :3].matmul(
            homogeneous_pixels.unsqueeze(-1)).squeeze(-1)
        augmented_pixels += img_aug_matrix[0, camera_index, :3, 3]
        augmented_pixels = augmented_pixels[..., :2]
        finite_geometry = (lidar_geometry.abs() < 1e5).all(dim=-1)
        valid = (
            finite_geometry & projected_valid &
            torch.isfinite(augmented_pixels).all(dim=-1))
        errors = torch.linalg.vector_norm(
            augmented_pixels[valid] -
            target_pixels.to(augmented_pixels)[valid],
            dim=-1).numpy()

        rays = []
        for requested_depth in requested_depths:
            depth_index = int(
                torch.argmin((depth_bins - requested_depth).abs()).item())
            ray_points = lidar_geometry[depth_index].reshape(-1, 3)
            ray_points = ray_points[
                (ray_points.abs() < 1e5).all(dim=-1)].numpy()
            rays.append((float(depth_bins[depth_index].item()), ray_points))
        results[channel] = {
            'frustum_pixel_error': percentile_summary(errors),
            'frustum_valid_points': int(valid.sum().item()),
            'rays': rays,
        }
    return results


def validate_camera(
        channel: str,
        calibration: dict,
        calibrated_sensor: dict,
        lidar_points: np.ndarray,
        image_path: Path,
        lss_validation: dict[str, object],
        max_points: int,
        pixel_p99_threshold: float,
        xyz_p99_threshold: float,
        convergence_threshold: float,
        output_path: Path) -> dict[str, object]:
    """Validate and render one camera's fisheye geometry."""
    image_bgr = cv2.imread(str(image_path))
    if image_bgr is None:
        raise FileNotFoundError(
            f'Failed to read camera image: channel={channel}, '
            f'image_path={image_path}')
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    image_height, image_width = image_rgb.shape[:2]

    if len(lidar_points) > max_points:
        indices = np.linspace(
            0, len(lidar_points) - 1, max_points, dtype=np.int64)
        lidar_points = lidar_points[indices]

    lidar_to_camera = get_lidar_to_camera_matrix(calibrated_sensor)
    camera_to_lidar = np.linalg.inv(lidar_to_camera)
    camera_points = transform_points_matrix(
        lidar_points[:, :3], lidar_to_camera)
    tensors = calibration_tensors(calibration, torch.float32)
    camera_tensor = torch.from_numpy(
        camera_points.astype(np.float32)).reshape(1, 1, -1, 3)
    torch_pixels, optical_depths, valid = project_camera_points(
        camera_tensor, *tensors)
    recovered_camera, recovered_valid, converged = unproject_image_points(
        torch_pixels,
        optical_depths,
        *tensors,
        newton_iterations=10)

    torch_pixels_np = torch_pixels[0, 0].numpy()
    optical_depths_np = optical_depths[0, 0].numpy()
    valid_np = valid[0, 0].numpy()
    recovered_valid_np = recovered_valid[0, 0].numpy()
    converged_np = converged[0, 0].numpy()
    reference_pixels = project_lidar_points_to_image(
        lidar_points[:, :3], calibrated_sensor)

    intrinsic = np.asarray(
        calibration['camera_intrinsic'], dtype=np.float64)
    distortion = np.asarray(calibration['distortion'], dtype=np.float64)
    axis_signs = np.asarray(calibration['axis_signs'], dtype=np.float64)
    opencv_pixels = project_with_opencv(
        camera_points, intrinsic, distortion, axis_signs)
    on_image = (
        valid_np & np.isfinite(reference_pixels).all(axis=1) &
        (reference_pixels[:, 0] >= 0) &
        (reference_pixels[:, 0] < image_width) &
        (reference_pixels[:, 1] >= 0) &
        (reference_pixels[:, 1] < image_height))
    pixel_errors = np.linalg.norm(
        torch_pixels_np[on_image] - reference_pixels[on_image], axis=1)
    opencv_errors = np.linalg.norm(
        torch_pixels_np[on_image] - opencv_pixels[on_image], axis=1)
    round_trip_mask = valid_np & recovered_valid_np
    xyz_errors = np.linalg.norm(
        recovered_camera[0, 0].numpy()[round_trip_mask] -
        camera_points[round_trip_mask],
        axis=1)
    positive_depth = optical_depths_np > 0
    convergence_rate = float(
        converged_np[positive_depth].mean()) if positive_depth.any() else 0.0

    recovered_lidar = transform_points_matrix(
        recovered_camera[0, 0].numpy()[round_trip_mask], camera_to_lidar)
    original_lidar = lidar_points[round_trip_mask, :3]
    radial_distance = np.linalg.norm(
        torch_pixels_np[on_image] -
        np.array([intrinsic[0, 2], intrinsic[1, 2]]),
        axis=1)
    rays = lss_validation['rays']
    pixel_summary = percentile_summary(pixel_errors)
    xyz_summary = percentile_summary(xyz_errors)
    frustum_p99 = lss_validation['frustum_pixel_error']['p99']
    passed = (
        pixel_summary['p99'] <= pixel_p99_threshold
        and xyz_summary['p99'] <= xyz_p99_threshold
        and frustum_p99 <= pixel_p99_threshold
        and convergence_rate >= convergence_threshold)
    status = 'PASS' if passed else 'FAIL'

    simple_indices = np.flatnonzero(on_image & recovered_valid_np)
    if len(simple_indices) > 5000:
        simple_indices = simple_indices[np.linspace(
            0, len(simple_indices) - 1, 5000, dtype=np.int64)]
    simple_original_lidar = lidar_points[simple_indices, :3]
    simple_recovered_lidar = transform_points_matrix(
        recovered_camera[0, 0].numpy()[simple_indices], camera_to_lidar)
    simple_output_path = output_path.with_name(
        f'{output_path.stem}_simple.png')
    simple_image_path, simple_gif_path = save_simple_bev_validation(
        image_rgb=image_rgb,
        image_pixels=torch_pixels_np[simple_indices],
        original_lidar=simple_original_lidar,
        recovered_lidar=simple_recovered_lidar,
        optical_depths=optical_depths_np[simple_indices],
        status=status,
        pixel_p99=pixel_summary['p99'],
        xyz_p99=xyz_summary['p99'],
        output_path=simple_output_path)

    figure, axes = plt.subplots(2, 2, figsize=(15, 10),
                               layout='constrained')
    axes[0, 0].imshow(image_rgb)
    shown = np.flatnonzero(on_image)
    axes[0, 0].scatter(
        reference_pixels[shown, 0],
        reference_pixels[shown, 1],
        c=optical_depths_np[shown],
        s=1,
        cmap='viridis',
        alpha=0.65,
        label='NumPy reference')
    comparison = shown[::max(1, len(shown) // 1000)]
    axes[0, 0].scatter(
        torch_pixels_np[comparison, 0],
        torch_pixels_np[comparison, 1],
        facecolors='none',
        edgecolors='red',
        s=8,
        linewidths=0.35,
        label='Torch')
    axes[0, 0].set_title(f'{channel}: LiDAR projection overlay')
    axes[0, 0].set_xlim(0, image_width)
    axes[0, 0].set_ylim(image_height, 0)
    axes[0, 0].legend(loc='upper right', fontsize=7)

    axes[0, 1].scatter(radial_distance, pixel_errors, s=2, alpha=0.5)
    axes[0, 1].set_xlabel('Distance from principal point (px)')
    axes[0, 1].set_ylabel('Torch vs NumPy error (px)')
    axes[0, 1].set_yscale('symlog', linthresh=1e-5)
    axes[0, 1].grid(True, linestyle='--', alpha=0.3)
    axes[0, 1].set_title('Projection error by image radius')

    bev_limit = 30.0
    axes[1, 0].scatter(
        original_lidar[:, 0], original_lidar[:, 1],
        s=1, alpha=0.4, label='Original LiDAR')
    axes[1, 0].scatter(
        recovered_lidar[:, 0], recovered_lidar[:, 1],
        s=4, facecolors='none', edgecolors='red',
        linewidths=0.3, label='Round trip')
    axes[1, 0].set_xlim(-bev_limit, bev_limit)
    axes[1, 0].set_ylim(-bev_limit, bev_limit)
    axes[1, 0].set_aspect('equal')
    axes[1, 0].set_xlabel('X (m)')
    axes[1, 0].set_ylabel('Y (m)')
    axes[1, 0].grid(True, linestyle='--', alpha=0.3)
    axes[1, 0].legend(fontsize=7)
    axes[1, 0].set_title('LiDAR round-trip BEV')

    for depth, ray_points in rays:
        axes[1, 1].scatter(
            ray_points[:, 0], ray_points[:, 1],
            s=5, alpha=0.6, label=f'z={depth:g} m')
    axes[1, 1].set_xlim(-bev_limit, bev_limit)
    axes[1, 1].set_ylim(-bev_limit, bev_limit)
    axes[1, 1].set_aspect('equal')
    axes[1, 1].set_xlabel('X (m)')
    axes[1, 1].set_ylabel('Y (m)')
    axes[1, 1].grid(True, linestyle='--', alpha=0.3)
    axes[1, 1].legend(fontsize=7)
    axes[1, 1].set_title('LSS fisheye rays by z-depth')

    figure.suptitle(
        f'{channel} | pixel P99={pixel_summary["p99"]:.6f}px | '
        f'XYZ P99={xyz_summary["p99"]:.6f}m | '
        f'converged={convergence_rate:.6%}')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_path, dpi=160, bbox_inches='tight')
    plt.close(figure)

    return {
        'channel': channel,
        'image_path': str(image_path),
        'input_points': int(len(lidar_points)),
        'valid_projected_points': int(valid_np.sum()),
        'visible_points': int(on_image.sum()),
        'rear_hemisphere_points': int((optical_depths_np <= 0).sum()),
        'newton_convergence_rate': convergence_rate,
        'pixel_error': pixel_summary,
        'opencv_pixel_error': percentile_summary(opencv_errors),
        'xyz_error_m': xyz_summary,
        'frustum_pixel_error': lss_validation['frustum_pixel_error'],
        'frustum_valid_points': lss_validation['frustum_valid_points'],
        'output_image': str(output_path),
        'simple_output_image': str(simple_image_path),
        'simple_output_gif': str(simple_gif_path),
        'status': status,
    }


def main() -> None:
    """Run validation for every configured camera."""
    args = parse_args()
    cfg = Config.fromfile(str(args.config))
    init_default_scope(cfg.get('default_scope', 'mmdet3d'))
    if cfg.val_dataloader is None:
        raise ValueError(
            f'val_dataloader is required for geometry validation: '
            f'{args.config}')
    dataset_config = cfg.val_dataloader.dataset.copy()
    training_dataset_config = cfg.train_dataloader.dataset
    while training_dataset_config.get('dataset') is not None:
        training_dataset_config = training_dataset_config.dataset
    dataset_config.ann_file = training_dataset_config.ann_file
    dataset = DATASETS.build(dataset_config)
    if args.sample_index < 0 or args.sample_index >= len(dataset):
        raise IndexError(
            f'sample-index={args.sample_index} is outside dataset length '
            f'{len(dataset)}')
    calibration_configs = cfg.model.view_transform.get('camera_calibrations')
    calibrations = [
        dict(calibration) for calibration in calibration_configs
    ] if calibration_configs else []
    if not calibrations:
        raise ValueError(
            f'No camera_calibrations found in config: {args.config}')

    data_root = args.data_root.resolve()
    data_info = dataset.get_data_info(args.sample_index)
    item = dataset[args.sample_index]
    lidar_points = item['inputs']['points'].numpy()
    metainfo = item['data_samples'].metainfo
    lss_validation = evaluate_actual_lss_frustum(
        cfg, metainfo, calibrations, args.depths)
    lookup = NuScenesCalibrationLookup(data_root, args.metadata_version)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    camera_results = []
    for calibration in calibrations:
        channel = str(calibration['camera_name'])
        image_info = data_info['images'][channel]
        calibrated_sensor = lookup.get(image_info['sample_data_token'])
        configured_image_path = Path(image_info['img_path'])
        if configured_image_path.is_absolute():
            image_path = configured_image_path
        elif configured_image_path.is_file():
            image_path = configured_image_path.resolve()
        else:
            image_path = resolve_camera_image_path(
                data_root, channel, image_info['img_path'])
        output_path = (
            args.output_dir /
            f'sample_{args.sample_index:05d}_{channel.lower()}.png')
        result = validate_camera(
            channel=channel,
            calibration=calibration,
            calibrated_sensor=calibrated_sensor,
            lidar_points=lidar_points,
            image_path=image_path,
            lss_validation=lss_validation[channel],
            max_points=args.max_points,
            pixel_p99_threshold=args.pixel_p99_threshold,
            xyz_p99_threshold=args.xyz_p99_threshold,
            convergence_threshold=args.convergence_threshold,
            output_path=output_path)
        camera_results.append(result)
        print(
            f'{channel}: pixel_p99={result["pixel_error"]["p99"]:.6f}px, '
            f'frustum_p99='
            f'{result["frustum_pixel_error"]["p99"]:.6f}px, '
            f'xyz_p99={result["xyz_error_m"]["p99"]:.6f}m, '
            f'output={output_path}')

    metrics = {
        'config': str(args.config),
        'sample_index': args.sample_index,
        'camera_order': [
            str(calibration['camera_name']) for calibration in calibrations
        ],
        'cameras': camera_results,
    }
    metrics_path = (
        args.output_dir / f'sample_{args.sample_index:05d}_metrics.json')
    metrics_path.write_text(
        json.dumps(metrics, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'Saved metrics: {metrics_path}')

    failures = [
        result for result in camera_results
        if result['pixel_error']['p99'] > args.pixel_p99_threshold
        or result['frustum_pixel_error']['p99'] > args.pixel_p99_threshold
        or result['xyz_error_m']['p99'] > args.xyz_p99_threshold
        or result['newton_convergence_rate'] < args.convergence_threshold
    ]
    if args.fail_on_threshold and failures:
        failed_channels = [result['channel'] for result in failures]
        raise RuntimeError(
            f'Geometry validation failed for channels={failed_channels}, '
            f'pixel_p99_threshold={args.pixel_p99_threshold}, '
            f'xyz_p99_threshold={args.xyz_p99_threshold}, '
            f'convergence_threshold={args.convergence_threshold}')


if __name__ == '__main__':
    main()
