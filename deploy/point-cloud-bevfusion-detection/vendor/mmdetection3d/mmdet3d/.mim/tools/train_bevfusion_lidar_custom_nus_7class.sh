#!/usr/bin/env bash

set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GPU_IDS="${GPU_IDS:-0}"
IFS=',' read -r -a GPU_ID_LIST <<< "${GPU_IDS}"
GPUS="${#GPU_ID_LIST[@]}"

cd "${REPOSITORY_ROOT}"

export CUDA_VISIBLE_DEVICES="${GPU_IDS}"

bash tools/dist_train.sh \
  projects/BEVFusion/configs/bevfusion_lidar_voxel0075_custom-nus-7class.py \
  "${GPUS}" \
  --work-dir work_dirs/bevfusion_lidar_custom_nus_7class \
  --amp
