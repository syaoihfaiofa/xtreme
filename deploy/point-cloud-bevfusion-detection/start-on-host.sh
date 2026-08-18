#!/usr/bin/env bash
# Run BEVFusion inference on the HOST training environment.
# No new Docker image, no mmcv download — reuses your existing conda.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${BEVFUSION_REPO_ROOT:-${MMDET3D_DIR:-$HOME/mmdetection3d}}"
PORT="${BEVFUSION_HOST_PORT:-8298}"

export BEVFUSION_REPO_ROOT="${REPO_ROOT}"
export BEVFUSION_CONFIG="${BEVFUSION_CONFIG:-${REPO_ROOT}/work_dirs/bevfusion_lidar_custom_nus_3class/bevfusion_lidar_voxel0075_custom-nus-3class.py}"
export BEVFUSION_CHECKPOINT="${BEVFUSION_CHECKPOINT:-${REPO_ROOT}/work_dirs/bevfusion_lidar_custom_nus_3class/epoch_20.pth}"
export BEVFUSION_CAR_CONFIG="${BEVFUSION_CAR_CONFIG:-${REPO_ROOT}/outputs/car.json}"
export PYTHONPATH="${REPO_ROOT}:${PYTHONPATH:-}"

PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"
if [[ -z "${PYTHON_BIN}" ]]; then
  echo "python3 not found in PATH" >&2
  exit 1
fi

echo "python:      ${PYTHON_BIN}"
echo "mmdet3d:     ${REPO_ROOT}"
echo "checkpoint:  ${BEVFUSION_CHECKPOINT}"
echo "listen:      0.0.0.0:${PORT}"
echo
echo "Tip: Xtreme1 backend runs in Docker. After start, set model URL to:"
echo "  http://<host-ip>:${PORT}/pointCloud/recognition"
echo "  (docker bridge gateway is often 172.17.0.1)"
echo

cd "${SCRIPT_DIR}"
"${PYTHON_BIN}" -m pip install --quiet flask gunicorn requests 2>/dev/null || true
exec "${PYTHON_BIN}" -m gunicorn -c gunicorn.conf.py -b "0.0.0.0:${PORT}" app:app
