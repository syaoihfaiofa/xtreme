#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${MAIN_FRONTEND_IMAGE:-xtreme-main-fast}"
EXTRACT_CONTAINER="main-fast-extract"
if [[ -n "${FRONTEND_CONTAINER:-}" ]]; then
    CONTAINER="${FRONTEND_CONTAINER}"
else
    CONTAINER="$(docker ps --format '{{.Names}}' | grep -E '(^|-)frontend-1$' | head -1 || true)"
    CONTAINER="${CONTAINER:-xtreme-frontend-1}"
fi

echo "Building main frontend only via Docker (uses dependency cache when available)..."
DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}" docker build --pull=false \
    -f "${ROOT}/frontend/Dockerfile.main" -t "${IMAGE}" "${ROOT}/frontend"

echo "Extracting main assets..."
MAIN_DEPLOY_TMPDIR="$(mktemp -d)"
trap 'rm -rf "${MAIN_DEPLOY_TMPDIR}"; docker rm -f "${EXTRACT_CONTAINER}" >/dev/null 2>&1 || true' EXIT
docker rm -f "${EXTRACT_CONTAINER}" >/dev/null 2>&1 || true
docker create --name "${EXTRACT_CONTAINER}" "${IMAGE}" >/dev/null
docker cp "${EXTRACT_CONTAINER}:/usr/share/nginx/html/main/." "${MAIN_DEPLOY_TMPDIR}/"

echo "Copying main assets into ${CONTAINER}..."
docker cp "${MAIN_DEPLOY_TMPDIR}/." "${CONTAINER}:/usr/share/nginx/html/main/"
echo "Done. Hard-refresh http://localhost:8190/#/models/detail?id=6&tabId=RUNS"
