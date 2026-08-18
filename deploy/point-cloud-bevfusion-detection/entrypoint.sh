#!/usr/bin/env bash
set -euo pipefail

find_python() {
  local candidate
  for candidate in \
    "${PYTHON_BIN:-}" \
    /opt/conda/bin/python \
    /usr/local/bin/python \
    /usr/bin/python3 \
    python3; do
    if [[ -z "${candidate}" ]]; then
      continue
    fi
    if [[ -x "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
    if command -v "${candidate}" >/dev/null 2>&1; then
      command -v "${candidate}"
      return 0
    fi
  done
  return 1
}

PYTHON_BIN="$(find_python)" || {
  echo "no python interpreter found" >&2
  exit 127
}
echo "using python: ${PYTHON_BIN}"

export PYTHONPATH="/mmdetection3d:${PYTHONPATH:-}"

"${PYTHON_BIN}" -m pip install --quiet --user -r /app/requirements.txt

if ! "${PYTHON_BIN}" -c "import mmengine" >/dev/null 2>&1; then
  if [[ "${SKIP_MMLAB_INSTALL:-false}" == "true" ]]; then
    echo "mmengine not found and SKIP_MMLAB_INSTALL=true, aborting" >&2
    exit 1
  fi
  echo "installing mmengine/mmcv/mmdet (slow; prefer start-on-host.sh or mount host conda)..."
  PIP_INDEX="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"
  "${PYTHON_BIN}" -m pip install --quiet --user -i "${PIP_INDEX}" openmim
  "${PYTHON_BIN}" -m mim install mmengine "mmcv>=2.0.0" "mmdet>=3.0.0"
fi

if ! "${PYTHON_BIN}" -c "import mmdet3d" >/dev/null 2>&1; then
  echo "installing mmdet3d from mounted repo..."
  "${PYTHON_BIN}" -m pip install --quiet --user -e /mmdetection3d
fi

if ! "${PYTHON_BIN}" -c "import bev_pool_ext" >/dev/null 2>&1; then
  echo "building BEVFusion bev_pool CUDA extension..."
  (cd /mmdetection3d && "${PYTHON_BIN}" -m pip install --quiet --user -e projects/BEVFusion)
fi

export PATH="/root/.local/bin:${PATH}"

exec "${PYTHON_BIN}" -m gunicorn -c /app/gunicorn.conf.py app:app
