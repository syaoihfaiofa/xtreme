#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building the versioned pcd-tools image..."
docker compose -f "${ROOT}/docker-compose.yml" build pcd-tools

echo "Restarting pcd-tools with the new image..."
docker compose -f "${ROOT}/docker-compose.yml" up -d --no-deps pcd-tools

echo "Done. New point-cloud uploads will generate preview-binary-*.pcd assets."
