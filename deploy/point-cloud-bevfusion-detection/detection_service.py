import json
import logging
import os
import re
import tempfile
import threading
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Sequence, Tuple
from urllib.parse import urlparse


CAMERA_NAMES = ("CAM_FRONT", "CAM_LEFT", "CAM_BACK", "CAM_RIGHT")
CLASS_NAMES = ("car", "cone", "pillar")
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
DOWNLOAD_ATTEMPTS = 3
DEFAULT_CONFIG = "/models/bevfusion_lidar-cam_voxel0075_custom-nus-3class.py"
DEFAULT_CHECKPOINT = "/models/epoch_20.pth"
LOGGER = logging.getLogger(__name__)


class DetectionInputError(RuntimeError):
    """Raised when an Xtreme1 detection request cannot be processed."""


class CameraCalibration(NamedTuple):
    camera_to_image: List[List[float]]
    lidar_to_camera: List[List[float]]


class DetectionRequest(NamedTuple):
    data_id: Any
    point_cloud_url: str
    image_urls: List[str]
    camera_config_url: str


def validate_detection_request(data: Any) -> DetectionRequest:
    if not isinstance(data, dict):
        raise DetectionInputError("data must be an object")

    required_strings = ("pointCloudUrl", "cameraConfigUrl")
    for field in required_strings:
        if not isinstance(data.get(field), str) or not data[field].strip():
            raise DetectionInputError("%s is required and must be a non-empty string" % field)

    if "id" not in data or data["id"] is None:
        raise DetectionInputError("id is required")

    image_urls = data.get("imageUrls")
    if not isinstance(image_urls, list) or len(image_urls) != len(CAMERA_NAMES):
        raise DetectionInputError(
            "imageUrls must contain exactly four camera image URLs, got %s"
            % (len(image_urls) if isinstance(image_urls, list) else "non-array")
        )
    if any(not isinstance(url, str) or not url.strip() for url in image_urls):
        raise DetectionInputError("imageUrls must contain only non-empty strings")

    return DetectionRequest(
        data_id=data["id"],
        point_cloud_url=data["pointCloudUrl"].strip(),
        image_urls=[url.strip() for url in image_urls],
        camera_config_url=data["cameraConfigUrl"].strip(),
    )


def parse_camera_configuration(camera_config: Any) -> List[CameraCalibration]:
    camera_items = _normalize_camera_items(camera_config)
    if len(camera_items) != len(CAMERA_NAMES):
        raise DetectionInputError(
            "camera configuration must contain exactly four camera calibrations, got %d"
            % len(camera_items)
        )

    calibrations = []
    for index, item in enumerate(camera_items):
        if not isinstance(item, dict):
            raise DetectionInputError("camera calibration at index %d must be an object" % index)
        intrinsic = item.get("cameraInternal") or item.get("camera_internal")
        if not isinstance(intrinsic, dict):
            raise DetectionInputError(
                "camera calibration at index %d is missing cameraInternal" % index
            )
        try:
            camera_to_image = [
                [float(intrinsic["fx"]), 0.0, float(intrinsic["cx"])],
                [0.0, float(intrinsic["fy"]), float(intrinsic["cy"])],
                [0.0, 0.0, 1.0],
            ]
        except (KeyError, TypeError, ValueError) as exc:
            raise DetectionInputError(
                "camera calibration at index %d has invalid cameraInternal" % index
            ) from exc

        external = item.get("cameraExternal") or item.get("camera_external")
        matrix = _matrix4(external, "cameraExternal at index %d" % index)
        if item.get("rowMajor") is False or _is_column_major(matrix):
            matrix = _transpose(matrix)
        calibrations.append(
            CameraCalibration(
                camera_to_image=camera_to_image,
                lidar_to_camera=matrix,
            )
        )
    return calibrations


