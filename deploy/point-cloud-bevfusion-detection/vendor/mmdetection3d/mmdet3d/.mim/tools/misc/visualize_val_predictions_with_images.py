#!/usr/bin/env python3
"""Visualize validation predictions on multi-camera images and BEV."""

from __future__ import annotations

import argparse
import sys
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
from mmdet3d.structures import LiDARInstance3DBoxes

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from visualize_nuscense import (  # noqa: E402
    interpolate_box_edges,
    project_camera_to_fisheye_image,
    project_camera_to_pinhole_image,
    transform_points_matrix,
)
from visualize_test_predictions import (  # noqa: E402
    CLASS_COLORS,
    build_test_dataset,
    render_panel,
)
from visualize_train_input import (  # noqa: E402
    CAMERA_CHANNELS,
    CAMERA_LABELS,
    color_to_bgr,
    downsample_points,
    draw_box_on_image,
    draw_fisheye_box_on_image,
    load_camera_image,
    resolve_camera_image_path,
)


def resolve_validation_image_path(
        data_root: Path,
        channel: str,
        img_path: str) -> Path:
    """Resolve a validation image path from dataset info."""
    configured_path = Path(img_path)
    if configured_path.is_absolute() and configured_path.is_file():
        return configured_path
    if configured_path.is_file():
        return configured_path.resolve()
    repository_relative = Path.cwd() / configured_path
    if repository_relative.is_file():
        return repository_relative.resolve()
    data_root_relative = data_root / configured_path
    if data_root_relative.is_file():
        return data_root_relative.resolve()
    return resolve_camera_image_path(data_root, channel, configured_path.name)


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description=(
            'Visualize validation predictions on four camera images and BEV.'))
    parser.add_argument(
        '--config',
        type=Path,
        required=True,
        help='Config file used for validation/testing.')
    parser.add_argument(
        '--checkpoint',
        type=Path,
        required=True,
        help='Checkpoint path for inference.')
    parser.add_argument(
        '--output-dir',
        type=Path,
        required=True,
        help='Directory to save rendered images.')
    parser.add_argument(
        '--data-root',
        type=Path,
        default=Path('data/nuscenes'),
        help='Dataset root used to resolve camera images and calibration.')
    parser.add_argument(
        '--metadata-version',
        type=str,
        default='v1.0-trainval',
        help='nuScenes metadata version folder under data-root.')
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
        help='Number of validation samples to visualize. -1 means all.')
    parser.add_argument(
        '--camera-boxes',
        type=str,
        choices=('pred', 'gt', 'both'),
        default='pred',
        help=(
            'Which boxes to draw on camera images. '
            'Use pred to avoid GT/Pred overlap; BEV always shows both.'))
    parser.add_argument(
        '--dpi',
        type=int,
        default=200,
        help='Output image DPI.')
    parser.add_argument(
        '--fig-scale',
        type=float,
        default=1.4,
        help='Scale factor applied to the default figure size.')
    return parser.parse_args()


def build_calibration_map(config_path: Path) -> dict[str, dict]:
    """Load per-camera calibration settings from the model config."""
    cfg = Config.fromfile(str(config_path))
    calibrations = cfg.model.view_transform.get('camera_calibrations', [])
    return {
        str(calibration['camera_name']): calibration
        for calibration in calibrations
    }


def distortion_dict(distortion: Sequence[float]) -> dict[str, float]:
    """Convert a distortion list to the dict format used by projection helpers."""
    return {
        'k1': float(distortion[0]),
        'k2': float(distortion[1]),
        'k3': float(distortion[2]),
        'k4': float(distortion[3]),
    }


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


def draw_boxes_on_camera_from_info(
        image: np.ndarray,
        box_corners: np.ndarray,
        labels: Sequence[int],
        class_names: Sequence[str],
        image_info: dict,
        calibration: dict,
        thickness: int) -> None:
    """Project 3D boxes to one camera image."""
    camera_model = str(calibration.get('camera_model', 'pinhole')).lower()
    for corners, label_idx in zip(box_corners, labels):
        class_name = class_names[label_idx]
        color_bgr = color_to_bgr(CLASS_COLORS.get(class_name, (0.8, 0.8, 0.8)))
        if camera_model == 'fisheye':
            projected_edges = [
                project_lidar_points_from_info(edge, image_info, calibration)
                for edge in interpolate_box_edges(corners.T, segments=16)
            ]
            draw_fisheye_box_on_image(
                image, projected_edges, color_bgr, thickness=thickness)
        else:
            projected = project_lidar_points_from_info(
                corners, image_info, calibration)
            draw_box_on_image(image, projected, color_bgr, thickness=thickness)


def draw_points_on_camera_from_info(
        image: np.ndarray,
        points: np.ndarray,
        image_info: dict,
        calibration: dict,
        max_points: int,
        rng: np.random.Generator) -> None:
    """Overlay sparse LiDAR points on one camera image."""
    visible_points = downsample_points(points, max_points, rng)
    projected = project_lidar_points_from_info(
        visible_points[:, :3], image_info, calibration)
    image_height, image_width = image.shape[:2]
    for uv in projected:
        if not np.isfinite(uv).all():
            continue
        u, v = int(round(uv[0])), int(round(uv[1]))
        if 0 <= u < image_width and 0 <= v < image_height:
            image[v, u] = (0, 255, 255)


