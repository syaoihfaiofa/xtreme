import os
from pathlib import Path
from typing import Dict, List, Mapping, Protocol, Sequence, Tuple, cast

import numpy as np

from .decoder import PoseDetection, decode_pose_output
from .fusion import fuse_bev_boxes
from .geometry import GeometryError, lift_detection
from .labels import load_labels
from .preprocessing import (
    INPUT_SIZE,
    CropFractions,
    PreprocessMetadata,
    input_to_image_points,
    load_crop_windows,
    preprocess_bgr,
)
from .resources import HTTPResources
from .schemas import (
    Box3D,
    CameraCalibration,
    KeypointDetection,
    Keypoints,
    load_height_defaults,
    load_vehicle_ground_z,
)

ONNX_INPUT_NAME = "images"
ONNX_OUTPUT_NAME = "output0"


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


def _object_payload(box: Box3D) -> Dict[str, object]:
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


def _parse_cameras(frame: Mapping[str, object]) -> List[Tuple[int, str]]:
    cameras = frame.get("cameras")
    if not isinstance(cameras, list) or not cameras:
        raise ValueError("cameras must be a non-empty array, got {!r}".format(cameras))
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
            raise ValueError(
                "cameras must not contain duplicate viewIndex={}".format(view_index)
            )
        seen_view_indexes.add(view_index)
        camera_inputs.append((view_index, image_url))
    return camera_inputs