def _normalize_camera_items(camera_config: Any) -> List[Any]:
    if isinstance(camera_config, dict):
        for key in ("cameraInfo", "cameras", "cameraConfig"):
            if key in camera_config:
                return _normalize_camera_items(camera_config[key])
        return [
            value
            for _, value in sorted(
                camera_config.items(), key=lambda item: _camera_sort_key(item[0], item[1])
            )
        ]
    if isinstance(camera_config, list):
        if len(camera_config) == 1 and isinstance(camera_config[0], list):
            return camera_config[0]
        return camera_config
    raise DetectionInputError("camera configuration must be an object or array")


def _camera_sort_key(key: Any, value: Any) -> Tuple[int, str]:
    match = re.search(r"(\d+)\s*$", str(key))
    if match:
        return int(match.group(1)), str(key)
    if isinstance(value, dict):
        name = value.get("cameraName") or value.get("camera_name") or ""
        match = re.search(r"(\d+)\s*$", str(name))
        if match:
            return int(match.group(1)), str(key)
    return 2 ** 31 - 1, str(key)


def _matrix4(value: Any, field_name: str) -> List[List[float]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise DetectionInputError("%s must contain 16 numeric values" % field_name)
    if len(value) == 4 and all(isinstance(row, Sequence) for row in value):
        if any(len(row) != 4 for row in value):
            raise DetectionInputError("%s must be a 4x4 matrix" % field_name)
        raw_matrix = value
    elif len(value) == 16:
        raw_matrix = [value[index:index + 4] for index in range(0, 16, 4)]
    else:
        raise DetectionInputError("%s must contain 16 numeric values" % field_name)
    try:
        return [[float(cell) for cell in row] for row in raw_matrix]
    except (TypeError, ValueError) as exc:
        raise DetectionInputError("%s must contain only numeric values" % field_name) from exc


def _is_column_major(matrix: List[List[float]]) -> bool:
    return (
        matrix[0][3] == 0.0
        and matrix[1][3] == 0.0
        and matrix[2][3] == 0.0
        and any(matrix[3][index] != 0.0 for index in range(3))
    )


def _transpose(matrix: List[List[float]]) -> List[List[float]]:
    return [[matrix[column][row] for column in range(4)] for row in range(4)]


class DetectionService:
    def __init__(self) -> None:
        self._model: Any = None
        self._model_lock = threading.Lock()
        self._config_path = os.environ.get("BEVFUSION_CONFIG", DEFAULT_CONFIG)
        self._checkpoint_path = os.environ.get("BEVFUSION_CHECKPOINT", DEFAULT_CHECKPOINT)
        self._car_config_path = os.environ.get("BEVFUSION_CAR_CONFIG", "/models/car.json")
        self._device = os.environ.get("BEVFUSION_DEVICE", "cuda:0")
        self._score_threshold = _nonnegative_env_float(
            "BEVFUSION_DETECTION_SCORE_THRESHOLD", 0.25
        )

    def health(self) -> Dict[str, Any]:
        config_exists = Path(self._config_path).is_file()
        checkpoint_exists = Path(self._checkpoint_path).is_file()
        car_config_exists = Path(self._car_config_path).is_file()
        ready = config_exists and checkpoint_exists and car_config_exists
        return {
            "status": "ok" if ready else "degraded",
            "backend": "bevfusion-lidar-camera",
            "deepLearning": True,
            "config": self._config_path,
            "checkpoint": self._checkpoint_path,
            "carConfig": self._car_config_path,
            "device": self._device,
            "ready": ready,
            "modelLoaded": self._model is not None,
        }

    def recognize(self, data: Any) -> Dict[str, Any]:
        data_id = data.get("id") if isinstance(data, dict) else None
        try:
            request = validate_detection_request(data)
            with tempfile.TemporaryDirectory(prefix="bevfusion-request-") as directory:
                work_dir = Path(directory)
                point_cloud_path = _download_to_path(
                    request.point_cloud_url, work_dir, "point-cloud"
                )
                image_paths = [
                    _download_to_path(url, work_dir, "camera-%d" % index)
                    for index, url in enumerate(request.image_urls)
                ]
                calibration_path = _download_to_path(
                    request.camera_config_url, work_dir, "camera-config"
                )
                calibrations = parse_camera_configuration(
                    _read_camera_config(calibration_path, request.camera_config_url)
                )
                points_path = _write_model_points(point_cloud_path, work_dir)
                result = self._infer(points_path, image_paths, calibrations)
            return {
                "id": request.data_id,
                "code": "OK",
                "message": "",
                "objects": _to_xtreme_objects(result, self._score_threshold),
            }
        except DetectionInputError as exc:
            return {"id": data_id, "code": "ERROR", "message": str(exc), "objects": []}
        except Exception as exc:
            return {
                "id": data_id,
                "code": "ERROR",
                "message": "BEVFusion inference failed: %s" % exc,
                "objects": [],
            }

    def _infer(
        self,
        points_path: Path,
        image_paths: List[Path],
        calibrations: List[CameraCalibration],
    ) -> Any:
        model = self._load_model()
        try:
            import torch
            from mmengine.dataset import Compose, pseudo_collate
            from mmdet3d.structures import get_box_type
        except ImportError as exc:
            raise RuntimeError(
                "vendored MMDetection3D dependencies are unavailable; rebuild the service image"
            ) from exc

        config = model.cfg
        pipeline_config = deepcopy(config.test_dataloader.dataset.pipeline)
        for transform in pipeline_config:
            if transform["type"] == "FilterVehicleBlindZone":
                transform["car_config_path"] = self._car_config_path
        pipeline = Compose(pipeline_config)
        box_type_3d, box_mode_3d = get_box_type(
            config.test_dataloader.dataset.box_type_3d
        )
        images = {
            name: {
                "img_path": str(image_paths[index]),
                "cam2img": calibrations[index].camera_to_image,
                "lidar2cam": calibrations[index].lidar_to_camera,
            }
            for index, name in enumerate(CAMERA_NAMES)
        }
        sample = pipeline(
            {
                "lidar_points": {
                    "lidar_path": str(points_path),
                    "num_pts_feats": 5,
                },
                "images": images,
                "sweeps": [],
                "lidar_sweeps": [],
                "timestamp": 0,
                "box_type_3d": box_type_3d,
                "box_mode_3d": box_mode_3d,
            }
        )
        if sample is None:
            raise RuntimeError("BEVFusion test pipeline rejected the input sample")
        with torch.no_grad():
            return model.test_step(pseudo_collate([sample]))[0]

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model
            if not Path(self._config_path).is_file():
                raise FileNotFoundError(
                    "BEVFusion config not found: %s" % self._config_path
                )
            if not Path(self._checkpoint_path).is_file():
                raise FileNotFoundError(
                    "BEVFusion checkpoint not found: %s" % self._checkpoint_path
                )
            if not Path(self._car_config_path).is_file():
                raise FileNotFoundError(
                    "BEVFusion vehicle config not found: %s" % self._car_config_path
                )
            try:
                from mmdet3d.apis import init_model
            except ImportError as exc:
                raise RuntimeError(
                    "vendored MMDetection3D dependencies are unavailable; rebuild the service image"
                ) from exc
            self._model = init_model(
                self._config_path, self._checkpoint_path, device=self._device
            )
            return self._model


def _nonnegative_env_float(name: str, default: float) -> float:
    raw_value = os.environ.get(name, str(default))
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise RuntimeError("%s must be a non-negative number, got %r" % (name, raw_value)) from exc
    if value < 0:
        raise RuntimeError("%s must be a non-negative number, got %r" % (name, raw_value))
    return value


def _download_to_path(url_or_path: str, work_dir: Path, prefix: str) -> Path:
    import requests

    parsed = urlparse(url_or_path)
    if parsed.scheme not in ("http", "https"):
        path = Path(url_or_path)
        if not path.is_file():
            raise DetectionInputError("input file does not exist: url=%r" % url_or_path)
        return path

    suffix = Path(parsed.path).suffix or ".bin"
    destination = work_dir / ("%s%s" % (prefix, suffix))
    error: Exception = RuntimeError("download did not run")
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            with requests.get(url_or_path, stream=True, timeout=30) as response:
                response.raise_for_status()
                with destination.open("wb") as output:
                    for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK_BYTES):
                        if chunk:
                            output.write(chunk)
            return destination
        except requests.RequestException as exc:
            error = exc
            if destination.exists():
                destination.unlink()
            if attempt < DOWNLOAD_ATTEMPTS:
                time.sleep(0.25 * (2 ** (attempt - 1)))
    raise DetectionInputError(
        "failed to download input after %d attempts: url=%r, error=%s"
        % (DOWNLOAD_ATTEMPTS, url_or_path, error)
    )


