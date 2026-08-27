#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
M2_CACHE="${M2_CACHE:-${HOME}/.m2}"
JAR_NAME="xtreme1-backend-0.9.1-SNAPSHOT.jar"
JAR_PATH="${ROOT}/backend/target/${JAR_NAME}"
MAVEN_IMAGE="${MAVEN_IMAGE:-maven:3.8-eclipse-temurin-11}"

if [[ -n "${BACKEND_CONTAINER:-}" ]]; then
    CONTAINER="${BACKEND_CONTAINER}"
else
    CONTAINER="$(docker ps --format '{{.Names}}' | grep -E '(^|-)backend-1$' | head -1 || true)"
    CONTAINER="${CONTAINER:-xtreme-backend-1}"
fi

mkdir -p "${M2_CACHE}"

build_with_host_mvn() {
    echo "Building backend jar with host Maven (skip tests, cache ${M2_CACHE})..."
    (
        cd "${ROOT}/backend"
        mvn -DskipTests package
    )
}

build_with_docker_mvn() {
    echo "Building backend jar via ${MAVEN_IMAGE} (skip tests, cache ${M2_CACHE})..."
    # Reuse the local maven image. Do not pull. Mount source + m2 cache so rebuilds are incremental.
    docker run --rm \
        --pull=never \
        -v "${ROOT}/backend:/workspace" \
        -v "${M2_CACHE}:/root/.m2" \
        -w /workspace \
        "${MAVEN_IMAGE}" \
        mvn -DskipTests package
}

if command -v mvn >/dev/null 2>&1; then
    build_with_host_mvn
else
    build_with_docker_mvn
fi

if [[ ! -f "${JAR_PATH}" ]]; then
    echo "Build failed: missing ${JAR_PATH}" >&2
    exit 1
fi

echo "Copying jar into ${CONTAINER}..."
docker cp "${JAR_PATH}" "${CONTAINER}:/app/app.jar"
echo "Restarting ${CONTAINER}..."
docker restart "${CONTAINER}" >/dev/null

echo "Done. Backend is restarting; wait until http://localhost:8190 is healthy, then retry sync."
