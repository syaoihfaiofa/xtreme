from math import hypot
from typing import List, NamedTuple, Sequence, Tuple


Point = Tuple[float, float]
Keypoints = Tuple[float, float, float, float, float, float, float, float]


class Detection(NamedTuple):
    class_id: int
    score: float
    keypoints: Keypoints


class DetectionMatch(NamedTuple):
    reference_index: int
    candidate_index: int
    keypoint_iou: float
    average_keypoint_error_px: float
    score_delta: float


class EquivalenceMetrics(NamedTuple):
    minimum_keypoint_iou: float
    average_keypoint_error_px: float
    maximum_score_delta: float
    match_count: int


class EquivalenceThresholds(NamedTuple):
    minimum_keypoint_iou: float
    maximum_average_keypoint_error_px: float
    maximum_score_delta: float


CONTRACT_THRESHOLDS = EquivalenceThresholds(
    minimum_keypoint_iou=0.99,
    maximum_average_keypoint_error_px=2.0,
    maximum_score_delta=0.02,
)


def _points(keypoints: Keypoints) -> List[Point]:
    return [(keypoints[index], keypoints[index + 1]) for index in range(0, 8, 2)]


def _signed_area(polygon: Sequence[Point]) -> float:
    return 0.5 * sum(
        point[0] * polygon[(index + 1) % len(polygon)][1]
        - polygon[(index + 1) % len(polygon)][0] * point[1]
        for index, point in enumerate(polygon)
    )


def _convex_hull(points: Sequence[Point]) -> List[Point]:
    ordered = sorted(set(points))
    if len(ordered) <= 1:
        return ordered

    def cross(origin: Point, first: Point, second: Point) -> float:
        return (first[0] - origin[0]) * (second[1] - origin[1]) - (
            first[1] - origin[1]
        ) * (second[0] - origin[0])

    lower = []
    for point in ordered:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0.0:
            lower.pop()
        lower.append(point)
    upper = []
    for point in reversed(ordered):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0.0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def _inside(point: Point, edge_start: Point, edge_end: Point) -> bool:
    return (
        (edge_end[0] - edge_start[0]) * (point[1] - edge_start[1])
        - (edge_end[1] - edge_start[1]) * (point[0] - edge_start[0])
    ) >= -1e-9


def _intersection(start: Point, end: Point, edge_start: Point, edge_end: Point) -> Point:
    direction = (end[0] - start[0], end[1] - start[1])
    edge_direction = (edge_end[0] - edge_start[0], edge_end[1] - edge_start[1])
    denominator = direction[0] * edge_direction[1] - direction[1] * edge_direction[0]
    if abs(denominator) < 1e-12:
        return end
    offset = (edge_start[0] - start[0], edge_start[1] - start[1])
    ratio = (offset[0] * edge_direction[1] - offset[1] * edge_direction[0]) / denominator
    return (start[0] + ratio * direction[0], start[1] + ratio * direction[1])


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
                    output.append(_intersection(start, end, edge_start, edge_end))
                output.append(end)
            elif _inside(start, edge_start, edge_end):
                output.append(_intersection(start, end, edge_start, edge_end))
            start = end
    return output


def keypoint_iou(first: Keypoints, second: Keypoints) -> float:
    first_polygon = _convex_hull(_points(first))
    second_polygon = _convex_hull(_points(second))
    if len(first_polygon) < 3 or len(second_polygon) < 3:
        return 0.0
    if _signed_area(first_polygon) < 0.0:
        first_polygon.reverse()
    if _signed_area(second_polygon) < 0.0:
        second_polygon.reverse()
    first_area = abs(_signed_area(first_polygon))
    second_area = abs(_signed_area(second_polygon))
    if first_area <= 0.0 or second_area <= 0.0:
        return 0.0
    intersection_polygon = _clip(first_polygon, second_polygon)
    intersection_area = abs(_signed_area(intersection_polygon)) if len(intersection_polygon) >= 3 else 0.0
    union_area = first_area + second_area - intersection_area
    return intersection_area / union_area if union_area > 0.0 else 0.0


def _average_keypoint_error(first: Keypoints, second: Keypoints) -> float:
    distances = [
        hypot(first[index] - second[index], first[index + 1] - second[index + 1])
        for index in range(0, 8, 2)
    ]
    return sum(distances) / len(distances)


