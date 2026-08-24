#!/usr/bin/env python3
"""Analyze and visualize per-class detection errors on the validation set."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Sequence

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import torch
from matplotlib.axes import Axes
from matplotlib.gridspec import GridSpec
from mmengine.config import Config
from mmengine.dataset import pseudo_collate

from mmdet3d.apis import init_model
from mmdet3d.structures import LiDARInstance3DBoxes, bbox_overlaps_nearest_3d

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from visualize_nuscense import (  # noqa: E402
    interpolate_box_edges,
    project_camera_to_fisheye_image,
    project_camera_to_pinhole_image,
    transform_points_matrix,
)
from visualize_test_predictions import build_test_dataset, downsample_points  # noqa: E402
from visualize_train_input import (  # noqa: E402
    CAMERA_CHANNELS,
    CAMERA_LABELS,
    color_to_bgr,
    draw_box_on_image,
    draw_fisheye_box_on_image,
    load_camera_image,
    resolve_camera_image_path,
)
from visualize_val_predictions_with_images import (  # noqa: E402
    build_calibration_map,
    distortion_dict,
    resolve_validation_image_path,
)

ERROR_COLORS_RGB: dict[str, tuple[float, float, float]] = {
    'fn': (1.0, 0.0, 0.0),
    'fp': (1.0, 1.0, 0.0),
    'tp_low': (1.0, 0.5, 0.0),
    'tp_good': (0.0, 0.8, 0.0),
}

ERROR_COLORS_BGR: dict[str, tuple[int, int, int]] = {
    key: color_to_bgr(value) for key, value in ERROR_COLORS_RGB.items()
}

BOX_EDGES = (
    (0, 1), (1, 2), (2, 3), (3, 0),
    (4, 5), (5, 6), (6, 7), (7, 4),
    (0, 4), (1, 5), (2, 6), (3, 7),
)


@dataclass(frozen=True)
class ClassErrorStats:
    """Per-sample error statistics for one class."""

    sample_index: int
    sample_idx: int
    gt_count: int
    pred_count: int
    fn_count: int
    fp_count: int
    tp_good_count: int
    tp_low_count: int
    mean_tp_iou: float

    @property
    def error_score(self) -> int:
        return self.fn_count + self.fp_count + self.tp_low_count


@dataclass(frozen=True)
class MatchedClassBoxes:
    """Matched GT and prediction boxes for one class."""

    fn_boxes: LiDARInstance3DBoxes
    fp_boxes: LiDARInstance3DBoxes
    tp_low_boxes: LiDARInstance3DBoxes
    tp_good_boxes: LiDARInstance3DBoxes
    stats: ClassErrorStats


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description='Analyze and visualize per-class validation errors.')
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument(
        '--data-root',
        type=Path,
        default=Path('data/nuscenes'))
    parser.add_argument('--device', type=str, default='cuda:0')
    parser.add_argument('--score-thr', type=float, default=0.25)
    parser.add_argument('--iou-thr', type=float, default=0.5)
    parser.add_argument('--target-class', type=str, default='Cone')
    parser.add_argument(
        '--top-k',
        type=int,
        default=12,
        help='Number of worst samples to visualize.')
    parser.add_argument(
        '--bev-range',
        type=float,
        nargs=4,
        default=(-21.0, 21.0, -21.0, 21.0),
        metavar=('XMIN', 'XMAX', 'YMIN', 'YMAX'))
    parser.add_argument('--max-points', type=int, default=120000)
    parser.add_argument('--dpi', type=int, default=180)
    parser.add_argument('--fig-scale', type=float, default=1.3)
    return parser.parse_args()


def filter_class_boxes(
        boxes: LiDARInstance3DBoxes,
        labels: torch.Tensor,
        class_index: int) -> LiDARInstance3DBoxes:
    """Keep boxes for one class."""
    if len(boxes) == 0:
        return boxes
    keep = labels == class_index
    if not keep.any():
        return boxes[[]]
    return boxes[keep]


def greedy_match_boxes(
        gt_boxes: LiDARInstance3DBoxes,
        pred_boxes: LiDARInstance3DBoxes,
        min_pair_iou: float) -> tuple[list[int], list[int], list[tuple[int, int, float]]]:
    """Greedy one-to-one matching by IoU."""
    gt_count = len(gt_boxes)
    pred_count = len(pred_boxes)
    if gt_count == 0:
        return [], list(range(pred_count)), []
    if pred_count == 0:
        return list(range(gt_count)), [], []

    ious = bbox_overlaps_nearest_3d(
        gt_boxes.tensor[:, :7].cpu(),
        pred_boxes.tensor[:, :7].cpu()).cpu().numpy()
    candidate_pairs: list[tuple[float, int, int]] = []
    for gt_index in range(gt_count):
        for pred_index in range(pred_count):
            iou = float(ious[gt_index, pred_index])
            if iou >= min_pair_iou:
                candidate_pairs.append((iou, gt_index, pred_index))
    candidate_pairs.sort(reverse=True)

    matched_gt: set[int] = set()
    matched_pred: set[int] = set()
    matched_pairs: list[tuple[int, int, float]] = []
    for iou, gt_index, pred_index in candidate_pairs:
        if gt_index in matched_gt or pred_index in matched_pred:
            continue
        matched_gt.add(gt_index)
        matched_pred.add(pred_index)
        matched_pairs.append((gt_index, pred_index, iou))

    fn_indices = [index for index in range(gt_count) if index not in matched_gt]
    fp_indices = [index for index in range(pred_count) if index not in matched_pred]
    return fn_indices, fp_indices, matched_pairs


def analyze_class_errors(
        gt_boxes: LiDARInstance3DBoxes,
        gt_labels: torch.Tensor,
        pred_boxes: LiDARInstance3DBoxes,
        pred_labels: torch.Tensor,
        class_index: int,
        sample_index: int,
        sample_idx: int,
        iou_thr: float) -> MatchedClassBoxes:
    """Classify GT/pred boxes into FN, FP, and TP groups."""
    class_gt = filter_class_boxes(gt_boxes, gt_labels, class_index)
    class_pred = filter_class_boxes(pred_boxes, pred_labels, class_index)
    fn_indices, fp_indices, matched_pairs = greedy_match_boxes(
        class_gt, class_pred, min_pair_iou=0.1)

    tp_low_indices: list[int] = []
    tp_good_indices: list[int] = []
    tp_ious: list[float] = []
    for _, pred_index, iou in matched_pairs:
        tp_ious.append(iou)
        if iou >= iou_thr:
            tp_good_indices.append(pred_index)
        else:
            tp_low_indices.append(pred_index)

    fn_boxes = class_gt[fn_indices] if fn_indices else class_gt[[]]
    fp_boxes = class_pred[fp_indices] if fp_indices else class_pred[[]]
    tp_low_boxes = (
        class_pred[tp_low_indices] if tp_low_indices else class_pred[[]])
    tp_good_boxes = (
        class_pred[tp_good_indices] if tp_good_indices else class_pred[[]])

    mean_tp_iou = float(np.mean(tp_ious)) if tp_ious else 0.0
    stats = ClassErrorStats(
        sample_index=sample_index,
        sample_idx=sample_idx,
        gt_count=len(class_gt),
        pred_count=len(class_pred),
        fn_count=len(fn_indices),
        fp_count=len(fp_indices),
        tp_good_count=len(tp_good_indices),
        tp_low_count=len(tp_low_indices),
        mean_tp_iou=mean_tp_iou)
    return MatchedClassBoxes(
        fn_boxes=fn_boxes,
        fp_boxes=fp_boxes,
        tp_low_boxes=tp_low_boxes,
        tp_good_boxes=tp_good_boxes,
        stats=stats)


def project_lidar_points_from_info(
        points_lidar: np.ndarray,
        image_info: dict,
        calibration: dict) -> np.ndarray:
    """Project LiDAR-frame points using pkl lidar2cam and config intrinsics."""
    lidar_to_camera = np.asarray(image_info['lidar2cam'], dtype=np.float64)
    points_camera = transform_points_matrix(points_lidar, lidar_to_camera)
    intrinsic = np.asarray(calibration['camera_intrinsic'], dtype=np.float64)
    fx = float(intrinsic[0, 0])
    fy = float(intrinsic[1, 1])
    cx = float(intrinsic[0, 2])
    cy = float(intrinsic[1, 2])
    camera_model = str(calibration.get('camera_model', 'pinhole')).lower()
    if camera_model == 'fisheye':
        return project_camera_to_fisheye_image(
            points_camera,
            fx,
            fy,
            cx,
            cy,
            distortion_dict(calibration['distortion']))
    return project_camera_to_pinhole_image(points_camera, fx, fy, cx, cy)


def draw_boxes_on_camera(
        image: np.ndarray,
        boxes: LiDARInstance3DBoxes,
        image_info: dict,
        calibration: dict,
        color_bgr: tuple[int, int, int],
        thickness: int) -> None:
    """Project and draw 3D boxes on one camera image."""
    if len(boxes) == 0:
        return
    camera_model = str(calibration.get('camera_model', 'pinhole')).lower()
    corners = boxes.corners.cpu().numpy()
    for box_corners in corners:
        if camera_model == 'fisheye':
            projected_edges = [
                project_lidar_points_from_info(edge, image_info, calibration)
                for edge in interpolate_box_edges(box_corners.T, segments=16)
            ]
            draw_fisheye_box_on_image(
                image, projected_edges, color_bgr, thickness=thickness)
        else:
            projected = project_lidar_points_from_info(
                box_corners, image_info, calibration)
            draw_box_on_image(
                image, projected, color_bgr, thickness=thickness)


def draw_error_boxes_bev(
        axis: Axes,
        boxes: LiDARInstance3DBoxes,
        color: tuple[float, float, float],
        linestyle: str,
        label: str | None,
        linewidth: float) -> None:
    """Draw error-colored boxes on a BEV axis."""
    if len(boxes) == 0:
        return
    corners = boxes.corners.cpu().numpy()
    for box_corners in corners:
        bottom_face = [0, 3, 7, 4, 0]
        axis.plot(
            box_corners[bottom_face, 0],
            box_corners[bottom_face, 1],
            color=color,
            linewidth=linewidth,
            linestyle=linestyle,
            label=label)
        axis.plot(
            [box_corners[4, 0], box_corners[7, 0]],
            [box_corners[4, 1], box_corners[7, 1]],
            color=color,
            linewidth=linewidth + 0.5,
            linestyle=linestyle)
        label = None


def render_error_bev(
        axis: Axes,
        points: np.ndarray,
        matched: MatchedClassBoxes,
        title: str,
        bev_range: tuple[float, float, float, float],
        max_points: int) -> None:
    """Render one BEV panel with error-colored boxes."""
    x_min, x_max, y_min, y_max = bev_range
    visible_points = downsample_points(points, max_points)
    mask = (
        (visible_points[:, 0] >= x_min) & (visible_points[:, 0] <= x_max) &
        (visible_points[:, 1] >= y_min) & (visible_points[:, 1] <= y_max))
    visible_points = visible_points[mask]
    axis.scatter(
        visible_points[:, 0],
        visible_points[:, 1],
        c=visible_points[:, 4],
        cmap='gray',
        s=0.15,
        alpha=0.5,
        vmin=0)
    draw_error_boxes_bev(
        axis, matched.fn_boxes, ERROR_COLORS_RGB['fn'], '-', 'FN missed', 2.5)
    draw_error_boxes_bev(
        axis, matched.fp_boxes, ERROR_COLORS_RGB['fp'], '--', 'FP false', 2.0)
    draw_error_boxes_bev(
        axis, matched.tp_low_boxes, ERROR_COLORS_RGB['tp_low'], '-',
        f'TP low IoU', 2.0)
    draw_error_boxes_bev(
        axis, matched.tp_good_boxes, ERROR_COLORS_RGB['tp_good'], '-',
        f'TP good', 2.0)
    axis.set_xlim(x_min, x_max)
    axis.set_ylim(y_min, y_max)
    axis.set_aspect('equal', adjustable='box')
    axis.set_xlabel('X (m)')
    axis.set_ylabel('Y (m)')
    axis.grid(True, linestyle='--', alpha=0.3)
    axis.set_title(title, fontsize=12)
    axis.legend(loc='upper right', fontsize=9)


def render_camera_panel(
        axis: Axes,
        image_rgb: np.ndarray,
        matched: MatchedClassBoxes,
        image_info: dict,
        calibration: dict,
        channel: str,
        label: str) -> None:
    """Draw one camera image with error-colored class boxes."""
    image_bgr = image_rgb.copy()
    draw_boxes_on_camera(
        image_bgr, matched.fn_boxes, image_info, calibration,
        ERROR_COLORS_BGR['fn'], thickness=4)
    draw_boxes_on_camera(
        image_bgr, matched.fp_boxes, image_info, calibration,
        ERROR_COLORS_BGR['fp'], thickness=3)
    draw_boxes_on_camera(
        image_bgr, matched.tp_low_boxes, image_info, calibration,
        ERROR_COLORS_BGR['tp_low'], thickness=3)
    draw_boxes_on_camera(
        image_bgr, matched.tp_good_boxes, image_info, calibration,
        ERROR_COLORS_BGR['tp_good'], thickness=2)
    axis.imshow(image_bgr)
    axis.set_title(f'{label} ({channel})', fontsize=11)
    axis.axis('off')


def render_error_sample(
        points: np.ndarray,
        matched: MatchedClassBoxes,
        data_info: dict,
        data_root: Path,
        calibration_map: dict[str, dict],
        target_class: str,
        output_path: Path,
        bev_range: tuple[float, float, float, float],
        max_points: int,
        score_thr: float,
        iou_thr: float,
        dpi: int,
        fig_scale: float) -> None:
    """Save one error-analysis visualization."""
    stats = matched.stats
    figure = plt.figure(
        figsize=(28.0 * fig_scale, 20.0 * fig_scale), layout='constrained')
    grid = GridSpec(3, 2, figure=figure, height_ratios=[1.0, 1.0, 1.0])
    camera_axes = [
        figure.add_subplot(grid[0, 0]),
        figure.add_subplot(grid[0, 1]),
        figure.add_subplot(grid[1, 0]),
        figure.add_subplot(grid[1, 1]),
    ]
    for axis, channel, label in zip(camera_axes, CAMERA_CHANNELS, CAMERA_LABELS):
        image_info = data_info['images'][channel]
        image_path = resolve_validation_image_path(
            data_root, channel, image_info['img_path'])
        image_rgb = load_camera_image(image_path)
        render_camera_panel(
            axis=axis,
            image_rgb=image_rgb,
            matched=matched,
            image_info=image_info,
            calibration=calibration_map[channel],
            channel=channel,
            label=label)

    bev_axis = figure.add_subplot(grid[2, :])
    render_error_bev(
        bev_axis,
        points=points,
        matched=matched,
        title=(
            f'{target_class} errors | sample {stats.sample_idx} | '
            f'GT={stats.gt_count} Pred={stats.pred_count} | '
            f'FN={stats.fn_count} FP={stats.fp_count} '
            f'TP_good={stats.tp_good_count} TP_low={stats.tp_low_count} '
            f'(IoU thr={iou_thr:.2f}, score>={score_thr:.2f})'),
        bev_range=bev_range,
        max_points=max_points)
    figure.suptitle(
        (
            f'{target_class} error analysis | sample {stats.sample_idx} | '
            f'Red=FN missed, Yellow=FP, Orange=TP low IoU, Green=TP good'
        ),
        fontsize=16)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_path, dpi=dpi, bbox_inches='tight')
    plt.close(figure)


def print_summary(
        all_stats: Sequence[ClassErrorStats],
        target_class: str,
        iou_thr: float) -> None:
    """Print aggregate error statistics."""
    total_gt = sum(item.gt_count for item in all_stats)
    total_pred = sum(item.pred_count for item in all_stats)
    total_fn = sum(item.fn_count for item in all_stats)
    total_fp = sum(item.fp_count for item in all_stats)
    total_tp_good = sum(item.tp_good_count for item in all_stats)
    total_tp_low = sum(item.tp_low_count for item in all_stats)
    recall = total_tp_good / total_gt if total_gt > 0 else 0.0
    precision = (
        total_tp_good / total_pred if total_pred > 0 else 0.0)
    print('=' * 72)
    print(f'{target_class} validation error summary (IoU thr={iou_thr:.2f})')
    print('=' * 72)
    print(f'GT total      : {total_gt}')
    print(f'Pred total    : {total_pred}')
    print(f'TP good       : {total_tp_good}')
    print(f'TP low IoU    : {total_tp_low}')
    print(f'FN missed     : {total_fn}')
    print(f'FP false      : {total_fp}')
    print(f'Recall@IoU    : {recall:.3f}  ({total_tp_good}/{total_gt})')
    print(f'Precision@IoU : {precision:.3f}  ({total_tp_good}/{total_pred})')
    print('-' * 72)
    print('Worst samples (FN+FP+TP_low):')
    ranked = sorted(all_stats, key=lambda item: item.error_score, reverse=True)
    for item in ranked[:15]:
        if item.gt_count == 0 and item.pred_count == 0:
            continue
        print(
            f'  val_{item.sample_index:03d} sample{item.sample_idx:05d} | '
            f'GT={item.gt_count:2d} Pred={item.pred_count:2d} | '
            f'FN={item.fn_count:2d} FP={item.fp_count:2d} '
            f'TP_good={item.tp_good_count:2d} TP_low={item.tp_low_count:2d} '
            f'mean_tp_iou={item.mean_tp_iou:.2f}')


def main() -> None:
    """Run class error analysis and save visualizations."""
    args = parse_args()
    data_root = args.data_root
    if not data_root.is_absolute():
        data_root = Path.cwd() / data_root

    dataset, cfg = build_test_dataset(args.config)
    class_names = cfg.metainfo['classes']
    if args.target_class not in class_names:
        raise ValueError(
            f'target_class={args.target_class!r} not in classes={class_names}')
    class_index = class_names.index(args.target_class)
    calibration_map = build_calibration_map(args.config)
    model = init_model(
        str(args.config),
        str(args.checkpoint),
        device=args.device)

    all_stats: list[ClassErrorStats] = []
    matched_by_index: dict[int, MatchedClassBoxes] = {}

    for index in range(len(dataset)):
        item = dataset[index]
        batch = pseudo_collate([item])
        with torch.inference_mode():
            results = model.test_step(batch)
        data_sample = results[0]
        eval_ann_info = item['data_samples'].eval_ann_info
        gt_boxes = eval_ann_info['gt_bboxes_3d']
        gt_labels = torch.as_tensor(eval_ann_info['gt_labels_3d'])
        pred_instances = data_sample.pred_instances_3d
        keep = pred_instances.scores_3d > args.score_thr
        pred_boxes = pred_instances.bboxes_3d[keep]
        pred_labels = pred_instances.labels_3d[keep]
        sample_idx = int(data_sample.sample_idx)
        matched = analyze_class_errors(
            gt_boxes=gt_boxes,
            gt_labels=gt_labels,
            pred_boxes=pred_boxes,
            pred_labels=pred_labels,
            class_index=class_index,
            sample_index=index,
            sample_idx=sample_idx,
            iou_thr=args.iou_thr)
        all_stats.append(matched.stats)
        matched_by_index[index] = matched

    print_summary(all_stats, args.target_class, args.iou_thr)

    ranked = sorted(all_stats, key=lambda item: item.error_score, reverse=True)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    summary_path = args.output_dir / f'{args.target_class.lower()}_error_summary.json'
    summary_path.write_text(
        json.dumps([asdict(item) for item in ranked], indent=2),
        encoding='utf-8')

    visualized = 0
    for stats in ranked:
        if visualized >= args.top_k:
            break
        if stats.gt_count == 0 and stats.pred_count == 0:
            continue
        item = dataset[stats.sample_index]
        points = item['inputs']['points'].numpy()
        data_info = dataset.get_data_info(stats.sample_index)
        output_path = (
            args.output_dir /
            f'{args.target_class.lower()}_err_{stats.sample_index:03d}_'
            f'sample{stats.sample_idx:05d}.png')
        render_error_sample(
            points=points,
            matched=matched_by_index[stats.sample_index],
            data_info=data_info,
            data_root=data_root,
            calibration_map=calibration_map,
            target_class=args.target_class,
            output_path=output_path,
            bev_range=tuple(args.bev_range),
            max_points=args.max_points,
            score_thr=args.score_thr,
            iou_thr=args.iou_thr,
            dpi=args.dpi,
            fig_scale=args.fig_scale)
        print(f'Saved: {output_path}')
        visualized += 1


if __name__ == '__main__':
    main()
