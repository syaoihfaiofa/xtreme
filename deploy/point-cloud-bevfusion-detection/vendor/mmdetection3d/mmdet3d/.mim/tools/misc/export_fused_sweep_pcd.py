#!/usr/bin/env python3
"""Export randomly selected multi-sweep fused point clouds as ASCII PCD files."""

import argparse
import pickle
import sys
from pathlib import Path

import numpy as np

from mmdet3d.datasets.transforms.vehicle_point_filter import (
    compute_vehicle_exclusion_region,
    load_car_info,
)

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from visualize_sweep_fusion import (  # noqa: E402
    DEFAULT_INFO_FILE,
    DEFAULT_REMOVE_CLOSE_RADIUS,
    load_fused_points,
    select_samples,
)


DEFAULT_OUTPUT_DIRECTORY = Path('outputs/pcd/fused_sweeps')


def write_ascii_pcd(points: np.ndarray, output_path: Path) -> None:
    """Write five-feature points as an ASCII PCD file."""
    if points.ndim != 2 or points.shape[1] != 5:
        raise ValueError(
            f'Expected points with shape (N, 5), got {points.shape}.')
    num_points = len(points)
    header = '\n'.join([
        '# .PCD v0.7 - Point Cloud Data file format',
        'VERSION 0.7',
        'FIELDS x y z intensity time_lag',
        'SIZE 4 4 4 4 4',
        'TYPE F F F F F',
        'COUNT 1 1 1 1 1',
        f'WIDTH {num_points}',
        'HEIGHT 1',
        'VIEWPOINT 0 0 0 1 0 0 0',
        f'POINTS {num_points}',
        'DATA ascii',
        '',
    ])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open('w', encoding='utf-8') as file_obj:
        file_obj.write(header)
        np.savetxt(
            file_obj,
            points,
            fmt='%.6f',
            delimiter=' ')


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Export fused multi-sweep LiDAR point clouds as PCD files.')
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--info-file', default=DEFAULT_INFO_FILE)
    parser.add_argument('--output-dir', type=Path, default=DEFAULT_OUTPUT_DIRECTORY)
    parser.add_argument('--num-samples', type=int, default=15)
    parser.add_argument('--sweeps-num', type=int, default=9)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument(
        '--remove-close-radius',
        type=float,
        default=DEFAULT_REMOVE_CLOSE_RADIUS,
        help='Drop historical sweep points within this radius in meters.')
    parser.add_argument(
        '--no-remove-close',
        action='store_true',
        help='Keep all historical sweep points before fusion.')
    parser.add_argument(
        '--filter-fused-radius',
        type=float,
        default=None,
        help='Optional extra radius filter applied after fusion.')
    parser.add_argument(
        '--car-config',
        type=Path,
        default=None,
        help='Vehicle geometry JSON used to remove body and blind-zone points.')
    parser.add_argument('--blind-zone-front', type=float, default=1.3)
    parser.add_argument('--blind-zone-rear', type=float, default=1.3)
    return parser.parse_args()


def main() -> None:
    """Export fused point clouds for randomly selected samples."""
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
        fused_points = load_fused_points(
            sample,
            args.data_root,
            args.sweeps_num,
            remove_close_radius=remove_close_radius,
            filter_fused_radius=args.filter_fused_radius,
            vehicle_exclusion_region=vehicle_exclusion_region)
        output_path = (
            args.output_dir /
            f'fused_sweep_{sample["sample_idx"]:05d}_{len(fused_points)}pts.pcd')
        write_ascii_pcd(fused_points, output_path)
        print(f'Saved: {output_path} ({len(fused_points):,} points)')


if __name__ == '__main__':
    main()
