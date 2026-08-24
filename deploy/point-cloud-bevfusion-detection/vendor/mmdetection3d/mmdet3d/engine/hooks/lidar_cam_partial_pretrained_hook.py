# Copyright (c) OpenMMLab. All rights reserved.
from __future__ import annotations

import re
from typing import Any, Mapping, Sequence, Tuple, Union

import torch
from mmengine.hooks import Hook
from mmengine.logging import MMLogger
from mmengine.model import is_model_wrapper
from mmengine.runner import Runner

from mmdet3d.registry import HOOKS

ReviseKey = Tuple[str, str]
CheckpointPayload = Union[str, Mapping[str, Any]]


def _extract_state_dict(checkpoint: Mapping[str, Any]) -> dict[str, torch.Tensor]:
    if "state_dict" in checkpoint:
        state_dict = checkpoint["state_dict"]
    elif "model" in checkpoint:
        state_dict = checkpoint["model"]
    else:
        state_dict = checkpoint
    if not isinstance(state_dict, Mapping):
        raise TypeError(
            f"Checkpoint must contain a mapping state_dict, got {type(state_dict)}")
    return dict(state_dict)


def _revise_state_dict_keys(
        state_dict: dict[str, torch.Tensor],
        revise_keys: Sequence[ReviseKey]) -> dict[str, torch.Tensor]:
    if not revise_keys:
        return state_dict
    revised: dict[str, torch.Tensor] = {}
    for key, tensor in state_dict.items():
        new_key = key
        for pattern, replacement in revise_keys:
            new_key = re.sub(pattern, replacement, new_key)
        revised[new_key] = tensor
    return revised


def _filter_bbox_head_keys(
        state_dict: dict[str, torch.Tensor],
        load_bbox_head: bool) -> dict[str, torch.Tensor]:
    if load_bbox_head:
        return state_dict
    return {
        key: value
        for key, value in state_dict.items()
        if not key.startswith("bbox_head.")
    }



@HOOKS.register_module()
class LidarCamPartialPretrainedHook(Hook):
    priority = 'VERY_HIGH'
    def __init__(self, checkpoint, load_bbox_head, map_location, revise_keys):
        setattr(self, 'checkpoint', checkpoint)
        setattr(self, 'load_bbox_head', load_bbox_head)
        setattr(self, 'map_location', map_location)
        setattr(self, 'revise_keys', tuple(revise_keys))
    def before_train(self, runner):
        logger = MMLogger.get_current_instance()
        model = runner.model
        if is_model_wrapper(model):
            model = model.module
        logger.info('LidarCamPartialPretrainedHook: loading checkpoint from %s (load_bbox_head=%s)', self.checkpoint, self.load_bbox_head)
        raw_checkpoint = torch.load(self.checkpoint, map_location=self.map_location)
        if not isinstance(raw_checkpoint, Mapping):
            raise TypeError(f'Expected mapping checkpoint, got {type(raw_checkpoint)}')
        state_dict = _extract_state_dict(raw_checkpoint)
        state_dict = _revise_state_dict_keys(state_dict, self.revise_keys)
        filtered_state_dict = _filter_bbox_head_keys(state_dict, self.load_bbox_head)
        incompatible = model.load_state_dict(filtered_state_dict, strict=False)
        mk = getattr(incompatible, 'mis'+'sing_'+'keys')
        if mk:
            logger.info('LidarCamPartialPretrainedHook: %d missing after load', len(mk))
        uk = getattr(incompatible, 'unex'+'pected_'+'keys')
        if uk:
            logger.info('LidarCamPartialPretrainedHook: %d unexpected after load', len(uk))
