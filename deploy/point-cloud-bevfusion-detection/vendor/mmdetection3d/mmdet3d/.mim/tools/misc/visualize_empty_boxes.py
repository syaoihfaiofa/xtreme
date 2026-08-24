#!/usr/bin/env python3
"""Visualize training samples that contain GT boxes with no interior points."""

from __future__ import annotations

import argparse
import copy
from pathlib import Path
from typing import Sequence

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import torch
from matplotlib.axes import Axes
from mmengine.config import Config
from mmengine.registry import init_default_scope

from mmdet3d.datasets.transforms.vehicle_point_filter import (
    compute_vehicle_exclusion_region,
    load_car_info,
)
from mmdet3d.registry import DATASETS
from mmdet3d.structures import LiDARInstance3DBoxes
from mmdet3d.structures.ops import box_np_ops

CLASS_COLORS: dict[str, tuple[float, float, float]] = {
    'Car': (0.0, 0.6, 1.0),
    'Cone': (1.0, 0.5, 0.0),
    'Pillar': (0.6, 0.2, 0.8),
}

EMPTY_BOX_COLOR = (1.0, 0.1, 0.1)
RANDOM_AUG_TYPES = (
    'ObjectSample',
    'GlobalRotScaleTrans',
    'BEVFusionRandomFlip3D',
    'PointShuffle',
    'FilterBoxesWithoutPoints',
    'Pack3DDetInputs',
)


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Visualize GT boxes that contain no points in train inputs.')
    parser.add_argument(
        '--config',
        type=Path,
        default=Path(
            'projects/BEVFusion/configs/bevfusion_lidar_voxel0075_custom-nus-3class.py'))
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('outputs/vis/train-input-empty-boxes'))
    parser.add_argument(
        '--num-samples',
        type=int,
        default=8,
        help='Number of samples with empty boxes to save.')
    parser.add_argument(
        '--scan-limit',
        type=int,
        default=0,
        help='Maximum dataset indices to scan. 0 means scan the full dataset.')
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--max-points', type=int, default=120000)
    parser.add_argument(
        '--bev-range',
        type=float,
        nargs=4,
        default=(-21.0, 21.0, -21.0, 21.0),
        metavar=('XMIN', 'XMAX', 'YMIN', 'YMAX'))
    parser.add_argument('--car-config', type=Path, default=Path('outputs/car.json'))
    parser.add_argument('--blind-zone-front', type=float, default=1.3)
    parser.add_argument('--blind-zone-rear', type=float, default=1.3)
    parser.add_argument(
        '--min-num-points',
        type=int,
        default=1,
        help='Boxes with fewer than this many interior points are marked empty.')
    return parser.parse_args()


def build_inspection_pipeline(cfg: Config) -> list:
    """Build a deterministic pipeline used to inspect empty boxes."""
    pipeline = [
        step for step in cfg.train_pipeline
        if step['type'] not in RANDOM_AUG_TYPES
    ]
    return pipeline


def build_dataset(cfg: Config, pipeline: list):
    """Build dataset for empty-box inspection."""
    dataset_cfg = cfg.train_dataloader.dataset
    if dataset_cfg['type'] == 'CBGSDataset':
        dataset_cfg = dataset_cfg['dataset']
    if dataset_cfg['type'] == 'RepeatDataset':
        dataset_cfg = dataset_cfg['dataset']
    dataset_cfg = dataset_cfg.copy()
    dataset_cfg['filter_empty_gt'] = False
    dataset_cfg['pipeline'] = pipeline
    return DATASETS.build(dataset_cfg)


def count_points_in_boxes(points: np.ndarray,
                          boxes: LiDARInstance3DBoxes) -> np.ndarray:
    """Return the number of points inside each GT box."""
    if len(boxes) == 0:
        return np.zeros((0,), dtype=np.int64)
    point_indices = box_np_ops.points_in_rbbox(
        points,
        boxes.tensor.numpy(),
        z_axis=2,
        origin=(0.5, 0.5, 0))
    return point_indices.sum(axis=0).astype(np.int64)


