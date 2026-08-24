# Copyright (c) OpenMMLab. All rights reserved.
"""Rewrite lidar paths in *_bin.pkl files from .pcd to .bin."""
import argparse
import pickle
from pathlib import Path
from typing import Any, Dict, List


def rewrite_lidar_path(path: str) -> str:
  if path.endswith('.pcd'):
    return path[:-4] + '.bin'
  return path


def fix_data_list(data_list: List[Dict[str, Any]]) -> int:
    changed = 0
    for item in data_list:
        lidar_path = item['lidar_points']['lidar_path']
        new_lidar_path = rewrite_lidar_path(lidar_path)
        if new_lidar_path != lidar_path:
            item['lidar_points']['lidar_path'] = new_lidar_path
            changed += 1
        for sweep in item.get('lidar_sweeps', []):
            sweep_path = sweep['lidar_points']['lidar_path']
            sweep['lidar_points']['lidar_path'] = rewrite_lidar_path(
                sweep_path)
    return changed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Rewrite lidar paths in NuScenes *_bin.pkl files')
    parser.add_argument(
        'pkl_paths',
        nargs='+',
        help='Paths to nuscenes *_bin.pkl files')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    for pkl_path in args.pkl_paths:
        path = Path(pkl_path)
        if not path.is_file():
            raise FileNotFoundError(f'PKL file not found: {path}')
        with path.open('rb') as file_obj:
            data = pickle.load(file_obj)
        changed = fix_data_list(data['data_list'])
        with path.open('wb') as file_obj:
            pickle.dump(data, file_obj)
        print(f'Updated {changed} samples in {path}')


if __name__ == '__main__':
    main()
