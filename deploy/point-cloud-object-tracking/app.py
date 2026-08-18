from __future__ import annotations

import os

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from scene_association import associate_scene
from tracking_service import TrackingService

DEFAULT_MAX_CONTENT_LENGTH = 16 * 1024 * 1024


def positive_env_int(name: str, default: int) -> int:
    raw_value = os.environ.get(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise RuntimeError(
            f"{name} must be a positive integer, got {raw_value!r}"
        ) from exc
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive integer, got {raw_value!r}")
    return value


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = positive_env_int(
    "MAX_CONTENT_LENGTH", DEFAULT_MAX_CONTENT_LENGTH
)
service = TrackingService.from_env()


def ok_response(target_id: int | str | None, objects: list[dict]) -> Response:
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


@app.errorhandler(RequestEntityTooLarge)
def request_too_large(
    error: RequestEntityTooLarge,
) -> tuple[Response, int]:
    limit = app.config["MAX_CONTENT_LENGTH"]
    return (
        jsonify(
            {
                "code": "ERROR",
                "message": (
                    f"request body exceeds MAX_CONTENT_LENGTH ({limit} bytes); "
                    "reduce the payload or raise the configured limit"
                ),
                "data": [],
            }
        ),
        413,
    )


@app.route("/health", methods=["GET"])
def health() -> Response:
    return jsonify(service.health())


@app.route("/pointCloud/tracking", methods=["POST"])
def tracking() -> Response | tuple[Response, int]:
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


@app.route("/pointCloud/associate", methods=["POST"])
def associate() -> Response | tuple[Response, int]:
    body = request.get_json(force=True, silent=True)
    if body is None:
        return (
            jsonify(
                {
                    "code": "ERROR",
                    "message": "request body must contain valid JSON",
                    "data": {},
                }
            ),
            400,
        )
    try:
        data = associate_scene(body)
    except ValueError as exc:
        return jsonify({"code": "ERROR", "message": str(exc), "data": {}}), 400
    except Exception as exc:
        app.logger.exception("scene association failed")
        return jsonify({"code": "ERROR", "message": str(exc), "data": {}}), 500
    return jsonify({"code": "OK", "message": "", "data": data})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
