from typing import List, Sequence, Tuple

import numpy as np

from .schemas import GroundPolyline, Vector3


def _coordinates(polyline: GroundPolyline) -> np.ndarray:
    return np.asarray([(point.x, point.y, point.z) for point in polyline.points])


def _merge_pair(
    first: GroundPolyline,
    second: GroundPolyline,
    distance_threshold: float,
) -> GroundPolyline:
    first_points = _coordinates(first)
    second_points = _coordinates(second)
    direct = np.linalg.norm(first_points[0, :2] - second_points[0, :2]) + np.linalg.norm(
        first_points[-1, :2] - second_points[-1, :2]
    )
    reverse = np.linalg.norm(first_points[0, :2] - second_points[-1, :2]) + np.linalg.norm(
        first_points[-1, :2] - second_points[0, :2]
    )
    if reverse < direct:
        second_points = second_points[::-1]

    distances = np.linalg.norm(
        first_points[:, None, :2] - second_points[None, :, :2], axis=2
    )
    matched_second: set[int] = set()
    merged_points: List[np.ndarray] = []
    match_count = 0
    for first_index, point in enumerate(first_points):
        second_index = int(np.argmin(distances[first_index]))
        if (
            distances[first_index, second_index] <= distance_threshold
            and second_index not in matched_second
        ):
            merged_points.append((point + second_points[second_index]) / 2.0)
            matched_second.add(second_index)
            match_count += 1
        else:
            merged_points.append(point)
    if match_count < 2:
        raise ValueError("Polylines do not have enough overlapping points")

    unmatched = [
        point for index, point in enumerate(second_points) if index not in matched_second
    ]
    for point in unmatched:
        distance_to_start = np.linalg.norm(point[:2] - merged_points[0][:2])
        distance_to_end = np.linalg.norm(point[:2] - merged_points[-1][:2])
        if distance_to_start < distance_to_end:
            merged_points.insert(0, point)
        else:
            merged_points.append(point)
    return GroundPolyline(
        objType="GROUND_POLYLINE",
        modelClass=first.modelClass,
        confidence=(first.confidence + second.confidence) / 2.0,
        points=tuple(Vector3(*map(float, point)) for point in merged_points),
        source_view_indexes=first.source_view_indexes + second.source_view_indexes,
        source_keypoints=first.source_keypoints + second.source_keypoints,
    )


def fuse_ground_polylines(
    polylines: Sequence[GroundPolyline], distance_threshold: float
) -> List[GroundPolyline]:
    if distance_threshold <= 0.0 or not np.isfinite(distance_threshold):
        raise ValueError("distance_threshold must be finite and positive")
    fused: List[GroundPolyline] = []
    for candidate in sorted(polylines, key=lambda item: -item.confidence):
        merged = False
        for index, existing in enumerate(fused):
            if existing.modelClass != candidate.modelClass:
                continue
            try:
                fused[index] = _merge_pair(
                    existing, candidate, distance_threshold
                )
            except ValueError:
                continue
            merged = True
            break
        if not merged:
            fused.append(candidate)
    return fused
