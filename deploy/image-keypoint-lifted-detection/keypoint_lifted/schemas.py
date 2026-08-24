from collections import OrderedDict
import json
import math
from pathlib import Path
from typing import Mapping, NamedTuple, Optional, Tuple, cast

import numpy as np
import yaml


Keypoints = Tuple[float, float, float, float, float, float, float, float]
Distortion = Tuple[float, float, float, float]
_MISSING = object()


def _normalized_value(
    payload: Mapping[str, object],
    canonical_key: str,
    aliases: Tuple[str, ...],
    default: object = _MISSING,
) -> object:
    for key in (canonical_key,) + aliases:
        if key in payload:
            return payload[key]
    if default is not _MISSING:
        return default
    raise ValueError(
        "Missing camera calibration key {!r}; accepted aliases: {!r}".format(
            canonical_key, aliases
        )
    )


class CameraIntrinsics(NamedTuple):
    fx: float
    fy: float
    cx: float
    cy: float


class CameraCalibration:
    __slots__ = ("intrinsics", "camera_external", "width", "height")

    camera_model = ""

    def __init__(
        self,
        intrinsics: CameraIntrinsics,
        camera_external: np.ndarray,
        width: int,
        height: int,
    ) -> None:
        self.intrinsics = intrinsics
        self.camera_external = camera_external
        self.width = width
        self.height = height

    @property
    def distortion(self) -> Optional[Distortion]:
        raise NotImplementedError

    @property
    def distortion_vector(self) -> np.ndarray:
        raise NotImplementedError

    @classmethod
    def from_xtreme(cls, payload: Mapping[str, object]) -> "CameraCalibration":
        model = str(
            _normalized_value(
                payload, "cameraModel", ("camera_model",), default="pinhole"
            )
        ).lower()
        if model not in ("pinhole", "fisheye"):
            raise ValueError("Unsupported cameraModel: {!r}".format(model))

        internal = cast(
            Mapping[str, object],
            _normalized_value(payload, "cameraInternal", ("camera_internal",)),
        )
        if not isinstance(internal, Mapping):
            raise ValueError("cameraInternal must be an object")
        intrinsics = CameraIntrinsics(
            fx=float(internal["fx"]),
            fy=float(internal["fy"]),
            cx=float(internal["cx"]),
            cy=float(internal["cy"]),
        )
        if not np.isfinite(intrinsics).all() or intrinsics.fx <= 0.0 or intrinsics.fy <= 0.0:
            raise ValueError("cameraInternal must contain finite positive focal lengths")

        external_values = _normalized_value(
            payload, "cameraExternal", ("camera_external",)
        )
        if not isinstance(external_values, (list, tuple)) or len(external_values) != 16:
            raise ValueError("cameraExternal must contain 16 values")
        external = np.asarray(external_values, dtype=np.float64).reshape(
            (4, 4), order="C" if bool(payload.get("rowMajor", True)) else "F"
        )
        if not np.isfinite(external).all():
            raise ValueError("cameraExternal must contain only finite values")
        if abs(float(np.linalg.det(external))) <= 1e-12:
            raise ValueError("cameraExternal must be invertible")

        if model == "fisheye":
            raw_distortion = cast(
                Mapping[str, object],
                _normalized_value(
                    payload,
                    "distortion",
                    ("cameraDistortion", "camera_distortion"),
                ),
            )
            if not isinstance(raw_distortion, Mapping):
                raise ValueError("fisheye calibration requires distortion")
            distortion = cast(
                Distortion,
                tuple(float(raw_distortion.get(name, 0.0)) for name in ("k1", "k2", "k3", "k4")),
            )
            if not np.isfinite(distortion).all():
                raise ValueError("distortion must contain only finite values")
            return FisheyeCalibration(
                intrinsics=intrinsics,
                camera_external=external,
                distortion=distortion,
                width=int(payload["width"]),
                height=int(payload["height"]),
            )
        return PinholeCalibration(
            intrinsics=intrinsics,
            camera_external=external,
            width=int(payload["width"]),
            height=int(payload["height"]),
        )

    @property
    def camera_matrix(self) -> np.ndarray:
        return np.array(
            (
                (self.intrinsics.fx, 0.0, self.intrinsics.cx),
                (0.0, self.intrinsics.fy, self.intrinsics.cy),
                (0.0, 0.0, 1.0),
            ),
            dtype=np.float64,
        )


