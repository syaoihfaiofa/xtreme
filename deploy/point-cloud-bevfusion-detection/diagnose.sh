#!/usr/bin/env bash
set -euo pipefail

XTREME1_DIR="${XTREME1_DIR:-/PnP/lxzhu/lidar_annos/xtreme1}"
MODEL_URL="${MODEL_URL:-http://point-cloud-bevfusion-detection:5000/pointCloud/recognition}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-xtreme1-backend-1}"
MODEL_CONTAINER="${MODEL_CONTAINER:-xtreme1-point-cloud-bevfusion-detection-1}"
MYSQL_CONTAINER="${MYSQL_CONTAINER:-xtreme1-mysql-1}"

cd "${XTREME1_DIR}"

echo "=== 1. Model container status ==="
docker compose ps point-cloud-bevfusion-detection || true
docker ps -a --filter name=bevfusion --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true

echo
echo "=== 2. Host health (port 8298) ==="
if curl -sf --connect-timeout 3 http://localhost:8298/health; then
  echo
else
  echo "FAIL: localhost:8298/health unreachable"
fi

echo
echo "=== 3. Backend -> model service (docker network) ==="
if docker exec "${BACKEND_CONTAINER}" curl -sf --connect-timeout 5 http://point-cloud-bevfusion-detection:5000/health; then
  echo
else
  echo "FAIL: backend cannot reach point-cloud-bevfusion-detection:5000"
  echo "      This is the usual cause of 'Model service connection timed out'."
fi

echo
echo "=== 4. Model URL in MySQL ==="
docker exec "${MYSQL_CONTAINER}" mysql -uxtreme1 -pRc4K3L6f xtreme1 -N -e \
  "SELECT id, name, url FROM model WHERE url LIKE '%bevfusion%' OR name LIKE '%BEVFusion%';" || true

echo
echo "=== 5. Recent model service logs ==="
docker compose logs point-cloud-bevfusion-detection --tail 40 || true

echo
echo "=== Expected model URL: ${MODEL_URL} ==="