class RecognitionService:
    def __init__(
        self,
        session: InferenceSession,
        resources: Resources,
        labels: Sequence[str],
        height_defaults: Mapping[str, float],
        score_threshold: float,
        nms_iou_threshold: float,
        keypoint_score_threshold: float,
        max_detections: int,
        crop_windows: Mapping[int, CropFractions],
        fusion_iou_threshold: float,
        ground_z: float,
    ) -> None:
        invalid_parameters = []
        for name, value in (
            ("score_threshold", score_threshold),
            ("nms_iou_threshold", nms_iou_threshold),
            ("keypoint_score_threshold", keypoint_score_threshold),
            ("fusion_iou_threshold", fusion_iou_threshold),
        ):
            if not 0.0 <= value <= 1.0:
                invalid_parameters.append("{}={!r}".format(name, value))
        if max_detections <= 0:
            invalid_parameters.append("max_detections={!r}".format(max_detections))
        if not crop_windows:
            invalid_parameters.append("crop_windows={!r}".format(crop_windows))
        if not np.isfinite(ground_z):
            invalid_parameters.append("ground_z={!r}".format(ground_z))
        if invalid_parameters:
            raise ValueError(
                "Invalid recognition parameters: {}".format(", ".join(invalid_parameters))
            )
        if not labels:
            raise ValueError("labels must be non-empty")
        missing_heights = [label for label in labels if label not in height_defaults]
        if missing_heights:
            raise ValueError(
                "height_defaults has no entry for labels {!r}".format(missing_heights)
            )
        self._session = session
        self._resources = resources
        self._labels = tuple(labels)
        self._height_defaults = height_defaults
        self._score_threshold = score_threshold
        self._nms_iou_threshold = nms_iou_threshold
        self._keypoint_score_threshold = keypoint_score_threshold
        self._max_detections = max_detections
        self._crop_windows = dict(crop_windows)
        self._fusion_iou_threshold = fusion_iou_threshold
        self._ground_z = ground_z

    @classmethod
    def from_env(cls) -> "RecognitionService":
        import onnxruntime

        model_path = Path(os.environ.get("ONNX_MODEL_PATH", "/models/rod.onnx"))
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
        session = onnxruntime.InferenceSession(str(model_path), providers=providers)
        return cls(
            session=session,
            resources=HTTPResources(_float_env("REQUEST_TIMEOUT_SECONDS", "30")),
            labels=load_labels(Path(os.environ.get("LABELS_PATH", "/config/labels.json"))),
            height_defaults=load_height_defaults(
                Path(os.environ.get("HEIGHTS_PATH", "/config/heights.yaml"))
            ),
            score_threshold=_float_env("SCORE_THRESHOLD", "0.25"),
            nms_iou_threshold=_float_env("NMS_IOU_THRESHOLD", "0.7"),
            keypoint_score_threshold=_float_env("KPT_CONF_THRESHOLD", "0.5"),
            max_detections=_int_env("MAX_DETECTIONS", "100"),
            crop_windows=load_crop_windows(
                Path(os.environ.get("CROP_WINDOWS_PATH", "/config/crop_windows.yaml"))
            ),
            fusion_iou_threshold=_float_env("FUSION_IOU_THRESHOLD", "0.5"),
            ground_z=load_vehicle_ground_z(
                Path(os.environ.get("VEHICLE_INFO_PATH", "/config/car_info.json"))
            ),
        )

    def health(self) -> Dict[str, object]:
        return {
            "status": "ok",
            "labels": list(self._labels),
            "scoreThreshold": self._score_threshold,
            "nmsIouThreshold": self._nms_iou_threshold,
            "keypointScoreThreshold": self._keypoint_score_threshold,
            "maxDetections": self._max_detections,
            "cropWindows": {
                str(camera_index): fractions._asdict()
                for camera_index, fractions in sorted(self._crop_windows.items())
            },
            "fusionIouThreshold": self._fusion_iou_threshold,
            "groundZ": self._ground_z,
        }

    def recognize(self, frame: Mapping[str, object]) -> Dict[str, object]:
        frame_id = frame.get("id")
        try:
            boxes, rejections = self._recognize_frame(frame)
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
            "objects": [_object_payload(box) for box in boxes],
            "rejections": rejections,
        }

    def _recognize_frame(
        self, frame: Mapping[str, object]
    ) -> Tuple[List[Box3D], List[Dict[str, object]]]:
        frame_id = frame.get("id")
        if (
            isinstance(frame_id, bool)
            or not isinstance(frame_id, (int, str))
            or (isinstance(frame_id, str) and not frame_id.strip())
        ):
            raise ValueError(
                "id must be a non-empty integer or string, got {!r}".format(frame_id)
            )
        camera_inputs = _parse_cameras(frame)
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
            calibrations = {
                view_index: _calibration_for_index(raw_config, view_index)
                for view_index, _ in camera_inputs
            }
        except ValueError as error:
            raise ValueError(
                "cameraConfigUrl={!r} has invalid calibration: {}".format(
                    camera_config_url, error
                )
            ) from error

        boxes: List[Box3D] = []
        rejections: List[Dict[str, object]] = []
        for camera_index, image_url in camera_inputs:
            camera_boxes, camera_rejections = self._recognize_camera(
                camera_index, image_url, calibrations[camera_index]
            )
            boxes.extend(camera_boxes)
            rejections.extend(camera_rejections)
        return list(fuse_bev_boxes(boxes, self._fusion_iou_threshold)), rejections

    def _detect(
        self, camera_index: int, image_url: str, image: np.ndarray
    ) -> Tuple[List[PoseDetection], PreprocessMetadata]:
        fractions = self._crop_windows.get(camera_index)
        if fractions is None:
            raise ValueError(
                "camera index {} imageUrl={!r} has no crop window; configured camera "
                "indexes={}".format(camera_index, image_url, sorted(self._crop_windows))
            )
        try:
            tensor, metadata = preprocess_bgr(image, fractions, INPUT_SIZE)
        except ValueError as error:
            raise ValueError(
                "camera index {} imageUrl={!r} preprocessing failed with "
                "crop={!r}: {}".format(camera_index, image_url, fractions, error)
            ) from error
        try:
            outputs = self._session.run([ONNX_OUTPUT_NAME], {ONNX_INPUT_NAME: tensor})
        except Exception as error:
            raise ValueError(
                "camera index {} imageUrl={!r} ONNX inference failed: {}: {}".format(
                    camera_index, image_url, type(error).__name__, error
                )
            ) from error
        if len(outputs) != 1:
            raise ValueError(
                "camera index {} imageUrl={!r} inference returned {} outputs; "
                "expected 1 ({})".format(
                    camera_index, image_url, len(outputs), ONNX_OUTPUT_NAME
                )
            )
        try:
            detections = decode_pose_output(
                np.asarray(outputs[0]),
                class_count=len(self._labels),
                score_threshold=self._score_threshold,
                iou_threshold=self._nms_iou_threshold,
                max_detections=self._max_detections,
            )
        except ValueError as error:
            raise ValueError(
                "camera index {} imageUrl={!r} decoding failed with "
                "score_threshold={!r}, nms_iou_threshold={!r}: {}".format(
                    camera_index,
                    image_url,
                    self._score_threshold,
                    self._nms_iou_threshold,
                    error,
                )
            ) from error
        return detections, metadata

    def _image_keypoints(
        self, detection: PoseDetection, metadata: PreprocessMetadata
    ) -> Keypoints:
        keypoint_scores = detection.keypoints[:, 2]
        if float(keypoint_scores.min()) < self._keypoint_score_threshold:
            raise GeometryError(
                "Keypoint scores {} below keypoint_score_threshold={!r}".format(
                    [round(float(score), 4) for score in keypoint_scores],
                    self._keypoint_score_threshold,
                )
            )
        points = input_to_image_points(detection.keypoints[:, :2], metadata)
        crop = metadata.crop
        outside = (
            (points[:, 0] < crop.x0)
            | (points[:, 0] > crop.x0 + crop.width)
            | (points[:, 1] < crop.y0)
            | (points[:, 1] > crop.y0 + crop.height)
        )
        if outside.any():
            raise GeometryError(
                "Keypoints {} fall outside crop window {}".format(
                    points.round(2).tolist(), crop._asdict()
                )
            )
        return cast(Keypoints, tuple(float(value) for value in points.reshape(-1)))

    def _recognize_camera(
        self, camera_index: int, image_url: str, calibration: CameraCalibration
    ) -> Tuple[List[Box3D], List[Dict[str, object]]]:
        try:
            image = self._resources.load_image(image_url)
        except (TypeError, ValueError) as error:
            raise ValueError(
                "camera index {} imageUrl={!r} could not be loaded: {}".format(
                    camera_index, image_url, error
                )
            ) from error
        image_height, image_width = image.shape[:2]
        if image_width != calibration.width or image_height != calibration.height:
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
        detections, metadata = self._detect(camera_index, image_url, image)
        boxes: List[Box3D] = []
        rejections: List[Dict[str, object]] = []
        for detection_index, detection in enumerate(detections):
            try:
                keypoint_detection = KeypointDetection(
                    model_class=self._labels[detection.class_id],
                    confidence=detection.score,
                    view_index=camera_index,
                    keypoints=self._image_keypoints(detection, metadata),
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
        return boxes, rejections
