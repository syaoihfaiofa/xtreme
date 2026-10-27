from pathlib import Path
from typing import Dict, Mapping, NamedTuple, Tuple

import cv2
import numpy as np
import yaml


INPUT_SIZE = 512
LETTERBOX_PAD_VALUE = 114


class CropWindow(NamedTuple):
    x0: int
    y0: int
    width: int
    height: int


class CropFractions(NamedTuple):
    """Crop bounds as fractions of the full-frame width and height."""

    x_start: float
    x_end: float
    y_start: float
    y_end: float


class PreprocessMetadata(NamedTuple):
    crop: CropWindow
    gain: float
    pad: Tuple[int, int]
    input_size: int


def _parse_crop_fractions(camera_index: int, raw_window: object) -> CropFractions:
    if not isinstance(raw_window, Mapping):
        raise ValueError(
            "camera {} crop window must be an object with x and y, got {!r}".format(
                camera_index, raw_window
            )
        )
    bounds = []
    for axis in ("x", "y"):
        raw_range = raw_window.get(axis)
        if not isinstance(raw_range, list) or len(raw_range) != 2:
            raise ValueError(
                "camera {} crop window {} must be [start, end], got {!r}".format(
                    camera_index, axis, raw_range
                )
            )
        start, end = float(raw_range[0]), float(raw_range[1])
        if not 0.0 <= start < end <= 1.0:
            raise ValueError(
                "camera {} crop window {} must satisfy 0 <= start < end <= 1, "
                "got {!r}".format(camera_index, axis, raw_range)
            )
        bounds.extend((start, end))
    return CropFractions(*bounds)


def load_crop_windows(path: Path) -> Dict[int, CropFractions]:
    """Load per-camera crop fractions keyed by camera index (camera_image_N)."""
    with path.open("r", encoding="utf-8") as config_file:
        raw_windows = yaml.safe_load(config_file)
    if not isinstance(raw_windows, dict) or not raw_windows:
        raise ValueError("Crop window config must be a non-empty object: {}".format(path))
    windows: Dict[int, CropFractions] = {}
    for raw_index, raw_window in raw_windows.items():
        if isinstance(raw_index, bool) or not isinstance(raw_index, int) or raw_index < 0:
            raise ValueError(
                "Crop window config keys must be non-negative camera indexes, got {!r}: "
                "{}".format(raw_index, path)
            )
        windows[raw_index] = _parse_crop_fractions(raw_index, raw_window)
    return windows


def crop_window_from_fractions(
    width: int, height: int, fractions: CropFractions
) -> CropWindow:
    if width <= 0 or height <= 0:
        raise ValueError(
            "Image dimensions must be positive, got {}x{}".format(width, height)
        )
    x0 = int(round(width * fractions.x_start))
    x1 = int(round(width * fractions.x_end))
    y0 = int(round(height * fractions.y_start))
    y1 = int(round(height * fractions.y_end))
    if x1 <= x0 or y1 <= y0:
        raise ValueError(
            "crop fractions {!r} yield an empty crop for {}x{}".format(
                fractions, width, height
            )
        )
    return CropWindow(x0=x0, y0=y0, width=x1 - x0, height=y1 - y0)


def preprocess_bgr(
    image: np.ndarray, fractions: CropFractions, input_size: int
) -> Tuple[np.ndarray, PreprocessMetadata]:
    """Crop, then Ultralytics-compatible letterbox to a square RGB NCHW tensor."""
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError(
            "Expected a BGR image with shape (height, width, 3), got {}".format(
                image.shape
            )
        )
    height, width = image.shape[:2]
    crop = crop_window_from_fractions(width, height, fractions)
    cropped = image[crop.y0 : crop.y0 + crop.height, crop.x0 : crop.x0 + crop.width]

    gain = min(input_size / crop.height, input_size / crop.width)
    resized_width = int(round(crop.width * gain))
    resized_height = int(round(crop.height * gain))
    half_pad_x = (input_size - resized_width) / 2.0
    half_pad_y = (input_size - resized_height) / 2.0
    left = int(round(half_pad_x - 0.1))
    right = int(round(half_pad_x + 0.1))
    top = int(round(half_pad_y - 0.1))
    bottom = int(round(half_pad_y + 0.1))
    if (resized_width, resized_height) != (crop.width, crop.height):
        cropped = cv2.resize(
            cropped, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR
        )
    letterboxed = cv2.copyMakeBorder(
        cropped,
        top,
        bottom,
        left,
        right,
        cv2.BORDER_CONSTANT,
        value=(LETTERBOX_PAD_VALUE,) * 3,
    )
    rgb = letterboxed[..., ::-1].astype(np.float32) / 255.0
    tensor = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])
    metadata = PreprocessMetadata(
        crop=crop, gain=gain, pad=(left, top), input_size=input_size
    )
    return tensor, metadata


def input_to_image_points(
    points: np.ndarray, metadata: PreprocessMetadata
) -> np.ndarray:
    """Map model-input pixel coordinates back to full-frame image pixels.

    Lifting uses the original full-frame calibration, so the crop offset and
    letterbox gain must be undone here rather than adjusting the intrinsics.
    """
    if points.shape[-1] != 2:
        raise ValueError(
            "Expected points ending in two coordinates, got {}".format(points.shape)
        )
    mapped = points.astype(np.float64).copy()
    mapped[..., 0] = (mapped[..., 0] - metadata.pad[0]) / metadata.gain + metadata.crop.x0
    mapped[..., 1] = (mapped[..., 1] - metadata.pad[1]) / metadata.gain + metadata.crop.y0
    return mapped
