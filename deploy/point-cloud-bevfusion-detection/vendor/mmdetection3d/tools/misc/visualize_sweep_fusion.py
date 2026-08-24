#!/usr/bin/env python3
"""Render current-frame and multi-sweep LiDAR BEV comparisons."""

import argparse
import pickle
from pathlib import Path
from typing import Any

import matplotlib
import numpy as np

matplotlib.use('Agg')
import matplotlib.pyplot as plt

from mmdet3d.datasets.transforms.vehicle_point_filter import (
    compute_vehicle_exclusion_region,
    load_car_info,
    mask_points_outside_vehicle_region,
)


DEFAULT_INFO_FILE = 'nuscenes_infos_train_bin.pkl'
DEFAULT_OUTPUT_DIRECTORY = Path('outputs/vis/sweeps')
DEFAULT_POINT_DIRECTORY = Path('samples/LIDAR_TOP_BIN')
DEFAULT_REMOVE_CLOSE_RADIUS = 1.0


def transform_sweep_points(points: np.ndarray, lidar2sensor: np.ndarray,
                           time_lag: float) -> np.ndarray:
    """Transform a historical sweep to the current LiDAR frame."""
    transformed = points.copy()
    transformed[:, :3] = transformed[:, :3] @ lidar2sensor[:3, :3]
    transformed[:, :3] -= lidar2sensor[:3, 3]
    transformed[:, 4] = time_lag
    return transformed


def resolve_lidar_path(data_root: Path, lidar_path: str) -> Path:
    """Resolve a point-cloud path in a converted NuScenes info file."""
    path = Path(lidar_path)
    if path.is_absolute():
        return path
    if 'samples' in path.parts:
        return data_root / path
    return data_root / DEFAULT_POINT_DIRECTORY / path


def load_points(data_root: Path, lidar_path: str) -> np.ndarray:
    """Load five-feature float32 binary points."""
    path = resolve_lidar_path(data_root, lidar_path)
    points = np.fromfile(path, dtype=np.float32)
    if points.size % 5 != 0:
        raise ValueError(
            f'Expected five-feature float32 points in {path}, '
            f'got {points.size} values.')
    return points.reshape(-1, 5)


def remove_close_points(points: np.ndarray, radius: float) -> np.ndarray:
    """Drop points within a square neighborhood around the ego origin."""
    x_filter = np.abs(points[:, 0]) < radius
    y_filter = np.abs(points[:, 1]) < radius
    keep_mask = np.logical_not(np.logical_and(x_filter, y_filter))
    return points[keep_mask]


def load_fused_points(
        sample: dict[str, Any],
        data_root: Path,
        sweeps_num: int,
        remove_close_radius: float | None,
        filter_fused_radius: float | None = None,
        vehicle_exclusion_region: tuple[float, float, float, float]
        | None = None) -> np.ndarray:
    """Load the current frame and historical sweeps like the training pipeline."""
    current_points = load_points(
        data_root, sample['lidar_points']['lidar_path']).copy()
    current_points[:, 4] = 0
    point_sets = [current_points]
    timestamp = sample['timestamp']

    for sweep in sample.get('lidar_sweeps', [])[:sweeps_num]:
        sweep_points = load_points(
            data_root, sweep['lidar_points']['lidar_path'])
        if remove_close_radius is not None:
            sweep_points = remove_close_points(sweep_points, remove_close_radius)
        point_sets.append(
            transform_sweep_points(
                sweep_points,
                np.asarray(sweep['lidar_points']['lidar2sensor']),
                timestamp - sweep['timestamp']))
    fused_points = np.concatenate(point_sets, axis=0)
    if filter_fused_radius is not None:
        fused_points = remove_close_points(fused_points, filter_fused_radius)
    if vehicle_exclusion_region is not None:
        fused_points = mask_points_outside_vehicle_region(
            fused_points, vehicle_exclusion_region)
    return fused_points


def downsample_points(points: np.ndarray, max_points: int,
                      rng: np.random.Generator) -> np.ndarray:
    """Return at most max_points selected without replacement."""
    if len(points) <= max_points:
        return points
    indices = rng.choice(len(points), size=max_points, replace=False)
    return points[indices]


def select_samples(samples: list[dict[str, Any]], num_samples: int,
                   sweeps_num: int, seed: int) -> list[dict[str, Any]]:
    """Randomly select samples with enough historical sweeps."""
    eligible_samples = [
        sample for sample in samples
        if len(sample.get('lidar_sweeps', [])) >= sweeps_num
    ]
    if len(eligible_samples) < num_samples:
        raise ValueError(
            f'Only {len(eligible_samples)} samples with at least {sweeps_num} '
            f'historical sweeps are available; requested {num_samples}.')
    rng = np.random.default_rng(seed)
    indices = rng.choice(
        len(eligible_samples), size=num_samples, replace=False)
    return [eligible_samples[index] for index in indices]


