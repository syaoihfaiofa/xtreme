from typing import List, Mapping, NamedTuple, Tuple

import cv2
import numpy as np

from .preprocessing import PreprocessMetadata, transform_output_points


class PolylineDetection(NamedTuple):
    class_id: int
    score: float
    points: Tuple[Tuple[float, float], ...]
    point_scores: Tuple[float, ...]


def _sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(values, -80.0, 80.0)))


def _weighted_point(points: List[Tuple[float, float, float]]) -> Tuple[float, float, float]:
    current = points[0]
    for candidate in points[1:]:
        denominator = (candidate[2] + current[2]) * 2.0
        offset = 0.0 if denominator == 0.0 else (candidate[2] - current[2]) / denominator
        current = (
            (candidate[0] + current[0]) / 2.0
            + (candidate[0] - current[0]) * offset,
            (candidate[1] + current[1]) / 2.0
            + (candidate[1] - current[1]) * offset,
            (candidate[2] + current[2]) / 2.0
            + (candidate[2] - current[2]) * offset,
        )
    return current


def _connected(
    first_bin: int,
    second_bin: int,
    raw_bins: List[List[Tuple[float, float, float]]],
    output_width: int,
) -> bool:
    first_y = [point[1] for point in raw_bins[first_bin]]
    second_y = [point[1] for point in raw_bins[second_bin]]
    if not first_y or not second_y:
        return False
    first_min, first_max = min(first_y), max(first_y)
    second_min, second_max = min(second_y), max(second_y)
    if first_min <= second_min <= first_max or first_min <= second_max <= first_max:
        return True
    return min(
        abs(first_min - second_min),
        abs(first_max - second_min),
        abs(first_min - second_max),
        abs(first_max - second_max),
    ) <= 1.0 / output_width


def decode_polylines(
    heads: Mapping[str, np.ndarray],
    metadata: PreprocessMetadata,
    score_threshold: float,
    top_k: int,
) -> List[PolylineDetection]:
    heatmap = heads["sktpts_hm"]
    offsets = heads["sktpts_reg"]
    semantic_logits = heads["semantic_mask"]
    if heatmap.shape[:2] != (1, 6) or offsets.shape[:2] != (1, 2):
        raise ValueError("Unexpected polyline head shapes")
    if semantic_logits.shape[0] != 1 or semantic_logits.shape[1] != 7:
        raise ValueError("semantic_mask must have seven channels")
    if top_k <= 0 or not 0.0 <= score_threshold <= 1.0:
        raise ValueError("Invalid polyline decoder parameters")

    probabilities = _sigmoid(heatmap.astype(np.float32))
    _, class_count, output_height, output_width = probabilities.shape
    flat = probabilities.reshape(-1)
    candidate_count = min(top_k, flat.size)
    indexes = np.argpartition(flat, -candidate_count)[-candidate_count:]
    indexes = indexes[np.argsort(-flat[indexes], kind="stable")]
    candidates: List[Tuple[int, float, float, float]] = []
    spatial_size = output_height * output_width
    for index in indexes:
        score = float(flat[index])
        if score < score_threshold:
            continue
        class_id = int(index // spatial_size)
        spatial_index = int(index % spatial_size)
        y, x = divmod(spatial_index, output_width)
        candidates.append(
            (
                class_id,
                float(x + offsets[0, 0, y, x]),
                float(y + offsets[0, 1, y, x]),
                score,
            )
        )

    semantic_mask = np.argmax(semantic_logits, axis=1)[0].astype(np.uint8)
    scale_x = semantic_mask.shape[1] / output_width
    scale_y = semantic_mask.shape[0] / output_height
    dilation = max(1, int(round(7.0 * semantic_mask.shape[0] / 512.0)))
    detections: List[PolylineDetection] = []
    for class_id in range(class_count):
        class_mask = np.zeros_like(semantic_mask)
        class_mask[semantic_mask == class_id + 1] = 255
        class_mask = cv2.dilate(
            class_mask, np.ones((dilation, 1), dtype=np.uint8)
        )
        contours = cv2.findContours(
            class_mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE
        )[0]
        class_candidates = [candidate for candidate in candidates if candidate[0] == class_id]
        for contour in contours:
            grouped = [
                candidate
                for candidate in class_candidates
                if cv2.pointPolygonTest(
                    contour,
                    (candidate[1] * scale_x, candidate[2] * scale_y),
                    False,
                )
                >= 0
            ]
            if not grouped:
                continue
            raw_bins: List[List[Tuple[float, float, float]]] = [
                [] for _ in range(output_width)
            ]
            for _, x, y, score in grouped:
                bin_index = min(output_width - 1, max(0, int(x)))
                raw_bins[bin_index].append((x / output_width, y / output_height, score))
            consolidated: List[Tuple[int, Tuple[float, float, float]]] = []
            for bin_index, points in enumerate(raw_bins):
                if points:
                    point = _weighted_point(points)
                    if point[2] > score_threshold:
                        consolidated.append((bin_index, point))
            segment: List[Tuple[float, float, float]] = []
            segments: List[List[Tuple[float, float, float]]] = []
            previous_bin = -1
            for bin_index, point in consolidated:
                if (
                    segment
                    and not _connected(previous_bin, bin_index, raw_bins, output_width)
                ):
                    segments.append(segment)
                    segment = []
                segment.append(point)
                previous_bin = bin_index
            if segment:
                segments.append(segment)
            for normalized_points in segments:
                if len(normalized_points) < 2:
                    continue
                output_points = np.asarray(
                    [
                        (point[0] * output_width, point[1] * output_height)
                        for point in normalized_points
                    ],
                    dtype=np.float32,
                )
                image_points = transform_output_points(output_points, metadata)
                detections.append(
                    PolylineDetection(
                        class_id=class_id,
                        score=float(
                            sum(point[2] for point in normalized_points)
                            / len(normalized_points)
                        ),
                        points=tuple(
                            (float(point[0]), float(point[1])) for point in image_points
                        ),
                        point_scores=tuple(
                            float(point[2]) for point in normalized_points
                        ),
                    )
                )
    return detections