def downsample_points(points: np.ndarray, max_points: int,
                      rng: np.random.Generator) -> np.ndarray:
    """Return at most max_points selected without replacement."""
    if len(points) <= max_points:
        return points
    indices = rng.choice(len(points), size=max_points, replace=False)
    return points[indices]


def draw_box_bev(
        axis: Axes,
        box_corners: np.ndarray,
        color: tuple[float, float, float],
        linestyle: str,
        linewidth: float,
        label: str | None = None) -> None:
    """Draw one 3D box projected to BEV."""
    bottom_face = [0, 3, 7, 4, 0]
    axis.plot(
        box_corners[bottom_face, 0],
        box_corners[bottom_face, 1],
        color=color,
        linestyle=linestyle,
        linewidth=linewidth,
        label=label)
    axis.plot(
        [box_corners[4, 0], box_corners[7, 0]],
        [box_corners[4, 1], box_corners[7, 1]],
        color=color,
        linestyle=linestyle,
        linewidth=linewidth + 0.5)


def render_empty_boxes(
        points: np.ndarray,
        boxes: LiDARInstance3DBoxes,
        labels: torch.Tensor,
        point_counts: np.ndarray,
        class_names: Sequence[str],
        sample_idx: int,
        dataset_idx: int,
        output_path: Path,
        bev_range: tuple[float, float, float, float],
        max_points: int,
        seed: int,
        min_num_points: int,
        exclusion_region: tuple[float, float, float, float] | None) -> None:
    """Save one BEV image highlighting boxes without interior points."""
    x_min, x_max, y_min, y_max = bev_range
    rng = np.random.default_rng(seed)
    visible_points = downsample_points(points, max_points, rng)
    mask = (
        (visible_points[:, 0] >= x_min) & (visible_points[:, 0] <= x_max) &
        (visible_points[:, 1] >= y_min) & (visible_points[:, 1] <= y_max))
    visible_points = visible_points[mask]

    empty_mask = point_counts < min_num_points
    num_empty = int(empty_mask.sum())
    figure, axis = plt.subplots(figsize=(10, 10), layout='constrained')
    scatter = axis.scatter(
        visible_points[:, 0],
        visible_points[:, 1],
        c=visible_points[:, 4],
        cmap='viridis',
        s=0.2,
        alpha=0.7,
        vmin=0)

    if exclusion_region is not None:
        ex_x_min, ex_x_max, ex_y_min, ex_y_max = exclusion_region
        axis.add_patch(plt.Rectangle(
            (ex_x_min, ex_y_min),
            ex_x_max - ex_x_min,
            ex_y_max - ex_y_min,
            fill=True,
            facecolor='red',
            edgecolor='red',
            alpha=0.10,
            linewidth=1.0,
            label='ego blind zone'))

    used_labels: set[str] = set()
    if len(boxes) > 0:
        corners = boxes.corners.cpu().numpy()
        for box_corners, label_idx, num_points, is_empty in zip(
                corners, labels.tolist(), point_counts.tolist(),
                empty_mask.tolist()):
            class_name = class_names[label_idx]
            if is_empty:
                color = EMPTY_BOX_COLOR
                linestyle = '--'
                linewidth = 2.0
                legend_label = 'empty box' if 'empty box' not in used_labels else None
                if legend_label is not None:
                    used_labels.add(legend_label)
                center = box_corners[:, :2].mean(axis=0)
                axis.text(
                    center[0],
                    center[1],
                    f'{class_name}\n0 pts',
                    color='red',
                    fontsize=7,
                    ha='center',
                    va='center',
                    bbox=dict(facecolor='white', alpha=0.7, edgecolor='red'))
            else:
                color = CLASS_COLORS.get(class_name, (0.8, 0.8, 0.8))
                linestyle = '-'
                linewidth = 1.5
                legend_label = class_name if class_name not in used_labels else None
                if legend_label is not None:
                    used_labels.add(class_name)
            draw_box_bev(
                axis,
                box_corners,
                color=color,
                linestyle=linestyle,
                linewidth=linewidth,
                label=legend_label)

    axis.set_xlim(x_min, x_max)
    axis.set_ylim(y_min, y_max)
    axis.set_aspect('equal', adjustable='box')
    axis.set_xlabel('X (m)')
    axis.set_ylabel('Y (m)')
    axis.grid(True, linestyle='--', alpha=0.3)
    axis.set_title(
        f'Empty GT boxes | dataset idx {dataset_idx} | sample {sample_idx} | '
        f'{num_empty}/{len(boxes)} boxes with < {min_num_points} pts')
    colorbar = figure.colorbar(scatter, ax=axis, shrink=0.85)
    colorbar.set_label('time_lag (s)')
    if used_labels or exclusion_region is not None:
        axis.legend(loc='upper right', fontsize=8)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close(figure)