def _read_camera_config(path: Path, source_url: str) -> Any:
    try:
        with path.open("r", encoding="utf-8") as input_file:
            return json.load(input_file)
    except (OSError, ValueError) as exc:
        raise DetectionInputError(
            "failed to parse cameraConfigUrl as JSON: url=%r, error=%s"
            % (source_url, exc)
        ) from exc


def _write_model_points(source_path: Path, work_dir: Path) -> Path:
    import numpy as np

    points = _load_points(source_path)
    if points.shape[1] == 4:
        points = np.concatenate(
            (points, np.zeros((points.shape[0], 1), dtype=np.float32)), axis=1
        )
    output_path = work_dir / "points.bin"
    points.astype(np.float32, copy=False).tofile(str(output_path))
    return output_path


def _load_points(path: Path) -> Any:
    import numpy as np

    if path.suffix.lower() == ".pcd":
        return _load_pcd_points(path)
    raw = np.fromfile(str(path), dtype=np.float32)
    for width in (5, 4):
        if raw.size and raw.size % width == 0:
            return raw.reshape((-1, width))
    raise DetectionInputError(
        "unsupported binary point cloud format: path=%s, float_count=%d"
        % (path, raw.size)
    )


def _load_pcd_points(path: Path) -> Any:
    import numpy as np

    try:
        content = path.read_bytes()
    except OSError as exc:
        raise DetectionInputError("failed to read point cloud: path=%s, error=%s" % (path, exc)) from exc

    data_match = re.search(br"(?mi)^DATA\s+(\S+)\s*\r?\n", content)
    if data_match is None:
        raise DetectionInputError("invalid PCD header: path=%s" % path)
    header_lines = content[:data_match.start()].splitlines()
    header = {
        line.split(maxsplit=1)[0].lower(): line.split(maxsplit=1)[1]
        for line in header_lines
        if len(line.split(maxsplit=1)) == 2
    }
    data_format = data_match.group(1).lower()
    fields = header.get(b"fields", b"x y z intensity").decode().split()
    payload = content[data_match.end():]

    try:
        if data_format == b"ascii":
            values = np.asarray(
                [[float(value) for value in line.split()] for line in payload.splitlines() if line],
                dtype=np.float32,
            )
            if values.size == 0:
                raise ValueError("no point rows")
            columns = {name: values[:, fields.index(name)] for name in ("x", "y", "z")}
            intensity = values[:, fields.index("intensity")] if "intensity" in fields else np.zeros(
                values.shape[0], dtype=np.float32
            )
        elif data_format == b"binary":
            sizes = [int(value) for value in header[b"size"].split()]
            types = [value.decode().upper() for value in header[b"type"].split()]
            counts = [int(value) for value in header.get(b"count", b"").split()]
            if not counts:
                counts = [1] * len(fields)
            if not (len(fields) == len(sizes) == len(types) == len(counts)):
                raise ValueError("FIELDS, SIZE, TYPE, and COUNT lengths differ")
            dtype_fields = []
            for name, size, value_type, count in zip(fields, sizes, types, counts):
                scalar_dtype = _pcd_scalar_dtype(value_type, size)
                dtype_fields.append(
                    (name, scalar_dtype) if count == 1 else (name, scalar_dtype, (count,))
                )
            structured_dtype = np.dtype(dtype_fields)
            point_count = int(header.get(b"points", header.get(b"width", b"0")))
            expected_bytes = point_count * structured_dtype.itemsize
            if point_count <= 0:
                raise ValueError(
                    "binary payload is too short: points=%d, expected_bytes=%d, actual_bytes=%d"
                    % (point_count, expected_bytes, len(payload))
                )
            if len(payload) < expected_bytes:
                deficit = expected_bytes - len(payload)
                complete_point_count = len(payload) // structured_dtype.itemsize
                if deficit >= structured_dtype.itemsize or complete_point_count <= 0:
                    raise ValueError(
                        "binary payload is too short: points=%d, expected_bytes=%d, actual_bytes=%d"
                        % (point_count, expected_bytes, len(payload))
                    )
                LOGGER.warning(
                    "Dropping incomplete final PCD record",
                    extra={
                        "path": str(path),
                        "declared_points": point_count,
                        "complete_points": complete_point_count,
                        "missing_bytes": deficit,
                    },
                )
                point_count = complete_point_count
                expected_bytes = point_count * structured_dtype.itemsize
            values = np.frombuffer(payload[:expected_bytes], dtype=structured_dtype, count=point_count)
            columns = {name: values[name] for name in ("x", "y", "z")}
            intensity = values["intensity"] if "intensity" in fields else np.zeros(
                point_count, dtype=np.float32
            )
        else:
            raise ValueError("unsupported DATA format %s" % data_format.decode(errors="replace"))
    except (ValueError, IndexError) as exc:
        raise DetectionInputError("invalid PCD point data: path=%s, error=%s" % (path, exc)) from exc
    return np.stack((columns["x"], columns["y"], columns["z"], intensity), axis=1).astype(
        np.float32, copy=False
    )


