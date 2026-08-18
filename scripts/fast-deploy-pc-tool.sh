#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${PC_TOOL_CONTAINER:-xtreme-frontend-1}"

echo "Building pc-tool only via Docker (~1-2 min, uses cache)..."
DOCKER_BUILDKIT=1 docker build --pull=false -f "${ROOT}/frontend/Dockerfile.pc-tool" -t xtreme-pc-tool-fast "${ROOT}/frontend"

echo "Extracting dist from build image..."
TMPDIR="$(mktemp -d)"
docker create --name pc-tool-fast-extract xtreme-pc-tool-fast >/dev/null
docker cp pc-tool-fast-extract:/build/dist/pc-tool/. "${TMPDIR}/"
docker rm pc-tool-fast-extract >/dev/null

echo "Copying into ${CONTAINER}..."
docker cp "${TMPDIR}/." "${CONTAINER}:/usr/share/nginx/html/pc-tool/"
rm -rf "${TMPDIR}"

echo "Done (~1-2 min). Hard-refresh browser on http://localhost:8190/tool/pc"