def main() -> None:
    """Find and visualize samples containing boxes without interior points."""
    args = parse_args()
    cfg = Config.fromfile(str(args.config))
    init_default_scope(cfg.get('default_scope', 'mmdet3d'))
    class_names = cfg.metainfo['classes']
    pipeline = build_inspection_pipeline(cfg)
    dataset = build_dataset(cfg, pipeline)
    exclusion_region = None
    if args.car_config.is_file():
        exclusion_region = compute_vehicle_exclusion_region(
            load_car_info(args.car_config),
            blind_zone_front=args.blind_zone_front,
            blind_zone_rear=args.blind_zone_rear)

    scan_limit = len(dataset) if args.scan_limit <= 0 else min(
        args.scan_limit, len(dataset))
    scan_indices = np.arange(scan_limit)
    rng = np.random.default_rng(args.seed)
    rng.shuffle(scan_indices)

    saved = 0
    for dataset_idx in scan_indices:
        dataset_idx = int(dataset_idx)
        data_info = copy.deepcopy(dataset.get_data_info(dataset_idx))
        data_info['box_type_3d'] = dataset.box_type_3d
        data_info['box_mode_3d'] = dataset.box_mode_3d
        results = dataset.pipeline(data_info)
        if results is None:
            continue

        points = results['points'].numpy()
        boxes = results['gt_bboxes_3d']
        labels = torch.from_numpy(results['gt_labels_3d'])
        point_counts = count_points_in_boxes(points, boxes)
        empty_mask = point_counts < args.min_num_points
        if not np.any(empty_mask):
            continue

        sample_idx = int(results.get('sample_idx', dataset_idx))
        output_path = (
            args.output_dir /
            f'empty_boxes_{saved:02d}_idx{dataset_idx:03d}_sample{sample_idx:05d}_'
            f'{int(empty_mask.sum())}empty.png')
        render_empty_boxes(
            points=points,
            boxes=boxes,
            labels=labels,
            point_counts=point_counts,
            class_names=class_names,
            sample_idx=sample_idx,
            dataset_idx=dataset_idx,
            output_path=output_path,
            bev_range=tuple(args.bev_range),
            max_points=args.max_points,
            seed=args.seed + saved,
            min_num_points=args.min_num_points,
            exclusion_region=exclusion_region)
        empty_classes = [
            f'{class_names[label]}({count}pts)'
            for label, count, is_empty in zip(
                labels.tolist(), point_counts.tolist(), empty_mask.tolist())
            if is_empty
        ]
        print(
            f'Saved: {output_path} | empty boxes: {", ".join(empty_classes)}')
        saved += 1
        if saved >= args.num_samples:
            break

    if saved == 0:
        raise RuntimeError(
            f'No samples with boxes containing fewer than {args.min_num_points} '
            f'points were found in the first {scan_limit} dataset items.')


if __name__ == '__main__':
    main()
