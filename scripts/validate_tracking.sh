#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRACKING_DIR="$ROOT/deploy/point-cloud-object-tracking"
export PYTHONDONTWRITEBYTECODE=1

echo "[1/5] Python syntax check"
python3 - <<'PY'
from pathlib import Path

for path in Path("deploy/point-cloud-object-tracking").glob("*.py"):
    compile(path.read_text(), str(path), "exec")
print("python syntax ok")
PY

echo "[2/5] Tracking API smoke test"
python3 - <<'PY'
import json
import sys
sys.path.insert(0, "deploy/point-cloud-object-tracking")
from app import app

client = app.test_client()
resp = client.post(
    "/pointCloud/tracking",
    json={
        "direction": "FORWARD",
        "targetData": {"id": 1002},
        "objects": [
            {
                "trackingId": "track-1",
                "center3D": {"x": 1, "y": 2, "z": 3},
                "rotation3D": {"x": 0, "y": 0, "z": 0},
                "size3D": {"x": 4, "y": 2, "z": 1.5},
                "modelClass": "car",
                "confidence": 0.9,
            }
        ],
    },
)
assert resp.status_code == 200, resp.data
body = resp.get_json()
assert body["code"] == "OK", body
obj = body["data"][0]["objects"][0]
assert obj["trackingId"] == "track-1"
assert obj["x"] == 1.5
print("tracking API ok")
PY

echo "[3/5] CenterPoint association contract check"
python3 - <<'PY'
import json
import os
import sys
sys.path.insert(0, "deploy/point-cloud-object-tracking")
from tracking_service import TrackingService

os.environ["CENTERPOINT_MOCK_DETECTIONS"] = json.dumps(
    [
        {
            "label": "car",
            "confidence": 0.95,
            "x": 1.3,
            "y": 2.0,
            "z": 3.0,
            "dimX": 4.2,
            "dimY": 2.0,
            "dimZ": 1.5,
            "rotX": 0,
            "rotY": 0,
            "rotZ": 0.1,
        },
        {
            "label": "pedestrian",
            "confidence": 0.8,
            "x": 20,
            "y": 20,
            "z": 0,
            "dimX": 1,
            "dimY": 1,
            "dimZ": 2,
            "rotX": 0,
            "rotY": 0,
            "rotZ": 0,
        },
    ]
)
svc = TrackingService.from_env()
body = {
    "direction": "FORWARD",
    "targetData": {"id": 1002, "pointCloudUrl": "mock.bin"},
    "objects": [
        {
            "trackingId": "track-1",
            "label": "car",
            "x": 1,
            "y": 2,
            "z": 3,
            "dimX": 4,
            "dimY": 2,
            "dimZ": 1.5,
        }
    ],
}
objects = svc.track(body)
assert len(objects) == 1, objects
assert objects[0]["trackingId"] == "track-1", objects
assert objects[0]["x"] == 1.3, objects
print("CenterPoint association contract ok")
PY

echo "[4/5] Frontend pollModelTrack contract check"
node - <<'NODE'
const fs = require('fs');
const src = fs.readFileSync('frontend/pc-tool/src/utils/model.ts', 'utf8');
if (!src.includes('targetDataIds')) throw new Error('pollModelTrack missing targetDataIds');
if (!src.includes('objectsMap[dataId]')) throw new Error('pollModelTrack missing dataId key');
console.log('pollModelTrack contract ok');
NODE

echo "[5/5] Backend tracking JSON normalize (optional, set XTREME1_RUN_JAVA_TEST=1)"
if [ "${XTREME1_RUN_JAVA_TEST:-}" = 1 ] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker run --rm -v "$ROOT/backend:/build" -w /build maven:3.8-eclipse-temurin-11 \
    mvn -q -Dtest=PointCloudTrackingModelHttpCallerTest test
  echo "Java unit test ok"
else
  echo "skip Java test (set XTREME1_RUN_JAVA_TEST=1 with Docker to run PointCloudTrackingModelHttpCallerTest)"
fi

echo "All tracking validation checks passed."
