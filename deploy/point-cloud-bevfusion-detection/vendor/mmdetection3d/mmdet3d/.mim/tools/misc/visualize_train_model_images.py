#!/usr/bin/env python3
"""Visualize augmented multi-view images fed to the model during training."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import torch
from mmengine.config import Config
from mmengine.registry import init_default_scope

from mmdet3d.registry import DATASETS

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

CAMERA_CHANNELS: tuple[str, ...] = (
    'CAM_FRONT',
    'CAM_LEFT',
    'CAM_BACK',
    'CAM_RIGHT',
)
CAMERA_LABELS: tuple[str, ...] = (
    'Front',
    'Left',
    'Back',
    'Right',
)


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description=(
            'Visualize multi-view images after the training pipeline '
            '(ImageAug3D resize/crop/rotate).'))
    parser.add_argument(
        '--config',
        type=Path,
        default=Path(
            'projects/BEVFusion/configs/'
            'bevfusion_lidar-cam_voxel0075_custom-nus-3class.py'))
    parser.add_argument(
        '--output-dir',
        type=Path,
        default=Path('outputs/vis/train-model-images'))
    parser.add_argument('--num-samples', type=int, default=8)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--dpi', type=int, default=150)
    parser.add_argument('--fig-scale', type=float, default=1.2)
    return parser.parse_args()


def build_train_dataset(config_path: Path):
    """Build the inner training dataset with the configured train pipeline."""
    cfg = Config.fromfile(str(config_path))
    init_default_scope(cfg.get('default_scope', 'mmdet3d'))
    dataset_cfg = cfg.train_dataloader.dataset.copy()
    if dataset_cfg['type'] == 'CBGSDataset':
        dataset_cfg = dataset_cfg['dataset']
    if dataset_cfg['type'] == 'RepeatDataset':
        dataset_cfg = dataset_cfg['dataset']
    return DATASETS.build(dataset_cfg), cfg


def tensor_to_rgb(image_chw: torch.Tensor) -> np.ndarray:
    """Convert one CHW float image tensor to uint8 HWC RGB."""
    image = image_chw.detach().cpu().numpy()
    if image.shape[0] != 3:
        raise ValueError(f'Expected CHW with 3 channels, got shape {image.shape}')
    image_hwc = np.transpose(image, (1, 2, 0))
    image_hwc = np.clip(image_hwc, 0.0, 255.0).astype(np.uint8)
    return image_hwc


def render_model_images(
        images: torch.Tensor,
        sample_idx: int,
        output_path: Path,
        dpi: int,
        fig_scale: float) -> None:
    """Save a 2x2 grid of model-input images."""
    if images.ndim != 4 or images.shape[0] != 4:
        raise ValueError(
            f'Expected image tensor shape (4, 3, H, W), got {tuple(images.shape)}')
    height, width = int(images.shape[2]), int(images.shape[3])
    figure, axes = plt.subplots(
        2, 2,
        figsize=(width / 100.0 * fig_scale, height / 100.0 * fig_scale),
        layout='constrained')
    for axis, channel, label, camera_index in zip(
            axes.flatten(), CAMERA_CHANNELS, CAMERA_LABELS, range(4)):
        image_rgb = tensor_to_rgb(images[camera_index])
        axis.imshow(image_rgb)
        axis.set_title(f'{label} ({channel})', fontsize=11)
        axis.axis('off')
    figure.suptitle(
        (
            f'Train model input images | sample {sample_idx} | '
            f'shape=({images.shape[0]}, 3, {height}, {width}) | '
            f'ImageAug3D output'
        ),
        fontsize=13)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(output_path, dpi=dpi, bbox_inches='tight')
    plt.close(figure)


def main() -> None:
    """Render augmented training images actually fed to the image backbone."""
    args = parse_args()
    dataset, _ = build_train_dataset(args.config)
    rng = np.random.default_rng(args.seed)
    indices = rng.choice(len(dataset), size=args.num_samples, replace=False)

    for plot_idx, dataset_idx in enumerate(indices):
        item = dataset[int(dataset_idx)]
        images = item['inputs']['img']
        sample_idx = int(item['data_samples'].sample_idx)
        output_path = (
            args.output_dir /
            f'train_model_img_{plot_idx:02d}_idx{dataset_idx:03d}_'
            f'sample{sample_idx:05d}.png')
        render_model_images(
            images=images,
            sample_idx=sample_idx,
            output_path=output_path,
            dpi=args.dpi,
            fig_scale=args.fig_scale)
        print(
            f'Saved: {output_path} | shape={tuple(images.shape)} '
            f'range=[{float(images.min()):.1f}, {float(images.max()):.1f}]')


if __name__ == '__main__':
    main()