class PinholeCalibration(CameraCalibration):
    camera_model = "pinhole"

    @property
    def distortion(self) -> Optional[Distortion]:
        return None

    @property
    def distortion_vector(self) -> np.ndarray:
        return np.zeros(4, dtype=np.float64)


class FisheyeCalibration(CameraCalibration):
    __slots__ = ("_distortion",)

    camera_model = "fisheye"

    def __init__(
        self,
        intrinsics: CameraIntrinsics,
        camera_external: np.ndarray,
        distortion: Distortion,
        width: int,
        height: int,
    ) -> None:
        super().__init__(intrinsics, camera_external, width, height)
        self._distortion = distortion

    @property
    def distortion(self) -> Distortion:
        return self._distortion

    @property
    def distortion_vector(self) -> np.ndarray:
        return np.asarray(self._distortion, dtype=np.float64)


class KeypointDetection(NamedTuple):
    model_class: str
    confidence: float
    view_index: int
    keypoints: Keypoints


class Vector3(NamedTuple):
    x: float
    y: float
    z: float


class Box3D(NamedTuple):
    objType: str
    modelClass: str
    confidence: float
    center3D: Vector3
    size3D: Vector3
    rotation3D: Vector3
    source_view_indexes: Tuple[int, ...]
    source_keypoints: Tuple[Keypoints, ...]


class GroundPolyline(NamedTuple):
    objType: str
    modelClass: str
    confidence: float
    points: Tuple[Vector3, ...]
    source_view_indexes: Tuple[int, ...]
    source_keypoints: Tuple[Tuple[float, ...], ...]


def parse_camera_config(
    payload: Mapping[str, object]
) -> Mapping[str, CameraCalibration]:
    calibrations = OrderedDict()
    for view_name, raw_calibration in payload.items():
        if not isinstance(raw_calibration, Mapping):
            raise ValueError(
                "Camera calibration for {!r} must be an object".format(view_name)
            )
        calibrations[str(view_name)] = CameraCalibration.from_xtreme(raw_calibration)
    if not calibrations:
        raise ValueError("camera_config must contain at least one camera")
    return calibrations


def load_height_defaults(path: Path) -> Mapping[str, float]:
    with path.open("r", encoding="utf-8") as config_file:
        raw_values = yaml.safe_load(config_file)
    if not isinstance(raw_values, dict) or not raw_values:
        raise ValueError("Height config must be a non-empty object: {}".format(path))

    heights = {str(name): float(value) for name, value in raw_values.items()}
    invalid = {
        name: height
        for name, height in heights.items()
        if not np.isfinite(height) or height <= 0.0
    }
    if invalid:
        raise ValueError("Height config contains invalid values: {!r}".format(invalid))
    return heights


def load_vehicle_ground_z(path: Path) -> float:
    with path.open("r", encoding="utf-8") as config_file:
        payload = json.load(config_file)
    if not isinstance(payload, Mapping):
        raise ValueError("Vehicle info must be a JSON object: {}".format(path))
    car_info = payload.get("car_info")
    if not isinstance(car_info, Mapping):
        raise ValueError("Vehicle info must contain a car_info object: {}".format(path))
    try:
        wheel_radius = float(car_info["wheel_radius"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(
            "Vehicle info must contain numeric car_info.wheel_radius: {}".format(path)
        ) from error
    if not math.isfinite(wheel_radius) or wheel_radius <= 0.0:
        raise ValueError(
            "Vehicle car_info.wheel_radius must be finite and positive: {!r}".format(
                wheel_radius
            )
        )
    return -wheel_radius
