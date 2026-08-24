#!/usr/bin/env bash

set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GPU_IDS="${GPU_IDS:-0}"
SOURCE_CHECKPOINT="${SOURCE_CHECKPOINT:-${REPOSITORY_ROOT}/checkpoints/bevfusion/bevfusion_lidar_nus.pth}"
LOAD_FROM="${LOAD_FROM:-${REPOSITORY_ROOT}/checkpoints/bevfusion/bevfusion_lidar_nus_spconv1.pth}"
RESUME="${RESUME:-}"
WORK_DIR="${WORK_DIR:-work_dirs/bevfusion_lidar_custom_nus_3class}"
IFS=',' read -r -a GPU_ID_LIST <<< "${GPU_IDS}"
GPUS="${#GPU_ID_LIST[@]}"

cd "${REPOSITORY_ROOT}"

if [[ ! -f "${LOAD_FROM}" || "${SOURCE_CHECKPOINT}" -nt "${LOAD_FROM}" ]]; then
  python tools/misc/convert_bevfusion_checkpoint.py \
    "${SOURCE_CHECKPOINT}" \
    "${LOAD_FROM}"
fi

export CUDA_VISIBLE_DEVICES="${GPU_IDS}"

TRAIN_ARGS=(
  projects/BEVFusion/configs/bevfusion_lidar_voxel0075_custom-nus-3class.py
  "${GPUS}"
  --work-dir "${WORK_DIR}"
  --amp
)

# Resume has priority over pretrained load_from.
# Use either:
#   RESUME=work_dirs/.../epoch_11.pth GPU_IDS=0 bash tools/train_bevfusion_lidar_custom_nus_3class.sh
#   GPU_IDS=0 bash tools/train_bevfusion_lidar_custom_nus_3class.sh --resume work_dirs/.../epoch_11.pth
if [[ -n "${RESUME}" ]]; then
  TRAIN_ARGS+=(--resume "${RESUME}")
elif printf '%s\n' "$@" | grep -q -- '--resume'; then
  :
else
  TRAIN_ARGS+=(--cfg-options "load_from=${LOAD_FROM}")
fi

bash tools/dist_train.sh "${TRAIN_ARGS[@]}" "$@"
