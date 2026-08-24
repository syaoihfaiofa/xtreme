#!/usr/bin/env python3
"""Evaluate validation-set detection metrics within a planar range."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

import numpy as np
import torch
from mmengine.config import Config
from mmengine.dataset import pseudo_collate
from mmengine.logging import MMLogger
from mmengine.registry import init_default_scope
from terminaltables import AsciiTable

from mmdet3d.apis import init_model
from mmdet3d.evaluation.functional.indoor_eval import indoor_eval
from mmdet3d.structures import LiDARInstance3DBoxes, get_box_type

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from visualize_test_predictions import build_test_dataset  # noqa: E402


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description=(
            'Evaluate validation metrics for boxes whose BEV center is within '
            'a given planar distance from the ego origin.'))
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--device', type=str, default='cuda:0')
    parser.add_argument(
        '--max-range',
        type=float,
        default=8.0,
        help='Keep boxes with planar center distance <= this value (meters).')
    parser.add_argument(
        '--compare-full',
        action='store_true',
        help='Also evaluate the full validation set without range filtering.')
    parser.add_argument(
        '--iou-thr',
        type=float,
        nargs='+',
        default=[0.25, 0.5, 0.7],
        help='IoU thresholds, matching IndoorMetric defaults.')
    parser.add_argument(
        '--score-thr',
        type=float,
        default=None,
        help='Optional extra score filter applied after model inference.')
    parser.add_argument(
        '--output-json',
        type=Path,
        default=None,
        help='Optional path to save numeric results as JSON.')
    return parser.parse_args()


def planar_center_distance(boxes: LiDARInstance3DBoxes) -> np.ndarray:
    """Return planar distance from ego origin for each box center."""
    if len(boxes) == 0:
        return np.zeros((0,), dtype=np.float64)
    centers = boxes.gravity_center[:, :2].detach().cpu().numpy()
    return np.linalg.norm(centers, axis=1)


def filter_boxes_by_planar_range(
        boxes: LiDARInstance3DBoxes,
        labels: Sequence[int] | torch.Tensor,
        max_range: float,
        scores: torch.Tensor | None = None) -> tuple[
            LiDARInstance3DBoxes, Sequence[int] | torch.Tensor,
            torch.Tensor | None, np.ndarray]:
    """Keep boxes whose BEV center lies within max_range meters."""
    if len(boxes) == 0:
        empty_mask = np.zeros((0,), dtype=bool)
        return boxes, labels, scores, empty_mask
    distances = planar_center_distance(boxes)
    keep = distances <= max_range
    keep_tensor = torch.as_tensor(keep)
    filtered_scores = scores[keep_tensor] if scores is not None else None
    if isinstance(labels, torch.Tensor):
        filtered_labels: Sequence[int] | torch.Tensor = labels[keep_tensor]
    else:
        filtered_labels = [
            label for label, is_kept in zip(labels, keep.tolist()) if is_kept]
    return boxes[keep_tensor], filtered_labels, filtered_scores, keep


def count_boxes_by_class(
        boxes_list: Sequence[LiDARInstance3DBoxes],
        labels_list: Sequence[Sequence[int] | torch.Tensor],
        class_names: Sequence[str]) -> dict[str, int]:
    """Count boxes per class across all samples."""
    counts = {class_name: 0 for class_name in class_names}
    for boxes, labels in zip(boxes_list, labels_list):
        if len(boxes) == 0:
            continue
        if isinstance(labels, torch.Tensor):
            label_values = labels.detach().cpu().tolist()
        else:
            label_values = list(labels)
        for label_idx in label_values:
            counts[class_names[int(label_idx)]] += 1
    return counts


def collect_predictions(
        config_path: Path,
        checkpoint_path: Path,
        device: str,
        score_thr: float | None) -> tuple[list[dict], list[dict], list[str], str]:
    """Run inference on the validation set and collect GT/pred pairs."""
    dataset, cfg = build_test_dataset(config_path)
    class_names = cfg.metainfo['classes']
    box_type_3d = cfg.metainfo.get('box_type_3d', 'LiDAR')
    model = init_model(str(config_path), str(checkpoint_path), device=device)

    gt_annos: list[dict] = []
    pred_annos: list[dict] = []
    for index in range(len(dataset)):
        item = dataset[index]
        batch = pseudo_collate([item])
        with torch.inference_mode():
            results = model.test_step(batch)
        data_sample = results[0]
        eval_ann_info = item['data_samples'].eval_ann_info
        gt_boxes = eval_ann_info['gt_bboxes_3d']
        gt_labels = [int(label) for label in eval_ann_info['gt_labels_3d']]

        pred_instances = data_sample.pred_instances_3d
        pred_boxes = pred_instances.bboxes_3d.to('cpu')
        pred_labels = pred_instances.labels_3d.cpu()
        pred_scores = pred_instances.scores_3d.cpu()
        if score_thr is not None:
            keep = pred_scores > score_thr
            pred_boxes = pred_boxes[keep]
            pred_labels = pred_labels[keep]
            pred_scores = pred_scores[keep]

        gt_annos.append({
            'gt_bboxes_3d': gt_boxes,
            'gt_labels_3d': gt_labels,
        })
        pred_annos.append({
            'labels_3d': pred_labels,
            'bboxes_3d': pred_boxes,
            'scores_3d': pred_scores,
        })
    return gt_annos, pred_annos, class_names, box_type_3d


def apply_range_filter(
        gt_annos: list[dict],
        pred_annos: list[dict],
        max_range: float) -> tuple[list[dict], list[dict]]:
    """Filter GT and predictions to boxes inside the planar range."""
    filtered_gt: list[dict] = []
    filtered_pred: list[dict] = []
    for gt_anno, pred_anno in zip(gt_annos, pred_annos):
        gt_boxes, gt_labels, _, _ = filter_boxes_by_planar_range(
            gt_anno['gt_bboxes_3d'],
            gt_anno['gt_labels_3d'],
            max_range)
        pred_boxes, pred_labels, pred_scores, _ = filter_boxes_by_planar_range(
            pred_anno['bboxes_3d'],
            pred_anno['labels_3d'],
            max_range,
            pred_anno['scores_3d'])
        filtered_gt.append({
            'gt_bboxes_3d': gt_boxes,
            'gt_labels_3d': gt_labels,
        })
        filtered_pred.append({
            'labels_3d': pred_labels,
            'bboxes_3d': pred_boxes,
            'scores_3d': pred_scores,
        })
    return filtered_gt, filtered_pred


def run_indoor_metric(
        gt_annos: list[dict],
        pred_annos: list[dict],
        class_names: Sequence[str],
        box_type_3d: str,
        iou_thr: Sequence[float],
        logger: MMLogger,
        title: str) -> dict[str, float]:
    """Compute IndoorMetric-style AP/AR and print a summary table."""
    _, box_mode_3d = get_box_type(box_type_3d)
    print(f'\n{"=" * 72}\n{title}\n{"=" * 72}')
    gt_counts = count_boxes_by_class(
        [anno['gt_bboxes_3d'] for anno in gt_annos],
        [anno['gt_labels_3d'] for anno in gt_annos],
        class_names)
    pred_counts = count_boxes_by_class(
        [anno['bboxes_3d'] for anno in pred_annos],
        [anno['labels_3d'] for anno in pred_annos],
        class_names)
    count_header = ['class', 'gt_count', 'pred_count']
    count_rows = [
        [class_name, gt_counts[class_name], pred_counts[class_name]]
        for class_name in class_names
    ]
    count_table = AsciiTable([count_header, *count_rows])
    print(count_table.table)

    metrics = indoor_eval(
        gt_annos,
        pred_annos,
        list(iou_thr),
        tuple(class_names),
        logger=logger,
        box_mode_3d=box_mode_3d)
    return {key: float(value) for key, value in metrics.items()}


def main() -> None:
    """Evaluate validation metrics inside a planar range."""
    args = parse_args()
    logger = MMLogger.get_instance('evaluate_val_within_range')

    gt_annos, pred_annos, class_names, box_type_3d = collect_predictions(
        args.config,
        args.checkpoint,
        args.device,
        args.score_thr)

    results: dict[str, object] = {
        'config': str(args.config),
        'checkpoint': str(args.checkpoint),
        'max_range_m': args.max_range,
        'iou_thr': list(args.iou_thr),
        'score_thr': args.score_thr,
        'num_samples': len(gt_annos),
        'class_names': list(class_names),
    }

    if args.compare_full:
        full_metrics = run_indoor_metric(
            gt_annos,
            pred_annos,
            class_names,
            box_type_3d,
            args.iou_thr,
            logger,
            title='Full validation set metrics')
        results['full'] = full_metrics

    filtered_gt, filtered_pred = apply_range_filter(
        gt_annos, pred_annos, args.max_range)
    range_metrics = run_indoor_metric(
        filtered_gt,
        filtered_pred,
        class_names,
        box_type_3d,
        args.iou_thr,
        logger,
        title=(
            f'Validation metrics within {args.max_range:.1f} m '
            f'(planar center distance)'))
    results['within_range'] = range_metrics

    if args.output_json is not None:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(
            json.dumps(results, indent=2, allow_nan=False, default=str),
            encoding='utf-8')
        print(f'\nSaved metrics JSON: {args.output_json}')


if __name__ == '__main__':
    main()
