#!/usr/bin/env bash
set -euo pipefail

XTREME1_DIR="${XTREME1_DIR:-/PnP/lxzhu/lidar_annos/xtreme1}"
MMDET3D_DIR="${MMDET3D_DIR:-/PnP/lxzhu/mmdetection3d}"
CONDA_DIR="${CONDA_DIR:-/opt/conda}"
MYSQL_CONTAINER="${MYSQL_CONTAINER:-xtreme1-mysql-1}"
MYSQL_USER="${MYSQL_USER:-xtreme1}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-Rc4K3L6f}"
MYSQL_DB="${MYSQL_DB:-xtreme1}"

cd "${XTREME1_DIR}"
export HOME="${HOME:-/PnP/lxzhu}"

echo "[1/4] Build point-cloud-bevfusion-detection image"
docker compose build point-cloud-bevfusion-detection

echo "[2/4] Start service (model profile)"
docker compose --profile model up -d point-cloud-bevfusion-detection

echo "[3/4] Register model in MySQL"
docker exec -i "${MYSQL_CONTAINER}" mysql -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DB}" \
  < deploy/mysql/migration/V14__Add_bevfusion_detection_model.sql
docker exec -i "${MYSQL_CONTAINER}" mysql -u"${MYSQL_USER}" -p"${MYSQL_PASSWORD}" "${MYSQL_DB}" \
  < deploy/mysql/migration/V15__Add_bevfusion_detection_model_classes.sql

echo "[4/5] Health check (host port)"
sleep 10
curl -sf "http://localhost:8298/health" | python3 -m json.tool

echo "[5/5] Backend connectivity check (docker network)"
if docker exec "${BACKEND_CONTAINER:-xtreme1-backend-1}" curl -sf --connect-timeout 5 \
    http://point-cloud-bevfusion-detection:5000/health | python3 -m json.tool; then
  echo "Backend can reach model service."
else
  echo "WARNING: backend cannot reach point-cloud-bevfusion-detection:5000"
  echo "Run: bash deploy/point-cloud-bevfusion-detection/diagnose.sh"
  exit 1
fi

echo
echo "Done. Open http://172.16.100.217:8190/#/models/list and select:"
echo "  BEVFusion LiDAR 3-Class Detection"
