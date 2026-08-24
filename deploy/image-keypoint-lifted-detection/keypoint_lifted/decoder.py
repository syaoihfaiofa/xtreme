from typing import List, Mapping, Optional, cast

import numpy as np

from .matching import Detection, Keypoints
from .preprocessing import OUTPUT_STRIDE, PreprocessMetadata, transform_output_points


REQUIRED_HEADS = ("hm", "reg", "wh", "hps", "hm_hp", "hp_offset")


def _sigmoid(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values, -80.0, 80.0)
    return 1.0 / (1.0 + np.exp(-clipped))


def _local_maximum(heatmap: np.ndarray) -> np.ndarray:
    padded = np.pad(
        heatmap, ((0, 0), (0, 0), (1, 1), (1, 1)), mode="constant"
    )
    neighbors = [
        padded[:, :, row : row + heatmap.shape[2], column : column + heatmap.shape[3]]
        for row in range(3)
        for column in range(3)
    ]
    maxima = np.maximum.reduce(neighbors)
    return heatmap * (heatmap == maxima)


def _validate_heads(heads: Mapping[str, np.ndarray]) -> None:
    missing = [name for name in REQUIRED_HEADS if name not in heads]
    if missing:
        raise ValueError("Missing decoder heads: {}".format(", ".join(missing)))
    shapes = {name: heads[name].shape for name in REQUIRED_HEADS}
    if any(len(shape) != 4 or shape[0] != 1 for shape in shapes.values()):
        raise ValueError("Decoder expects batch-one NCHW heads, got {}".format(shapes))
    spatial_shapes = {shape[2:] for shape in shapes.values()}
    if len(spatial_shapes) != 1:
        raise ValueError("Decoder head spatial shapes differ: {}".format(shapes))
    expected_channels = {
        "hm": 15,
        "reg": 2,
        "wh": 2,
        "hps": 8,
        "hm_hp": 4,
        "hp_offset": 2,
    }
    invalid = [
        "{}={}".format(name, shapes[name][1])
        for name, channels in expected_channels.items()
        if shapes[name][1] != channels
    ]
    if invalid:
        raise ValueError("Unexpected decoder channels: {}".format(", ".join(invalid)))


def _refine_keypoints(
    points: np.ndarray,
    bbox: np.ndarray,
    keypoint_heatmap: np.ndarray,
    keypoint_offsets: np.ndarray,
    top_k: int,
) -> np.ndarray:
    refined = points.copy()
    _, joint_count, height, width = keypoint_heatmap.shape
    candidate_count = min(top_k, height * width)
    for joint_index in range(joint_count):
        scores = keypoint_heatmap[0, joint_index].reshape(-1)
        indices = np.argpartition(scores, -candidate_count)[-candidate_count:]
        indices = indices[np.argsort(-scores[indices], kind="stable")]
        y_positions, x_positions = np.divmod(indices, width)
        candidates = np.stack(
            (
                x_positions + keypoint_offsets[0, 0, y_positions, x_positions],
                y_positions + keypoint_offsets[0, 1, y_positions, x_positions],
            ),
            axis=1,
        ).astype(np.float32)
        distances = np.linalg.norm(candidates - points[joint_index], axis=1)
        nearest_index = int(np.argmin(distances))
        candidate = candidates[nearest_index]
        maximum_dimension = max(bbox[2] - bbox[0], bbox[3] - bbox[1])
        is_valid = (
            scores[indices[nearest_index]] >= 0.1
            and bbox[0] <= candidate[0] <= bbox[2]
            and bbox[1] <= candidate[1] <= bbox[3]
            and distances[nearest_index] <= maximum_dimension * 0.3
        )
        if is_valid:
            refined[joint_index] = candidate
    return refined


def decode_quads(
    heads: Mapping[str, np.ndarray],
    score_threshold: float,
    top_k: int,
    metadata: Optional[PreprocessMetadata] = None,
) -> List[Detection]:
    _validate_heads(heads)
    if not 0.0 <= score_threshold <= 1.0:
        raise ValueError("score_threshold must be in [0, 1], got {}".format(score_threshold))
    if top_k <= 0:
        raise ValueError("top_k must be positive, got {}".format(top_k))
    heatmap = _local_maximum(_sigmoid(heads["hm"].astype(np.float32)))
    keypoint_heatmap = _local_maximum(
        _sigmoid(heads["hm_hp"].astype(np.float32))
    )
    _, class_count, height, width = heatmap.shape
    flattened = heatmap.reshape(class_count, height * width)
    candidate_count = min(top_k, flattened.size)
    flat_scores = flattened.reshape(-1)
    indices = np.argpartition(flat_scores, -candidate_count)[-candidate_count:]
    indices = indices[np.argsort(-flat_scores[indices], kind="stable")]
    detections = []
    for flat_index in indices:
        score = float(flat_scores[flat_index])
        if score < score_threshold:
            continue
        class_id = int(flat_index // (height * width))
        spatial_index = int(flat_index % (height * width))
        y_position, x_position = divmod(spatial_index, width)
        center_x = x_position + float(heads["reg"][0, 0, y_position, x_position])
        center_y = y_position + float(heads["reg"][0, 1, y_position, x_position])
        box_width = float(heads["wh"][0, 0, y_position, x_position])
        box_height = float(heads["wh"][0, 1, y_position, x_position])
        bbox = np.asarray(
            (
                center_x - box_width / 2.0,
                center_y - box_height / 2.0,
                center_x + box_width / 2.0,
                center_y + box_height / 2.0,
            ),
            dtype=np.float32,
        )
        offsets = heads["hps"][0, :, y_position, x_position].reshape(4, 2)
        points = offsets + np.asarray((x_position, y_position), dtype=np.float32)
        points = _refine_keypoints(
            points,
            bbox,
            keypoint_heatmap,
            heads["hp_offset"].astype(np.float32),
            top_k,
        )
        if metadata is None:
            points = points * OUTPUT_STRIDE
        else:
            points = transform_output_points(points, metadata)
        keypoints = cast(
            Keypoints, tuple(float(value) for value in points.reshape(-1))
        )
        detections.append(
            Detection(
                class_id=class_id,
                score=score,
                keypoints=keypoints,
            )
        )
    return detections
