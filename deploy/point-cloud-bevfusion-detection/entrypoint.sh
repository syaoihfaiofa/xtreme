#!/usr/bin/env bash
set -euo pipefail

python -c "import mmdet3d; import projects.BEVFusion.bevfusion"
exec python -m gunicorn -c /app/gunicorn.conf.py app:app