def _pcd_scalar_dtype(value_type: str, size: int) -> str:
    dtype_by_type_and_size = {
        ("F", 4): "<f4",
        ("F", 8): "<f8",
        ("I", 1): "<i1",
        ("I", 2): "<i2",
        ("I", 4): "<i4",
        ("I", 8): "<i8",
        ("U", 1): "<u1",
        ("U", 2): "<u2",
        ("U", 4): "<u4",
        ("U", 8): "<u8",
    }
    try:
        return dtype_by_type_and_size[(value_type, size)]
    except KeyError as exc:
        raise ValueError("unsupported PCD field type=%s size=%d" % (value_type, size)) from exc


def _to_xtreme_objects(result: Any, score_threshold: float) -> List[Dict[str, float]]:
    pred = getattr(result, "pred_instances_3d", result)
    boxes = _as_numpy(getattr(pred, "bboxes_3d", None))
    scores = _as_numpy(getattr(pred, "scores_3d", None))
    labels = _as_numpy(getattr(pred, "labels_3d", None))
    if boxes is None or scores is None or labels is None:
        return []
    boxes = _as_numpy(getattr(boxes, "tensor", boxes))
    objects = []
    for box, score, label in zip(boxes, scores, labels):
        if float(score) < score_threshold:
            continue
        label_index = int(label)
        if not 0 <= label_index < len(CLASS_NAMES):
            continue
        objects.append(
            {
                "label": CLASS_NAMES[label_index],
                "confidence": float(score),
                "x": float(box[0]),
                "y": float(box[1]),
                "z": float(box[2] + box[5] / 2.0),
                "dx": float(box[3]),
                "dy": float(box[4]),
                "dz": float(box[5]),
                "rotX": 0.0,
                "rotY": 0.0,
                "rotZ": float(box[6]) if len(box) > 6 else 0.0,
            }
        )
    return objects


def _as_numpy(value: Any) -> Any:
    if value is None:
        return None
    if hasattr(value, "detach"):
        return value.detach().cpu().numpy()
    if hasattr(value, "cpu") and hasattr(value, "numpy"):
        return value.cpu().numpy()
    if hasattr(value, "numpy"):
        return value.numpy()
    return value
