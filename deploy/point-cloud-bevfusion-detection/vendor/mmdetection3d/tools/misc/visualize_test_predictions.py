#!/usr/bin/env python3
"""Visualize model predictions on the test set in BEV."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import torch
from matplotlib.axes import Axes
from mmengine.config import Config
from mmengine.dataset import pseudo_collate
from mmengine.registry import init_default_scope

from mmdet3d.apis import init_model
from mmdet3d.registry import DATASETS
from mmdet3d.structures import LiDARInstance3DBoxes


CLASS_COLORS: dict[str, tuple[float, float, float]] = {
    'Car': (0.0, 0.6, 1.0),
    'Cone': (1.0, 0.5, 0.0),
    'Pillar': (0.6, 0.2, 0.8),
}


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Visualize BEVFusion test predictions on the test set.')
    parser.add_argument(
        '--config',
        type=Path,
        required=True,
        help='Config file used for testing.')
    parser.add_argument(
        '--checkpoint',
        type=Path,
        required=True,
        help='Checkpoint path for inference.')
    parser.add_argument(
        '--output-dir',
        type=Path,
        required=True,
        help='Directory to save rendered BEV images.')
    parser.add_argument(
        '--device',
        type=str,
        default='cuda:0',
        help='Inference device.')
    parser.add_argument(
        '--score-thr',
        type=float,
        default=0.25,
        help='Score threshold for predicted boxes.')
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
        '--num-samples',
        type=int,
        default=-1,
        help='Number of samples to visualize. -1 means all test samples.')
    return parser.parse_args()


def build_test_dataset(config_path: Path):
    """Build the test dataset from config."""
    cfg = Config.fromfile(str(config_path))
    init_default_scope(cfg.get('default_scope', 'mmdet3d'))
    dataset_cfg = cfg.test_dataloader.dataset.copy()
    dataset_cfg['test_mode'] = True
    return DATASETS.build(dataset_cfg), cfg


def downsample_points(points: np.ndarray, max_points: int) -> np.ndarray:
    """Return at most max_points selected without replacement."""
    if len(points) <= max_points:
        return points
    indices = np.random.default_rng(0).choice(
        len(points), size=max_points, replace=False)
    return points[indices]


def draw_box_bev(
        axis: Axes,
        box_corners: np.ndarray,
        color: tuple[float, float, float],
        label: str | None = None,
        linestyle: str = '-') -> None:
    """Draw one 3D box projected to BEV."""
    bottom_face = [0, 3, 7, 4, 0]
    axis.plot(
        box_corners[bottom_face, 0],
        box_corners[bottom_face, 1],
        color=color,
        linewidth=1.5,
        linestyle=linestyle,
        label=label)
    axis.plot(
        [box_corners[4, 0], box_corners[7, 0]],
        [box_corners[4, 1], box_corners[7, 1]],
        color=color,
        linewidth=2.5,
        linestyle=linestyle)


def draw_boxes(
        axis: Axes,
        boxes: LiDARInstance3DBoxes,
        labels: torch.Tensor,
        class_names: Sequence[str],
        linestyle: str) -> set[str]:
    """Draw all boxes on one axis and return legend labels."""
    used_labels: set[str] = set()
    if len(boxes) == 0:
        return used_labels
    corners = boxes.corners.cpu().numpy()
    for box_corners, label_idx in zip(corners, labels.tolist()):
        class_name = class_names[label_idx]
        color = CLASS_COLORS.get(class_name, (0.8, 0.8, 0.8))
        legend_label = class_name if class_name not in used_labels else None
        if legend_label is not None:
            used_labels.add(class_name)
        draw_box_bev(
            axis,
            box_corners,
            color=color,
            label=legend_label,
            linestyle=linestyle)
    return used_labels


def render_panel(
        axis: Axes,
        points: np.ndarray,
        boxes: LiDARInstance3DBoxes,
        labels: torch.Tensor,
        class_names: Sequence[str],
        title: str,
        bev_range: tuple[float, float, float, float],
        max_points: int,
        linestyle: str) -> None:
    """Render one BEV panel."""
    x_min, x_max, y_min, y_max = bev_range
    visible_points = downsample_points(points, max_points)
    mask = (
        (visible_points[:, 0] >= x_min) & (visible_points[:, 0] <= x_max) &
        (visible_points[:, 1] >= y_min) & (visible_points[:, 1] <= y_max))
    visible_points = visible_points[mask]

    scatter = axis.scatter(
        visible_points[:, 0],
        visible_points[:, 1],
        c=visible_points[:, 4],
        cmap='viridis',
        s=0.2,
        alpha=0.7,
        vmin=0)
    used_labels = draw_boxes(
        axis, boxes, labels, class_names, linestyle=linestyle)
    axis.set_xlim(x_min, x_max)
    axis.set_ylim(y_min, y_max)
    axis.set_aspect('equal', adjustable='box')
    axis.set_xlabel('X (m)')
    axis.set_ylabel('Y (m)')
    axis.grid(True, linestyle='--', alpha=0.3)
    axis.set_title(title)
    if used_labels:
        axis.legend(loc='upper right', fontsize=8)
    return scatter


def render_sample(
        points: np.ndarray,
        gt_boxes: LiDARInstance3DBoxes,
        gt_labels: torch.Tensor,
        pred_boxes: LiDARInstance3DBoxes,
        pred_labels: torch.Tensor,
        class_names: Sequence[str],
        sample_idx: int,
        output_path: Path,
        bev_range: tuple[float, float, float, float],
        max_points: int,
        score_thr: float) -> None:
    """Save one side-by-side GT / prediction BEV image."""
    figure, axes = plt.subplots(
        1, 2, figsize=(18, 9), layout='constrained')
    gt_scatter = render_panel(
        axes[0],
        points=points,
        boxes=gt_boxes,
        labels=gt_labels,
        class_names=class_names,
        title=f'GT | sample {sample_idx} | {len(gt_boxes)} boxes',
        bev_range=bev_range,
        max_points=max_points,
        linestyle='-')
    render_panel(
        axes[1],
        points=points,
        boxes=pred_boxes,
        labels=pred_labels,
        class_names=class_names,
        title=(
            f'Pred (score>={score_thr:.2f}) | sample {sample_idx} | '
            f'{len(pred_boxes)} boxes'),
        bev_range=bev_range,
        max_points=max_points,
        linestyle='--')
    colorbar = figure.colorbar(gt_scatter, ax=axes, shrink=0.85)
    colorbar.set_label('time_lag (s)')
    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_path, dpi=150, bbox_inches='tight')
    plt.close(figure)


def main() -> None:
    """Run inference on the test set and save BEV visualizations."""
    args = parse_args()
    dataset, cfg = build_test_dataset(args.config)
    class_names = cfg.metainfo['classes']
    model = init_model(
        str(args.config),
        str(args.checkpoint),
        device=args.device)

    num_samples = len(dataset) if args.num_samples < 0 else min(
        args.num_samples, len(dataset))
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for index in range(num_samples):
        item = dataset[index]
        batch = pseudo_collate([item])
        with torch.inference_mode():
            results = model.test_step(batch)
        data_sample = results[0]
        points = item['inputs']['points'].numpy()
        eval_ann_info = item['data_samples'].eval_ann_info
        gt_boxes = eval_ann_info['gt_bboxes_3d']
        gt_labels = torch.as_tensor(eval_ann_info['gt_labels_3d'])
        pred_instances = data_sample.pred_instances_3d
        keep = pred_instances.scores_3d > args.score_thr
        pred_boxes = pred_instances.bboxes_3d[keep]
        pred_labels = pred_instances.labels_3d[keep]
        sample_idx = int(data_sample.sample_idx)
        output_path = (
            args.output_dir /
            f'test_{index:03d}_sample{sample_idx:05d}.png')
        render_sample(
            points=points,
            gt_boxes=gt_boxes,
            gt_labels=gt_labels,
            pred_boxes=pred_boxes,
            pred_labels=pred_labels,
            class_names=class_names,
            sample_idx=sample_idx,
            output_path=output_path,
            bev_range=tuple(args.bev_range),
            max_points=args.max_points,
            score_thr=args.score_thr)
        print(
            f'Saved: {output_path} '
            f'(gt={len(gt_boxes)}, pred={len(pred_boxes)})')


if __name__ == '__main__':
    main()
