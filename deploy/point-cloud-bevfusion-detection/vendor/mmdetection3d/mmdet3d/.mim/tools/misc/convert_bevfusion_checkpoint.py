# Copyright (c) OpenMMLab. All rights reserved.
"""Convert BEVFusion checkpoints from spconv2 layout to spconv1 layout.

Official BEVFusion checkpoints store sparse-conv weights as
(out, kD, kH, kW, in), while mmcv/spconv1 expects (kD, kH, kW, in, out).
"""
import argparse
from pathlib import Path
from typing import Dict, Tuple

import torch


def convert_spconv_weight(weight: torch.Tensor) -> torch.Tensor:
    """Convert a 5D sparse-conv weight tensor to spconv1 layout."""
    if weight.ndim != 5:
        raise ValueError(
            f'Expected a 5D sparse-conv weight, got shape {tuple(weight.shape)}')
    return weight.permute(1, 2, 3, 4, 0).contiguous()


def should_convert_middle_encoder_weight(key: str, tensor: torch.Tensor) -> bool:
    """Return whether a checkpoint tensor needs spconv layout conversion."""
    if not key.startswith('pts_middle_encoder.'):
        return False
    if not key.endswith('.weight'):
        return False
    if tensor.ndim != 5:
        return False
    return True


def convert_state_dict(state_dict: Dict[str, torch.Tensor]) -> Tuple[Dict[str, torch.Tensor], int]:
    """Convert pts_middle_encoder sparse-conv weights in a state dict."""
    converted_state_dict: Dict[str, torch.Tensor] = {}
    converted_count = 0
    for key, value in state_dict.items():
        if should_convert_middle_encoder_weight(key, value):
            converted_state_dict[key] = convert_spconv_weight(value)
            converted_count += 1
            continue
        converted_state_dict[key] = value
    return converted_state_dict, converted_count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Convert BEVFusion checkpoint sparse-conv weights to spconv1 layout')
    parser.add_argument(
        'checkpoint',
        type=str,
        help='Input checkpoint path trained with spconv2 layout')
    parser.add_argument(
        'output',
        type=str,
        help='Output checkpoint path for the converted weights')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    checkpoint_path = Path(args.checkpoint)
    output_path = Path(args.output)
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f'Checkpoint not found: {checkpoint_path}')

    checkpoint = torch.load(checkpoint_path, map_location='cpu')
    if not isinstance(checkpoint, dict):
        raise TypeError(f'Unsupported checkpoint format: {type(checkpoint)}')
    if 'state_dict' not in checkpoint:
        raise KeyError('Checkpoint does not contain state_dict')

    converted_state_dict, converted_count = convert_state_dict(
        checkpoint['state_dict'])
    checkpoint['state_dict'] = converted_state_dict

    output_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(checkpoint, output_path)
    print(f'Converted {converted_count} pts_middle_encoder weights')
    print(f'Saved checkpoint to {output_path}')


if __name__ == '__main__':
    main()