def _minimum_cost_assignment(costs: Sequence[Sequence[float]]) -> List[int]:
    size = len(costs)
    if size == 0:
        return []
    if any(len(row) != size for row in costs):
        raise ValueError("Assignment cost matrix must be square")
    row_potential = [0.0] * (size + 1)
    column_potential = [0.0] * (size + 1)
    matched_row = [0] * (size + 1)
    previous_column = [0] * (size + 1)
    for row in range(1, size + 1):
        matched_row[0] = row
        minimum_values = [float("inf")] * (size + 1)
        used = [False] * (size + 1)
        column = 0
        while True:
            used[column] = True
            current_row = matched_row[column]
            delta = float("inf")
            next_column = 0
            for candidate_column in range(1, size + 1):
                if used[candidate_column]:
                    continue
                reduced_cost = (
                    costs[current_row - 1][candidate_column - 1]
                    - row_potential[current_row]
                    - column_potential[candidate_column]
                )
                if reduced_cost < minimum_values[candidate_column]:
                    minimum_values[candidate_column] = reduced_cost
                    previous_column[candidate_column] = column
                if minimum_values[candidate_column] < delta:
                    delta = minimum_values[candidate_column]
                    next_column = candidate_column
            for candidate_column in range(size + 1):
                if used[candidate_column]:
                    row_potential[matched_row[candidate_column]] += delta
                    column_potential[candidate_column] -= delta
                else:
                    minimum_values[candidate_column] -= delta
            column = next_column
            if matched_row[column] == 0:
                break
        while True:
            next_column = previous_column[column]
            matched_row[column] = matched_row[next_column]
            column = next_column
            if column == 0:
                break
    assignment = [-1] * size
    for column in range(1, size + 1):
        assignment[matched_row[column] - 1] = column - 1
    return assignment


def match_detections(
    reference: Sequence[Detection], candidate: Sequence[Detection]
) -> List[DetectionMatch]:
    matches = []
    class_ids = sorted({detection.class_id for detection in reference})
    for class_id in class_ids:
        reference_indices = [
            index
            for index, detection in enumerate(reference)
            if detection.class_id == class_id
        ]
        candidate_indices = [
            index
            for index, detection in enumerate(candidate)
            if detection.class_id == class_id
        ]
        if len(reference_indices) != len(candidate_indices):
            continue
        ious = [
            [
                keypoint_iou(
                    reference[reference_index].keypoints,
                    candidate[candidate_index].keypoints,
                )
                for candidate_index in candidate_indices
            ]
            for reference_index in reference_indices
        ]
        assignment = _minimum_cost_assignment(
            [[1.0 - iou for iou in row] for row in ious]
        )
        for local_reference_index, local_candidate_index in enumerate(assignment):
            reference_index = reference_indices[local_reference_index]
            candidate_index = candidate_indices[local_candidate_index]
            reference_detection = reference[reference_index]
            candidate_detection = candidate[candidate_index]
            matches.append(
                DetectionMatch(
                    reference_index=reference_index,
                    candidate_index=candidate_index,
                    keypoint_iou=ious[local_reference_index][local_candidate_index],
                    average_keypoint_error_px=_average_keypoint_error(
                        reference_detection.keypoints, candidate_detection.keypoints
                    ),
                    score_delta=abs(
                        reference_detection.score - candidate_detection.score
                    ),
                )
            )
    return sorted(matches, key=lambda match: match.reference_index)


def evaluate_equivalence(
    reference: Sequence[Detection], candidate: Sequence[Detection]
) -> EquivalenceMetrics:
    matches = match_detections(reference, candidate)
    if len(matches) != len(reference) or len(matches) != len(candidate):
        raise ValueError(
            "Detection sets do not have a complete class-aware match: "
            "reference={}, candidate={}, matches={}".format(
                len(reference), len(candidate), len(matches)
            )
        )
    if not matches:
        return EquivalenceMetrics(1.0, 0.0, 0.0, 0)
    return EquivalenceMetrics(
        minimum_keypoint_iou=min(match.keypoint_iou for match in matches),
        average_keypoint_error_px=sum(
            match.average_keypoint_error_px for match in matches
        )
        / len(matches),
        maximum_score_delta=max(match.score_delta for match in matches),
        match_count=len(matches),
    )


def is_equivalent(
    metrics: EquivalenceMetrics, thresholds: EquivalenceThresholds
) -> bool:
    return (
        metrics.match_count > 0
        and metrics.minimum_keypoint_iou >= thresholds.minimum_keypoint_iou
        and metrics.average_keypoint_error_px
        <= thresholds.maximum_average_keypoint_error_px
        and metrics.maximum_score_delta <= thresholds.maximum_score_delta
    )
