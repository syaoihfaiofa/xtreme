from __future__ import annotations

import os

from flask import Flask, jsonify, request

from tracking_service import TrackingService

app = Flask(__name__)
service = TrackingService.from_env()


def ok_response(target_id: int | str | None, objects: list[dict]):
    return jsonify(
        {
            "code": "OK",
            "message": "",
            "data": [
                {
                    "id": target_id,
                    "code": "OK",
                    "message": "",
                    "objects": objects,
                }
            ],
        }
    )


@app.route("/health", methods=["GET"])
def health():
    return jsonify(service.health())


@app.route("/pointCloud/tracking", methods=["POST"])
def tracking():
    body = request.get_json(force=True, silent=True) or {}
    target = body.get("targetData") or {}

    if not target.get("id"):
        return jsonify({"code": "ERROR", "message": "targetData.id is required", "data": []}), 400

    try:
        objects = service.track(body)
    except Exception as exc:
        app.logger.exception("tracking failed")
        return jsonify({"code": "ERROR", "message": str(exc), "data": []}), 500

    return ok_response(target.get("id"), objects)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
