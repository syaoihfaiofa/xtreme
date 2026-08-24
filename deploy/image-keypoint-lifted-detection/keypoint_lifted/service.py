import os
from pathlib import Path
from typing import Dict, List, Mapping, Protocol, Sequence, Tuple, Union

import numpy as np

from .decoder import REQUIRED_HEADS, decode_quads
from .fusion import fuse_bev_boxes
from .geometry import GeometryError, lift_detection, lift_polyline
from .labels import load_labels
from .polyline_decoder import decode_polylines
from .polyline_fusion import fuse_ground_polylines
from .preprocessing import preprocess_bgr
from .resources import HTTPResources
from .schemas import (
    Box3D,
    CameraCalibration,
    GroundPolyline,
    KeypointDetection,
    load_height_defaults,
    load_vehicle_ground_z,
)

ONNX_HEADS = REQUIRED_HEADS + (
    "sktpts_hm",
    "sktpts_reg",
    "semantic_mask",
)


class InferenceSession(Protocol):
    def run(
        self, output_names: Sequence[str], inputs: Mapping[str, np.ndarray]
    ) -> Sequence[np.ndarray]:
        ...


class Resources(Protocol):
    def load_json(self, url: str) -> object:
        ...

    def load_image(self, url: str) -> np.ndarray:
        ...


def _float_env(name: str, default: str) -> float:
    raw_value = os.environ.get(name, default)
    try:
        return float(raw_value)
    except ValueError as error:
        raise RuntimeError("{} must be a number, got {!r}".format(name, raw_value)) from error


def _int_env(name: str, default: str) -> int:
    raw_value = os.environ.get(name, default)
    try:
        return int(raw_value)
    except ValueError as error:
        raise RuntimeError("{} must be an integer, got {!r}".format(name, raw_value)) from error


def _calibration_for_index(
    camera_config: object, camera_index: int
) -> CameraCalibration:
    if isinstance(camera_config, list):
        if camera_index >= len(camera_config):
            raise ValueError(
                "camera index {} has no calibration in array of length {}".format(
                    camera_index, len(camera_config)
                )
            )
        raw_calibration = camera_config[camera_index]
        if not isinstance(raw_calibration, Mapping):
            raise ValueError(
                "camera index {} calibration array item must be an object".format(
                    camera_index
                )
            )
        try:
            return CameraCalibration.from_xtreme(raw_calibration)
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(
                "camera index {} calibration array item is invalid: {}".format(
                    camera_index, error
                )
            ) from error
    if not isinstance(camera_config, Mapping):
        raise ValueError(
            "camera_config must be an object or array, got {!r}".format(camera_config)
        )
    accepted_keys = (
        "3d_img{}".format(camera_index),
        "camera_image_{}".format(camera_index),
        str(camera_index),
    )
    for key in accepted_keys:
        if key not in camera_config:
            continue
        raw_calibration = camera_config[key]
        if not isinstance(raw_calibration, Mapping):
            raise ValueError(
                "camera index {} calibration key {!r} must be an object".format(
                    camera_index, key
                )
            )
        try:
            return CameraCalibration.from_xtreme(raw_calibration)
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(
                "camera index {} calibration key {!r} is invalid: {}".format(
                    camera_index, key, error
                )
            ) from error
    raise ValueError(
        "camera index {} has no calibration; accepted keys={}".format(
            camera_index, accepted_keys
        )
    )


def _object_payload(
    value: Union[Box3D, GroundPolyline]
) -> Dict[str, object]:
    if isinstance(value, GroundPolyline):
        return {
            "objType": value.objType,
            "modelClass": value.modelClass,
            "confidence": value.confidence,
            "points": [point._asdict() for point in value.points],
            "sourceViewIndexes": list(value.source_view_indexes),
            "sourceKeypoints": [
                list(keypoints) for keypoints in value.source_keypoints
            ],
        }
    box = value
    return {
        "objType": box.objType,
        "modelClass": box.modelClass,
        "confidence": box.confidence,
        "center3D": box.center3D._asdict(),
        "size3D": box.size3D._asdict(),
        "rotation3D": box.rotation3D._asdict(),
        "sourceViewIndexes": list(box.source_view_indexes),
        "sourceKeypoints": [list(keypoints) for keypoints in box.source_keypoints],
    }


