"""
Point cloud 3D box tracking HTTP service for Xtreme1.

Uses constant-velocity extrapolation from seed boxes. Replace predict_objects()
with AB3DMOT inference when a trained model is available.
"""
from __future__ import annotations

import os
from typing import Any

from flask import Flask, jsonify, request

app = Flask(__name__)

FRAME_OFFSET = float(os.environ.get("TRACK_FRAME_OFFSET", "0.5"))


def predict_objects(seed_objects: list[dict[str, Any]], direction: str) -> list[dict[str, Any]]:
    sign = 1 if direction == "FORWARD" else -1
    results = []
    for obj in seed_objects:
        x = float(obj.get("x", 0))
        y = float(obj.get("y", 0))
        z = float(obj.get("z", 0))
        results.append(
            {
                "trackingId": obj.get("trackingId"),
                "label": obj.get("label"),
                "confidence": obj.get("confidence", 0.9),
                "x": x + sign * FRAME_OFFSET,
                "y": y,
                "z": z,
                "dimX": obj.get("dimX", obj.get("dx", 1)),
                "dimY": obj.get("dimY", obj.get("dy", 1)),
                "dimZ": obj.get("dimZ", obj.get("dz", 1)),
                "rotX": obj.get("rotX", 0),
                "rotY": obj.get("rotY", 0),
                "rotZ": obj.get("rotZ", 0),
            }
        )
    return results


def normalize_seed(obj: dict[str, Any]) -> dict[str, Any]:
    center = obj.get("center3D") or {}
    rotation = obj.get("rotation3D") or {}
    size = obj.get("size3D") or {}
    return {
        "trackingId": obj.get("trackingId"),
        "label": obj.get("modelClass"),
        "confidence": obj.get("confidence", 0.9),
        "x": center.get("x", obj.get("x", 0)),
        "y": center.get("y", obj.get("y", 0)),
        "z": center.get("z", obj.get("z", 0)),
        "dimX": size.get("x", obj.get("dimX", 1)),
        "dimY": size.get("y", obj.get("dimY", 1)),
        "dimZ": size.get("z", obj.get("dimZ", 1)),
        "rotX": rotation.get("x", obj.get("rotX", 0)),
        "rotY": rotation.get("y", obj.get("rotY", 0)),
        "rotZ": rotation.get("z", obj.get("rotZ", 0)),
    }


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/pointCloud/tracking", methods=["POST"])
def tracking():
    body = request.get_json(force=True, silent=True) or {}
    target = body.get("targetData") or {}
    direction = body.get("direction", "FORWARD")
    seeds = [normalize_seed(o) for o in body.get("objects", [])]

    if not target.get("id"):
        return jsonify({"code": "ERROR", "message": "targetData.id is required", "data": []}), 400

    objects = predict_objects(seeds, direction)
    return jsonify(
        {
            "code": "OK",
            "message": "",
            "data": [
                {
                    "id": target.get("id"),
                    "code": "OK",
                    "message": "",
                    "objects": objects,
                }
            ],
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
