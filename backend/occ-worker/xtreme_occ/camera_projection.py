"""Camera-config parsing and NumPy-only pinhole/fisheye projection."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np


Camera = Dict[str, object]
SURROUND_CAMERA_NAMES = (
    "surround_front",
    "surround_left",
    "surround_back",
    "surround_right",
)
_CAMERA_TYPES = {0: "pinhole", 1: "fisheye"}


def load_surround_cameras(camera_config_json: Path) -> List[Camera]:
    """Parse the four surround cameras from an Xtreme camera_config JSON."""
    path = Path(camera_config_json)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise OSError(
            f"failed to read camera config {path}: {error}"
        ) from error
    except json.JSONDecodeError as error:
        raise ValueError(
            f"camera config {path} is not valid JSON: {error}"
        ) from error

    if isinstance(raw, list):
        configs = _flat_camera_configs(raw, path)
    elif isinstance(raw, dict) and isinstance(raw.get("cameras"), dict):
        configs = raw["cameras"]
    else:
        raise ValueError(
            f"camera config {path} must be a list or contain a cameras object"
        )

    cameras = []
    for name in SURROUND_CAMERA_NAMES:
        config = configs.get(name)
        if not isinstance(config, dict):
            raise ValueError(f"camera config {path} has no camera {name!r}")
        cameras.append(_parse_camera(name, config, path))
    return cameras


def project_points(
    camera: Mapping[str, object], points_xyz: np.ndarray
) -> Tuple[np.ndarray, np.ndarray]:
    """Project 3D points and return pixels plus a strict image-range mask."""
    points = np.asarray(points_xyz, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 3:
        raise ValueError(
            f"points_xyz must have shape (N, 3), got {points.shape}"
        )
    if not np.all(np.isfinite(points)):
        raise ValueError("points_xyz must contain only finite values")

    rotation = _matrix(camera.get("R"), "camera R", (3, 3))
    translation = _matrix(camera.get("t"), "camera t", (3,))
    camera_points = points @ rotation.T + translation
    camera_type = _camera_type(camera.get("type"))
    fx = _finite_number(camera.get("fx"), "camera fx")
    fy = _finite_number(camera.get("fy"), "camera fy")
    cx = _finite_number(camera.get("cx"), "camera cx")
    cy = _finite_number(camera.get("cy"), "camera cy")
    width = _positive_integer(camera.get("width"), "camera width")
    height = _positive_integer(camera.get("height"), "camera height")

    if camera_type == "pinhole":
        pixels, valid = _project_pinhole(
            camera_points, fx, fy, cx, cy
        )
    else:
        distortion = tuple(
            _finite_number(camera.get(key, 0.0), f"camera {key}")
            for key in ("k1", "k2", "k3", "k4")
        )
        pixels = _project_fisheye(
            camera_points, fx, fy, cx, cy, distortion
        )
        valid = np.ones(points.shape[0], dtype=bool)

    in_image = (
        valid
        & (pixels[:, 0] >= 0.0)
        & (pixels[:, 0] < width)
        & (pixels[:, 1] >= 0.0)
        & (pixels[:, 1] < height)
    )
    return pixels, in_image


def camera_fov_mask(
    pc_range: Sequence[float],
    voxel_size: float,
    cameras: Sequence[Mapping[str, object]],
    candidate_mask: Optional[np.ndarray] = None,
) -> np.ndarray:
    """Return candidate voxels whose centers lie in at least one camera FOV."""
    bounds = np.asarray(pc_range, dtype=np.float64)
    if bounds.shape != (6,) or not np.all(np.isfinite(bounds)):
        raise ValueError(f"pc_range must contain 6 finite values, got {pc_range}")
    dimensions = (bounds[3:] - bounds[:3]) / voxel_size
    shape = tuple(int(value) for value in np.rint(dimensions))
    if not cameras:
        raise ValueError("occVisibility requires four surround camera calibrations")
    if len(cameras) != len(SURROUND_CAMERA_NAMES):
        raise ValueError(
            "occVisibility requires four surround camera calibrations, "
            f"got {len(cameras)}"
        )
    if candidate_mask is None:
        candidates = np.ones(shape, dtype=bool)
    else:
        candidates = np.asarray(candidate_mask)
        if candidates.shape != shape:
            raise ValueError(
                "candidate_mask must have shape "
                f"{shape}, got {candidates.shape}"
            )
        if candidates.dtype != np.bool_:
            raise TypeError(
                "candidate_mask must have boolean dtype, "
                f"got {candidates.dtype}"
            )
    indices = np.argwhere(candidates)
    result = np.zeros(shape, dtype=bool)
    if indices.size == 0:
        return result
    centers = bounds[:3] + (indices + 0.5) * voxel_size
    visible = np.zeros(centers.shape[0], dtype=bool)
    for camera in cameras:
        _, in_fov = project_points(camera, centers)
        visible |= in_fov
    result[tuple(indices.T)] = visible
    return result


def _flat_camera_configs(
    entries: Sequence[object], path: Path
) -> Dict[str, Mapping[str, object]]:
    configs = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError(
                f"camera config {path} list entries must be objects"
            )
        name = entry.get("camera_name")
        if name not in SURROUND_CAMERA_NAMES:
            continue
        if name in configs:
            raise ValueError(f"camera config {path} repeats camera {name!r}")
        configs[name] = entry
    return configs


def _parse_camera(
    name: str, config: Mapping[str, object], path: Path
) -> Camera:
    internal = config.get("camera_internal", config)
    distortion = config.get("distortion", config)
    if not isinstance(internal, dict) or not isinstance(distortion, dict):
        raise ValueError(
            f"camera {name!r} in {path} has invalid intrinsics or distortion"
        )

    if "camera_external" in config:
        rotation, translation = _external_matrix(config, name, path)
    elif "rvec" in config and "tvec" in config:
        rotation = _rodrigues(
            _matrix(config["rvec"], f"camera {name} rvec", (3,))
        )
        translation = _matrix(
            config["tvec"], f"camera {name} tvec", (3,)
        )
    elif "R" in config and "t" in config:
        rotation = _matrix(config["R"], f"camera {name} R", (3, 3))
        translation = _matrix(config["t"], f"camera {name} t", (3,))
    else:
        raise ValueError(
            f"camera {name!r} in {path} has no supported extrinsics"
        )

    camera_type_value = config.get("type", config.get("camera_type", "fisheye"))
    return {
        "name": name,
        "type": _camera_type(camera_type_value),
        "width": _positive_integer(config.get("width"), f"camera {name} width"),
        "height": _positive_integer(
            config.get("height"), f"camera {name} height"
        ),
        "fx": _finite_number(internal.get("fx"), f"camera {name} fx"),
        "fy": _finite_number(internal.get("fy"), f"camera {name} fy"),
        "cx": _finite_number(internal.get("cx"), f"camera {name} cx"),
        "cy": _finite_number(internal.get("cy"), f"camera {name} cy"),
        "k1": _finite_number(distortion.get("k1", 0.0), f"camera {name} k1"),
        "k2": _finite_number(distortion.get("k2", 0.0), f"camera {name} k2"),
        "k3": _finite_number(distortion.get("k3", 0.0), f"camera {name} k3"),
        "k4": _finite_number(distortion.get("k4", 0.0), f"camera {name} k4"),
        "R": rotation,
        "t": translation,
    }


def _external_matrix(
    config: Mapping[str, object], name: str, path: Path
) -> Tuple[np.ndarray, np.ndarray]:
    external = np.asarray(config["camera_external"], dtype=np.float64)
    if external.size != 16 or not np.all(np.isfinite(external)):
        raise ValueError(
            f"camera {name!r} in {path} camera_external must contain "
            "16 finite values"
        )
    matrix = external.reshape(4, 4)
    if not config.get("rowMajor", False):
        matrix = matrix.T
    return matrix[:3, :3], matrix[:3, 3]


def _rodrigues(rotation_vector: np.ndarray) -> np.ndarray:
    angle = float(np.linalg.norm(rotation_vector))
    if angle <= np.finfo(np.float64).eps:
        return np.eye(3, dtype=np.float64)
    axis = rotation_vector / angle
    cross = np.array(
        [
            [0.0, -axis[2], axis[1]],
            [axis[2], 0.0, -axis[0]],
            [-axis[1], axis[0], 0.0],
        ]
    )
    return (
        np.eye(3)
        + np.sin(angle) * cross
        + (1.0 - np.cos(angle)) * (cross @ cross)
    )


def _project_pinhole(
    points: np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
) -> Tuple[np.ndarray, np.ndarray]:
    depth = points[:, 2]
    valid = depth > 0.0
    pixels = np.full((points.shape[0], 2), np.nan, dtype=np.float64)
    pixels[valid, 0] = fx * points[valid, 0] / depth[valid] + cx
    pixels[valid, 1] = fy * points[valid, 1] / depth[valid] + cy
    return pixels, valid


def _project_fisheye(
    points: np.ndarray,
    fx: float,
    fy: float,
    cx: float,
    cy: float,
    distortion: Tuple[float, float, float, float],
) -> np.ndarray:
    x = points[:, 0]
    y = points[:, 1]
    radius = np.hypot(x, y)
    theta = np.arctan2(radius, points[:, 2])
    theta_squared = theta * theta
    k1, k2, k3, k4 = distortion
    distorted_theta = theta * (
        1.0
        + k1 * theta_squared
        + k2 * theta_squared**2
        + k3 * theta_squared**3
        + k4 * theta_squared**4
    )
    scale = np.divide(
        distorted_theta,
        radius,
        out=np.ones_like(radius),
        where=radius > 1e-9,
    )
    return np.column_stack((fx * x * scale + cx, fy * y * scale + cy))


def _camera_type(value: object) -> str:
    if isinstance(value, str):
        camera_type = value.lower()
    elif isinstance(value, (int, np.integer)) and not isinstance(value, bool):
        camera_type = _CAMERA_TYPES.get(int(value), "")
    else:
        camera_type = ""
    if camera_type not in ("pinhole", "fisheye"):
        raise ValueError(
            f"camera type must be 'pinhole', 'fisheye', 0, or 1, got {value!r}"
        )
    return camera_type


def _matrix(value: object, label: str, shape: Tuple[int, ...]) -> np.ndarray:
    matrix = np.asarray(value, dtype=np.float64)
    if matrix.shape != shape:
        raise ValueError(f"{label} must have shape {shape}, got {matrix.shape}")
    if not np.all(np.isfinite(matrix)):
        raise ValueError(f"{label} must contain only finite values")
    return matrix


def _finite_number(value: object, label: str) -> float:
    if (
        not isinstance(value, (int, float, np.integer, np.floating))
        or isinstance(value, (bool, np.bool_))
    ):
        raise TypeError(f"{label} must be numeric, got {value!r}")
    result = float(value)
    if not np.isfinite(result):
        raise ValueError(f"{label} must be finite, got {value!r}")
    return result


def _positive_integer(value: object, label: str) -> int:
    number = _finite_number(value, label)
    if number <= 0.0 or not number.is_integer():
        raise ValueError(f"{label} must be a positive integer, got {value!r}")
    return int(number)
