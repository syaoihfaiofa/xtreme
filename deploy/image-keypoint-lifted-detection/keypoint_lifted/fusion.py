import math
from typing import List, Sequence, Tuple

from keypoint_lifted.schemas import Box3D


Point = Tuple[float, float]


def _box_polygon(box: Box3D) -> List[Point]:
    half_length = box.size3D.x / 2.0
    half_width = box.size3D.y / 2.0
    yaw = box.rotation3D.z
    cosine = math.cos(yaw)
    sine = math.sin(yaw)
    polygon = []
    for local_x, local_y in (
        (-half_length, -half_width),
        (half_length, -half_width),
        (half_length, half_width),
        (-half_length, half_width),
    ):
        polygon.append(
            (
                box.center3D.x + local_x * cosine - local_y * sine,
                box.center3D.y + local_x * sine + local_y * cosine,
            )
        )
    return polygon


def _signed_area(polygon: Sequence[Point]) -> float:
    return 0.5 * sum(
        point[0] * polygon[(index + 1) % len(polygon)][1]
        - polygon[(index + 1) % len(polygon)][0] * point[1]
        for index, point in enumerate(polygon)
    )


def _inside(point: Point, edge_start: Point, edge_end: Point) -> bool:
    return (
        (edge_end[0] - edge_start[0]) * (point[1] - edge_start[1])
        - (edge_end[1] - edge_start[1]) * (point[0] - edge_start[0])
    ) >= -1e-9


def _line_intersection(
    start: Point, end: Point, edge_start: Point, edge_end: Point
) -> Point:
    direction = (end[0] - start[0], end[1] - start[1])
    edge_direction = (
        edge_end[0] - edge_start[0],
        edge_end[1] - edge_start[1],
    )
    denominator = (
        direction[0] * edge_direction[1] - direction[1] * edge_direction[0]
    )
    if abs(denominator) <= 1e-12:
        return end
    offset = (edge_start[0] - start[0], edge_start[1] - start[1])
    ratio = (
        offset[0] * edge_direction[1] - offset[1] * edge_direction[0]
    ) / denominator
    return (
        start[0] + ratio * direction[0],
        start[1] + ratio * direction[1],
    )


def _clip(subject: Sequence[Point], clip_polygon: Sequence[Point]) -> List[Point]:
    output = list(subject)
    for edge_index, edge_start in enumerate(clip_polygon):
        if not output:
            break
        edge_end = clip_polygon[(edge_index + 1) % len(clip_polygon)]
        input_polygon = output
        output = []
        start = input_polygon[-1]
        for end in input_polygon:
            if _inside(end, edge_start, edge_end):
                if not _inside(start, edge_start, edge_end):
                    output.append(_line_intersection(start, end, edge_start, edge_end))
                output.append(end)
            elif _inside(start, edge_start, edge_end):
                output.append(_line_intersection(start, end, edge_start, edge_end))
            start = end
    return output


def bev_iou(first: Box3D, second: Box3D) -> float:
    if min(first.size3D.x, first.size3D.y, second.size3D.x, second.size3D.y) <= 0.0:
        return 0.0
    first_polygon = _box_polygon(first)
    second_polygon = _box_polygon(second)
    intersection = _clip(first_polygon, second_polygon)
    intersection_area = (
        abs(_signed_area(intersection)) if len(intersection) >= 3 else 0.0
    )
    first_area = first.size3D.x * first.size3D.y
    second_area = second.size3D.x * second.size3D.y
    union_area = first_area + second_area - intersection_area
    return intersection_area / union_area if union_area > 0.0 else 0.0


def _merge_sources(retained: Box3D, discarded: Box3D) -> Box3D:
    observations = list(
        zip(retained.source_view_indexes, retained.source_keypoints)
    ) + list(zip(discarded.source_view_indexes, discarded.source_keypoints))
    observations.sort(key=lambda observation: observation[0])
    view_indexes = tuple(observation[0] for observation in observations)
    keypoints = tuple(observation[1] for observation in observations)
    return retained._replace(
        source_view_indexes=view_indexes,
        source_keypoints=keypoints,
    )


def fuse_bev_boxes(
    boxes: Sequence[Box3D], iou_threshold: float
) -> List[Box3D]:
    if not 0.0 <= iou_threshold <= 1.0:
        raise ValueError("iou_threshold must be between 0 and 1")
    ordered = sorted(
        enumerate(boxes),
        key=lambda indexed_box: (-indexed_box[1].confidence, indexed_box[0]),
    )
    fused = []
    for _, candidate in ordered:
        match_index = next(
            (
                index
                for index, retained in enumerate(fused)
                if retained.modelClass == candidate.modelClass
                and bev_iou(retained, candidate) >= iou_threshold
            ),
            None,
        )
        if match_index is None:
            fused.append(candidate)
        else:
            fused[match_index] = _merge_sources(fused[match_index], candidate)
    return fused