class RecognitionService:
    def __init__(
        self,
        session: InferenceSession,
        resources: Resources,
        labels: Sequence[str],
        height_defaults: Mapping[str, float],
        score_threshold: float,
        top_k: int,
        fusion_iou_threshold: float,
        ground_z: float,
        polyline_labels: Sequence[str],
        polyline_score_threshold: float,
        polyline_top_k: int,
        polyline_fusion_distance_threshold: float,
    ) -> None:
        invalid_parameters = []
        if not 0.0 <= score_threshold <= 1.0:
            invalid_parameters.append("score_threshold={!r}".format(score_threshold))
        if top_k <= 0:
            invalid_parameters.append("top_k={!r}".format(top_k))
        if not 0.0 <= fusion_iou_threshold <= 1.0:
            invalid_parameters.append(
                "fusion_iou_threshold={!r}".format(fusion_iou_threshold)
            )
        if not np.isfinite(ground_z):
            invalid_parameters.append("ground_z={!r}".format(ground_z))
        if not polyline_labels:
            invalid_parameters.append("polyline_labels must be non-empty")
        if not 0.0 <= polyline_score_threshold <= 1.0:
            invalid_parameters.append(
                "polyline_score_threshold={!r}".format(polyline_score_threshold)
            )
        if polyline_top_k <= 0:
            invalid_parameters.append("polyline_top_k={!r}".format(polyline_top_k))
        if polyline_fusion_distance_threshold <= 0.0:
            invalid_parameters.append(
                "polyline_fusion_distance_threshold={!r}".format(
                    polyline_fusion_distance_threshold
                )
            )
        if invalid_parameters:
            raise ValueError(
                "Invalid recognition parameters: {}".format(
                    ", ".join(invalid_parameters)
                )
            )
        if not labels:
            raise ValueError("labels must be non-empty")
        if not height_defaults:
            raise ValueError("height_defaults must be non-empty")
        self._session = session
        self._resources = resources
        self._labels = tuple(labels)
        self._height_defaults = height_defaults
        self._score_threshold = score_threshold
        self._top_k = top_k
        self._fusion_iou_threshold = fusion_iou_threshold
        self._ground_z = ground_z
        self._polyline_labels = tuple(polyline_labels)
        self._polyline_score_threshold = polyline_score_threshold
        self._polyline_top_k = polyline_top_k
        self._polyline_fusion_distance_threshold = (
            polyline_fusion_distance_threshold
        )

    @classmethod
    def from_env(cls) -> "RecognitionService":
        import onnxruntime

        model_path = Path(
            os.environ.get("ONNX_MODEL_PATH", "/models/keypoint-lifted.onnx")
        )
        if not model_path.is_file():
            raise FileNotFoundError(
                "ONNX_MODEL_PATH does not exist: {!s}".format(model_path)
            )
        providers = [
            provider.strip()
            for provider in os.environ.get(
                "ONNX_PROVIDERS", "CUDAExecutionProvider,CPUExecutionProvider"
            ).split(",")
            if provider.strip()
        ]
        session = onnxruntime.InferenceSession(
            str(model_path), providers=providers
        )
        heights_path = Path(
            os.environ.get("HEIGHTS_PATH", "/config/heights.yaml")
        )
        labels_path = Path(
            os.environ.get("LABELS_PATH", "/config/labels.json")
        )
        polyline_labels_path = Path(
            os.environ.get("POLYLINE_LABELS_PATH", "/config/polyline-labels.json")
        )
        vehicle_info_path = Path(
            os.environ.get("VEHICLE_INFO_PATH", "/config/car_info.json")
        )
        return cls(
            session=session,
            resources=HTTPResources(_float_env("REQUEST_TIMEOUT_SECONDS", "30")),
            labels=load_labels(labels_path),
            height_defaults=load_height_defaults(heights_path),
            score_threshold=_float_env("SCORE_THRESHOLD", "0.25"),
            top_k=_int_env("TOP_K", "100"),
            fusion_iou_threshold=_float_env("FUSION_IOU_THRESHOLD", "0.5"),
            ground_z=load_vehicle_ground_z(vehicle_info_path),
            polyline_labels=load_labels(polyline_labels_path),
            polyline_score_threshold=_float_env(
                "POLYLINE_SCORE_THRESHOLD", "0.3"
            ),
            polyline_top_k=_int_env("POLYLINE_TOP_K", "200"),
            polyline_fusion_distance_threshold=_float_env(
                "POLYLINE_FUSION_DISTANCE_THRESHOLD", "0.3"
            ),
        )

    def health(self) -> Dict[str, object]:
        return {
            "status": "ok",
            "scoreThreshold": self._score_threshold,
            "topK": self._top_k,
            "fusionIouThreshold": self._fusion_iou_threshold,
            "groundZ": self._ground_z,
            "polylineScoreThreshold": self._polyline_score_threshold,
            "polylineTopK": self._polyline_top_k,
            "polylineFusionDistanceThreshold": self._polyline_fusion_distance_threshold,
        }

    def recognize(self, frame: Mapping[str, object]) -> Dict[str, object]:
        frame_id = frame.get("id")
        try:
            objects, rejections = self._recognize_frame(frame)
        except (KeyError, TypeError, ValueError) as error:
            return {
                "id": frame_id,
                "code": "ERROR",
                "message": str(error),
                "objects": [],
                "rejections": [],
            }
        return {
            "id": frame_id,
            "code": "OK",
            "message": "",
            "objects": [_object_payload(value) for value in objects],
            "rejections": rejections,
        }

    def _recognize_frame(
        self, frame: Mapping[str, object]
    ) -> Tuple[
        List[Union[Box3D, GroundPolyline]], List[Dict[str, object]]
    ]:
        frame_id = frame.get("id")
        if (
            isinstance(frame_id, bool)
            or not isinstance(frame_id, (int, str))
            or (isinstance(frame_id, str) and not frame_id.strip())
        ):
            raise ValueError(
                "id must be a non-empty integer or string, got {!r}".format(frame_id)
            )
        cameras = frame.get("cameras")
        if not isinstance(cameras, list) or not cameras:
            raise ValueError(
                "cameras must be a non-empty array, got {!r}".format(cameras)
            )
        camera_inputs: List[Tuple[int, str]] = []
        seen_view_indexes: set[int] = set()
        for camera in cameras:
            if not isinstance(camera, Mapping):
                raise ValueError("each camera must be an object, got {!r}".format(camera))
            view_index = camera.get("viewIndex")
            image_url = camera.get("imageUrl")
            if (
                isinstance(view_index, bool)
                or not isinstance(view_index, int)
                or view_index < 0
                or not isinstance(image_url, str)
                or not image_url
            ):
                raise ValueError(
                    "camera must contain non-negative integer viewIndex and non-empty "
                    "imageUrl, got {!r}".format(camera)
                )
            if view_index in seen_view_indexes:
                raise ValueError("cameras must not contain duplicate viewIndex={}".format(view_index))
            seen_view_indexes.add(view_index)
            camera_inputs.append((view_index, image_url))
        camera_config_url = frame.get("cameraConfigUrl")
        if not isinstance(camera_config_url, str) or not camera_config_url:
            raise ValueError(
                "cameraConfigUrl must be a non-empty string, got {!r}".format(
                    camera_config_url
                )
            )
        try:
            raw_config = self._resources.load_json(camera_config_url)
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(
                "cameraConfigUrl={!r} could not provide valid calibration: {}".format(
                    camera_config_url, error
                )
            ) from error

        try:
            indexed_calibrations = {
                view_index: _calibration_for_index(raw_config, view_index)
                for view_index, _ in camera_inputs
            }
        except ValueError as error:
            raise ValueError(
                "cameraConfigUrl={!r} has invalid calibration: {}".format(
                    camera_config_url, error
                )
            ) from error
        boxes = []
        polylines = []
        rejections = []
        for camera_index, image_url in camera_inputs:
            calibration = indexed_calibrations[camera_index]
            try:
                image = self._resources.load_image(image_url)
            except (TypeError, ValueError) as error:
                raise ValueError(
                    "camera index {} imageUrl={!r} could not be loaded: {}".format(
                        camera_index, image_url, error
                    )
                ) from error
            image_height, image_width = image.shape[:2]
            if (
                image_width != calibration.width
                or image_height != calibration.height
            ):
                raise ValueError(
                    "camera index {} imageUrl={!r} dimensions {}x{} do not match "
                    "calibration dimensions {}x{}".format(
                        camera_index,
                        image_url,
                        image_width,
                        image_height,
                        calibration.width,
                        calibration.height,
                    )
                )
            try:
                tensor, metadata = preprocess_bgr(image)
            except ValueError as error:
                raise ValueError(
                    "camera index {} imageUrl={!r} preprocessing failed: {}".format(
                        camera_index, image_url, error
                    )
                ) from error
            try:
                values = self._session.run(list(ONNX_HEADS), {"image": tensor})
            except Exception as error:
                raise ValueError(
                    "camera index {} imageUrl={!r} ONNX inference failed with "
                    "score_threshold={!r}, top_k={!r}: {}: {}".format(
                        camera_index,
                        image_url,
                        self._score_threshold,
                        self._top_k,
                        type(error).__name__,
                        error,
                    )
                ) from error
            try:
                if len(values) != len(ONNX_HEADS):
                    raise ValueError(
                        "inference returned {} outputs; expected {} ({})".format(
                            len(values), len(ONNX_HEADS), ONNX_HEADS
                        )
                    )
                heads = dict(zip(ONNX_HEADS, values))
                detections = decode_quads(
                    heads,
                    score_threshold=self._score_threshold,
                    top_k=self._top_k,
                    metadata=metadata,
                )
                polyline_detections = decode_polylines(
                    heads,
                    metadata,
                    score_threshold=self._polyline_score_threshold,
                    top_k=self._polyline_top_k,
                )
            except (RuntimeError, ValueError) as error:
                raise ValueError(
                    "camera index {} imageUrl={!r} inference failed with "
                    "score_threshold={!r}, top_k={!r}: {}".format(
                        camera_index,
                        image_url,
                        self._score_threshold,
                        self._top_k,
                        error,
                    )
                ) from error
            for detection_index, detection in enumerate(detections):
                try:
                    model_class = self._labels[detection.class_id]
                    keypoint_detection = KeypointDetection(
                        model_class=model_class,
                        confidence=detection.score,
                        view_index=camera_index,
                        keypoints=detection.keypoints,
                    )
                    boxes.append(
                        lift_detection(
                            keypoint_detection,
                            calibration,
                            self._height_defaults,
                            self._ground_z,
                        )
                    )
                except (GeometryError, IndexError, ValueError) as error:
                    rejections.append(
                        {
                            "cameraIndex": camera_index,
                            "detectionIndex": detection_index,
                            "classId": detection.class_id,
                            "score": detection.score,
                            "reason": str(error),
                        }
                    )
            for detection_index, detection in enumerate(polyline_detections):
                try:
                    model_class = self._polyline_labels[detection.class_id]
                    polylines.append(
                        lift_polyline(
                            model_class=model_class,
                            confidence=detection.score,
                            view_index=camera_index,
                            pixel_points=detection.points,
                            calibration=calibration,
                            ground_z=self._ground_z,
                        )
                    )
                except (GeometryError, IndexError, ValueError) as error:
                    rejections.append(
                        {
                            "cameraIndex": camera_index,
                            "detectionIndex": detection_index,
                            "classId": detection.class_id,
                            "score": detection.score,
                            "reason": str(error),
                        }
                    )
        return (
            list(fuse_bev_boxes(boxes, self._fusion_iou_threshold))
            + list(
                fuse_ground_polylines(
                    polylines, self._polyline_fusion_distance_threshold
                )
            ),
            rejections,
        )
