from typing import NamedTuple, Tuple

import cv2
import numpy as np


INPUT_SIZE = 512
OUTPUT_STRIDE = 4
IMAGE_MEAN = (0.40789654, 0.44719302, 0.47026115)
IMAGE_STD = (0.28863828, 0.27408164, 0.27809835)


class PreprocessMetadata(NamedTuple):
    center: Tuple[float, float]
    scale: float
    input_size: Tuple[int, int]
    original_size: Tuple[int, int]


def _third_point(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    direction = first - second
    return second + np.asarray((-direction[1], direction[0]), dtype=np.float32)


def affine_transform(
    center: np.ndarray, scale: float, output_size: Tuple[int, int], inverse: bool
) -> np.ndarray:
    destination_width, destination_height = output_size
    source_direction = np.asarray((0.0, -0.5 * scale), dtype=np.float32)
    destination_direction = np.asarray(
        (0.0, -0.5 * destination_width), dtype=np.float32
    )
    source = np.zeros((3, 2), dtype=np.float32)
    destination = np.zeros((3, 2), dtype=np.float32)
    source[0] = center
    source[1] = center + source_direction
    destination[0] = (0.5 * destination_width, 0.5 * destination_height)
    destination[1] = destination[0] + destination_direction
    source[2] = _third_point(source[0], source[1])
    destination[2] = _third_point(destination[0], destination[1])
    if inverse:
        return cv2.getAffineTransform(destination, source)
    return cv2.getAffineTransform(source, destination)


def preprocess_bgr(image: np.ndarray) -> Tuple[np.ndarray, PreprocessMetadata]:
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError(
            "Expected a BGR image with shape (height, width, 3), got {}".format(
                image.shape
            )
        )
    height, width = image.shape[:2]
    if height <= 0 or width <= 0:
        raise ValueError("Image dimensions must be positive, got {}x{}".format(width, height))
    center = np.asarray((width / 2.0, height / 2.0), dtype=np.float32)
    scale = float(max(height, width))
    transform = affine_transform(center, scale, (INPUT_SIZE, INPUT_SIZE), inverse=False)
    warped = cv2.warpAffine(
        image,
        transform,
        (INPUT_SIZE, INPUT_SIZE),
        flags=cv2.INTER_LINEAR,
    )
    normalized = warped.astype(np.float32) / 255.0
    normalized = (
        normalized - np.asarray(IMAGE_MEAN, dtype=np.float32)
    ) / np.asarray(IMAGE_STD, dtype=np.float32)
    tensor = np.ascontiguousarray(normalized.transpose(2, 0, 1)[None])
    metadata = PreprocessMetadata(
        center=(float(center[0]), float(center[1])),
        scale=scale,
        input_size=(INPUT_SIZE, INPUT_SIZE),
        original_size=(width, height),
    )
    return tensor, metadata


def transform_output_points(
    points: np.ndarray, metadata: PreprocessMetadata
) -> np.ndarray:
    if points.shape[-1] != 2:
        raise ValueError("Expected points ending in two coordinates, got {}".format(points.shape))
    output_size = (INPUT_SIZE // OUTPUT_STRIDE, INPUT_SIZE // OUTPUT_STRIDE)
    transform = affine_transform(
        np.asarray(metadata.center, dtype=np.float32),
        metadata.scale,
        output_size,
        inverse=True,
    )
    flattened = points.reshape(-1, 2)
    homogeneous = np.concatenate(
        (flattened, np.ones((flattened.shape[0], 1), dtype=np.float32)), axis=1
    )
    return np.matmul(homogeneous, transform.T).reshape(points.shape).astype(np.float32)
