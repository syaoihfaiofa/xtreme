from __future__ import annotations

import logging
import os

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from detection_service import DetectionService

logging.basicConfig(level=os.environ.get('LOG_LEVEL', 'INFO'))

DEFAULT_MAX_CONTENT_LENGTH = 16 * 1024 * 1024
DEFAULT_MAX_DATAS = 100


def positive_env_int(name: str, default: int) -> int:
    raw_value = os.environ.get(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise RuntimeError(
            f'{name} must be a positive integer, got {raw_value!r}'
        ) from exc
    if value <= 0:
        raise RuntimeError(
            f'{name} must be a positive integer, got {raw_value!r}'
        )
    return value


app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = positive_env_int(
    'MAX_CONTENT_LENGTH', DEFAULT_MAX_CONTENT_LENGTH)
MAX_DATAS = positive_env_int('MAX_DATAS', DEFAULT_MAX_DATAS)
service = DetectionService()


@app.errorhandler(RequestEntityTooLarge)
def request_too_large(
    error: RequestEntityTooLarge,
) -> tuple[Response, int]:
    limit = app.config['MAX_CONTENT_LENGTH']
    return jsonify({
        'code': 'ERROR',
        'message': (
            f'request body exceeds MAX_CONTENT_LENGTH ({limit} bytes); '
            'reduce the payload or raise the configured limit'),
        'data': [],
    }), 413


@app.route('/health', methods=['GET'])
def health() -> Response:
    return jsonify(service.health())


@app.route('/pointCloud/recognition', methods=['POST'])
def point_cloud_recognition() -> Response | tuple[Response, int]:
    """Xtreme1 LIDAR_DETECTION model contract."""
    body = request.get_json(force=True, silent=True) or {}
    datas = body.get('datas') or []

    if not datas:
        return jsonify({'code': 'ERROR', 'message': 'datas is required', 'data': []}), 400
    if not isinstance(datas, list):
        return jsonify({
            'code': 'ERROR',
            'message': 'datas must be an array',
            'data': [],
        }), 400
    if len(datas) > MAX_DATAS:
        return jsonify({
            'code': 'ERROR',
            'message': (
                f'datas exceeds MAX_DATAS: count={len(datas)}, limit={MAX_DATAS}'),
            'data': [],
        }), 400

    results = [service.recognize(data_item) for data_item in datas]
    return jsonify({'code': 'OK', 'message': '', 'data': results})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '5000'))
    app.run(host='0.0.0.0', port=port)
