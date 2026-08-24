#!/usr/bin/env python3
"""Convert custom ASCII PCD files and duplicate NuScenes info files."""

import argparse
import pickle
from pathlib import Path
from typing import Iterable

import numpy as np


SOURCE_LIDAR_DIRECTORY = Path('samples/LIDAR_TOP')
TARGET_LIDAR_DIRECTORY = Path('samples/LIDAR_TOP_BIN')
DEFAULT_INFO_FILES = (
    'nuscenes_infos_train.pkl',
    'nuscenes_infos_val.pkl',
    'nuscenes_infos_test.pkl',
)


def parse_ascii_pcd(source_path: Path) -> np.ndarray:
    """Return x, y, z, and intensity fields from an ASCII PCD file."""
    content = source_path.read_text(encoding='utf-8')
    try:
        header, point_data = content.split('\nDATA ascii', maxsplit=1)
    except ValueError as error:
        raise ValueError(
            f'Expected an ASCII PCD file with DATA ascii: {source_path}') from error

    fields: list[str] | None = None
    for line in header.splitlines():
        if line.startswith('FIELDS '):
            fields = line.split()[1:]
            break
    if fields is None:
        raise ValueError(f'PCD file is missing FIELDS metadata: {source_path}')

    required_fields = ('x', 'y', 'z', 'intensity')
    missing_fields = [field for field in required_fields if field not in fields]
    if missing_fields:
        raise ValueError(
            f'PCD file is missing required fields {missing_fields}: {source_path}')

    values = np.fromstring(point_data, sep=' ', dtype=np.float32)
    if values.size % len(fields) != 0:
        raise ValueError(
            f'PCD point data does not match FIELDS metadata: {source_path}')

    points = values.reshape(-1, len(fields))
    field_indices = [fields.index(field) for field in required_fields]
    return points[:, field_indices]


def convert_ascii_pcd(source_path: Path, target_path: Path) -> None:
    """Write one ASCII PCD as five-feature float32 binary point data."""
    points = parse_ascii_pcd(source_path)
    points_with_time = np.pad(
        points, ((0, 0), (0, 1)), mode='constant', constant_values=0)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    points_with_time.astype(np.float32, copy=False).tofile(target_path)


def iter_pcd_files(source_directory: Path) -> Iterable[Path]:
    """Yield all PCD files in the source LiDAR directory."""
    return sorted(source_directory.glob('*.pcd'))


def rewrite_lidar_path(lidar_path: str) -> str:
    """Return a binary LiDAR path preserving the info-file path convention."""
    binary_name = f'{Path(lidar_path).stem}.bin'
    if 'samples' in Path(lidar_path).parts:
        return str(TARGET_LIDAR_DIRECTORY / binary_name)
    return binary_name


def rewrite_info_paths(info_data: dict) -> None:
    """Update current-frame and sweep paths to the binary LiDAR directory."""
    for sample in info_data['data_list']:
        sample['lidar_points']['lidar_path'] = rewrite_lidar_path(
            sample['lidar_points']['lidar_path'])
        for sweep in sample.get('lidar_sweeps', []):
            sweep['lidar_points']['lidar_path'] = rewrite_lidar_path(
                sweep['lidar_points']['lidar_path'])


def convert_info_file(source_path: Path, target_path: Path,
                      overwrite: bool) -> None:
    """Copy an info pickle with LiDAR paths rewritten for binary files."""
    if target_path.exists() and not overwrite:
        raise FileExistsError(
            f'Output info file already exists: {target_path}. '
            'Pass --overwrite to replace it.')
    with source_path.open('rb') as file_obj:
        info_data = pickle.load(file_obj)
    rewrite_info_paths(info_data)
    with target_path.open('wb') as file_obj:
        pickle.dump(info_data, file_obj)


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Convert ASCII PCD files to binary NuScenes point clouds.')
    parser.add_argument(
        '--data-root',
        type=Path,
        required=True,
        help='NuScenes data root containing samples/LIDAR_TOP and info pickles.')
    parser.add_argument(
        '--info-files',
        nargs='+',
        default=DEFAULT_INFO_FILES,
        help='Info pickle filenames relative to --data-root.')
    parser.add_argument(
        '--overwrite',
        action='store_true',
        help='Replace existing binary files and rewritten info pickles.')
    return parser.parse_args()


def main() -> None:
    """Convert point clouds and write binary-path info copies."""
    args = parse_args()
    source_directory = args.data_root / SOURCE_LIDAR_DIRECTORY
    target_directory = args.data_root / TARGET_LIDAR_DIRECTORY
    if not source_directory.is_dir():
        raise FileNotFoundError(
            f'Source LiDAR directory does not exist: {source_directory}')

    source_files = list(iter_pcd_files(source_directory))
    if not source_files:
        raise FileNotFoundError(f'No PCD files found in: {source_directory}')

    for source_path in source_files:
        target_path = target_directory / f'{source_path.stem}.bin'
        if not target_path.exists() or args.overwrite:
            convert_ascii_pcd(source_path, target_path)

    for info_filename in args.info_files:
        source_path = args.data_root / info_filename
        if not source_path.is_file():
            raise FileNotFoundError(f'Info file does not exist: {source_path}')
        target_path = source_path.with_name(
            f'{source_path.stem}_bin{source_path.suffix}')
        convert_info_file(source_path, target_path, args.overwrite)

    print(
        f'Converted {len(source_files)} PCD files to {target_directory} and '
        f'wrote {len(args.info_files)} binary-path info pickles.')


if __name__ == '__main__':
    main()