def render_camera_with_boxes(
        axis: Axes,
        image_rgb: np.ndarray,
        points: np.ndarray,
        gt_boxes: LiDARInstance3DBoxes,
        gt_labels: torch.Tensor,
        pred_boxes: LiDARInstance3DBoxes,
        pred_labels: torch.Tensor,
        class_names: Sequence[str],
        image_info: dict,
        calibration: dict,
        channel: str,
        label: str,
        max_points: int,
        camera_boxes: str) -> None:
    """Draw one camera image with optional GT and predicted 3D boxes."""
    image_bgr = image_rgb.copy()
    rng = np.random.default_rng(0)
    draw_points_on_camera_from_info(
        image_bgr, points, image_info, calibration, max_points=max_points, rng=rng)
    if camera_boxes in ('gt', 'both') and len(gt_boxes) > 0:
        draw_boxes_on_camera_from_info(
            image_bgr,
            gt_boxes.corners.cpu().numpy(),
            gt_labels.tolist(),
            class_names,
            image_info,
            calibration,
            thickness=4)
    if camera_boxes in ('pred', 'both') and len(pred_boxes) > 0:
        draw_boxes_on_camera_from_info(
            image_bgr,
            pred_boxes.corners.cpu().numpy(),
            pred_labels.tolist(),
            class_names,
            image_info,
            calibration,
            thickness=3)
    box_legend = {
        'pred': 'Pred',
        'gt': 'GT',
        'both': 'GT solid / Pred thin',
    }[camera_boxes]
    axis.imshow(image_bgr)
    axis.set_title(
        f'{label} ({channel}) | {box_legend}',
        fontsize=12)
    axis.axis('off')


def render_validation_sample(
        points: np.ndarray,
        gt_boxes: LiDARInstance3DBoxes,
        gt_labels: torch.Tensor,
        pred_boxes: LiDARInstance3DBoxes,
        pred_labels: torch.Tensor,
        class_names: Sequence[str],
        data_info: dict,
        data_root: Path,
        calibration_map: dict[str, dict],
        sample_idx: int,
        output_path: Path,
        bev_range: tuple[float, float, float, float],
        max_points: int,
        score_thr: float,
        dpi: int,
        fig_scale: float,
        camera_boxes: str) -> None:
    """Save one validation sample with cameras and BEV panels."""
    figure_width = 28.0 * fig_scale
    figure_height = 20.0 * fig_scale
    figure = plt.figure(figsize=(figure_width, figure_height), layout='constrained')
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
        calibration = calibration_map[channel]
        render_camera_with_boxes(
            axis=axis,
            image_rgb=image_rgb,
            points=points,
            gt_boxes=gt_boxes,
            gt_labels=gt_labels,
            pred_boxes=pred_boxes,
            pred_labels=pred_labels,
            class_names=class_names,
            image_info=image_info,
            calibration=calibration,
            channel=channel,
            label=label,
            max_points=max_points,
            camera_boxes=camera_boxes)

    bev_gt_axis = figure.add_subplot(grid[2, 0])
    bev_pred_axis = figure.add_subplot(grid[2, 1])
    gt_scatter = render_panel(
        bev_gt_axis,
        points=points,
        boxes=gt_boxes,
        labels=gt_labels,
        class_names=class_names,
        title=f'GT BEV | sample {sample_idx} | {len(gt_boxes)} boxes',
        bev_range=bev_range,
        max_points=max_points,
        linestyle='-')
    render_panel(
        bev_pred_axis,
        points=points,
        boxes=pred_boxes,
        labels=pred_labels,
        class_names=class_names,
        title=(
            f'Pred BEV (score>={score_thr:.2f}) | sample {sample_idx} | '
            f'{len(pred_boxes)} boxes'),
        bev_range=bev_range,
        max_points=max_points,
        linestyle='--')
    colorbar = figure.colorbar(gt_scatter, ax=[bev_gt_axis, bev_pred_axis], shrink=0.85)
    colorbar.set_label('time_lag (s)')
    figure.suptitle(
        (
            f'Validation sample {sample_idx} | '
            f'Camera={camera_boxes}, BEV GT vs Pred'
        ),
        fontsize=18)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_path, dpi=dpi, bbox_inches='tight')
    plt.close(figure)


def main() -> None:
    """Run inference on the validation set and save image/BEV visualizations."""
    args = parse_args()
    data_root = args.data_root
    if not data_root.is_absolute():
        data_root = Path.cwd() / data_root

    dataset, cfg = build_test_dataset(args.config)
    class_names = cfg.metainfo['classes']
    calibration_map = build_calibration_map(args.config)
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
        data_info = dataset.get_data_info(index)
        output_path = (
            args.output_dir /
            f'val_{index:03d}_sample{sample_idx:05d}.png')
        render_validation_sample(
            points=points,
            gt_boxes=gt_boxes,
            gt_labels=gt_labels,
            pred_boxes=pred_boxes,
            pred_labels=pred_labels,
            class_names=class_names,
            data_info=data_info,
            data_root=data_root,
            calibration_map=calibration_map,
            sample_idx=sample_idx,
            output_path=output_path,
            bev_range=tuple(args.bev_range),
            max_points=args.max_points,
            score_thr=args.score_thr,
            dpi=args.dpi,
            fig_scale=args.fig_scale,
            camera_boxes=args.camera_boxes)
        print(
            f'Saved: {output_path} '
            f'(gt={len(gt_boxes)}, pred={len(pred_boxes)})')


if __name__ == '__main__':
    main()
