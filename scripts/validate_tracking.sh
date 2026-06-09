#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRACKING_DIR="$ROOT/deploy/point-cloud-object-tracking"

echo "[1/3] Python syntax check"
python3 -m py_compile "$TRACKING_DIR/app.py"

echo "[2/3] Tracking API smoke test"
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

echo "[3/3] Frontend pollModelTrack contract check"
node - <<'NODE'
const fs = require('fs');
const src = fs.readFileSync('frontend/pc-tool/src/utils/model.ts', 'utf8');
if (!src.includes('targetDataIds')) throw new Error('pollModelTrack missing targetDataIds');
if (!src.includes('objectsMap[dataId]')) throw new Error('pollModelTrack missing dataId key');
console.log('pollModelTrack contract ok');
NODE

echo "All tracking validation checks passed."