def render_comparison(current_points: np.ndarray, fused_points: np.ndarray,
                      sample_idx: int, output_path: Path,
                      point_cloud_range: tuple[float, float, float, float],
                      remove_close_radius: float | None,
                      filter_fused_radius: float | None,
                      vehicle_exclusion_region: tuple[float, float, float, float]
                      | None) -> None:
    """Save a two-panel BEV comparison for one sample."""
    x_min, x_max, y_min, y_max = point_cloud_range
    figure, axes = plt.subplots(
        1,
        2,
        figsize=(14, 7),
        sharex=True,
        sharey=True,
        layout='constrained')
    rng = np.random.default_rng(sample_idx)
    current = downsample_points(current_points, 80000, rng)
    fused = downsample_points(fused_points, 80000, rng)

    fused_title = 'Current + sweeps'
    if remove_close_radius is not None:
        fused_title += f', sweep remove_close={remove_close_radius:g}m'
    if filter_fused_radius is not None:
        fused_title += f', fused filter={filter_fused_radius:g}m'
    if vehicle_exclusion_region is not None:
        ex_x_min, ex_x_max, ex_y_min, ex_y_max = vehicle_exclusion_region
        fused_title += (
            f', vehicle blind zone '
            f'x[{ex_x_min:.2f},{ex_x_max:.2f}] y[{ex_y_min:.2f},{ex_y_max:.2f}]')
    fused_title += f' ({len(fused_points):,} points)'

    for axis, points, title in (
            (axes[0], current, f'Current frame ({len(current_points):,} points)'),
            (axes[1], fused, fused_title)):
        mask = ((points[:, 0] >= x_min) & (points[:, 0] <= x_max) &
                (points[:, 1] >= y_min) & (points[:, 1] <= y_max))
        visible_points = points[mask]
        scatter = axis.scatter(
            visible_points[:, 0],
            visible_points[:, 1],
            c=visible_points[:, 4],
            cmap='viridis',
            s=0.2,
            alpha=0.7,
            vmin=0)
        axis.set_title(title)
        axis.set_aspect('equal', adjustable='box')
        axis.set_xlim(x_min, x_max)
        axis.set_ylim(y_min, y_max)
        axis.set_xlabel('X (m)')
        axis.grid(True, linestyle='--', alpha=0.3)

    axes[0].set_ylabel('Y (m)')
    colorbar = figure.colorbar(scatter, ax=axes, shrink=0.8)
    colorbar.set_label('Sweep timestamp delta')
    figure.suptitle(f'Multi-sweep fusion | sample {sample_idx}')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close(figure)


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Save BEV comparisons of current and fused LiDAR sweeps.')
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--info-file', default=DEFAULT_INFO_FILE)
    parser.add_argument('--output-dir', type=Path, default=DEFAULT_OUTPUT_DIRECTORY)
    parser.add_argument('--num-samples', type=int, default=5)
    parser.add_argument('--sweeps-num', type=int, default=9)
    parser.add_argument(
        '--seed',
        type=int,
        default=0,
        help='Random seed used to select samples.')
    parser.add_argument(
        '--point-cloud-range',
        type=float,
        nargs=4,
        default=(-21.0, 21.0, -21.0, 21.0),
        metavar=('XMIN', 'XMAX', 'YMIN', 'YMAX'))
    parser.add_argument(
        '--remove-close-radius',
        type=float,
        default=DEFAULT_REMOVE_CLOSE_RADIUS,
        help='Drop historical sweep points within this radius in meters. '
        'Matches LoadPointsFromMultiSweeps.remove_close in training.')
    parser.add_argument(
        '--no-remove-close',
        action='store_true',
        help='Keep all historical sweep points for raw fusion visualization.')
    parser.add_argument(
        '--filter-fused-radius',
        type=float,
        default=None,
        help='Optional extra radius filter applied to the fused cloud in the '
        'current frame. This is visualization-only and not used in training.')
    parser.add_argument(
        '--car-config',
        type=Path,
        default=None,
        help='Vehicle geometry JSON used to remove body and blind-zone points.')
    parser.add_argument(
        '--blind-zone-front',
        type=float,
        default=1.3,
        help='Forward blind-zone length in meters beyond the front bumper.')
    parser.add_argument(
        '--blind-zone-rear',
        type=float,
        default=1.3,
        help='Rear blind-zone length in meters beyond the rear bumper.')
    return parser.parse_args()


def main() -> None:
    """Render comparisons for randomly selected multi-sweep samples."""
    args = parse_args()
    info_path = args.data_root / args.info_file
    with info_path.open('rb') as file_obj:
        data_list = pickle.load(file_obj)['data_list']

    remove_close_radius = None if args.no_remove_close else args.remove_close_radius
    vehicle_exclusion_region = None
    if args.car_config is not None:
        vehicle_exclusion_region = compute_vehicle_exclusion_region(
            load_car_info(args.car_config),
            blind_zone_front=args.blind_zone_front,
            blind_zone_rear=args.blind_zone_rear)
    samples = select_samples(
        data_list,
        num_samples=args.num_samples,
        sweeps_num=args.sweeps_num,
        seed=args.seed)
    for sample in samples:
        current_points = load_points(
            args.data_root, sample['lidar_points']['lidar_path'])
        if vehicle_exclusion_region is not None:
            current_points = mask_points_outside_vehicle_region(
                current_points, vehicle_exclusion_region)
        fused_points = load_fused_points(
            sample,
            args.data_root,
            args.sweeps_num,
            remove_close_radius=remove_close_radius,
            filter_fused_radius=args.filter_fused_radius,
            vehicle_exclusion_region=vehicle_exclusion_region)
        output_path = args.output_dir / f'sweep_fusion_{sample["sample_idx"]:05d}.png'
        render_comparison(
            current_points,
            fused_points,
            sample['sample_idx'],
            output_path,
            tuple(args.point_cloud_range),
            remove_close_radius,
            args.filter_fused_radius,
            vehicle_exclusion_region)
        print(f'Saved: {output_path}')


if __name__ == '__main__':
    main()
