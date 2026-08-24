from __future__ import annotations

import math
from typing import Any


def associate_scene(body: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValueError("request body must be a JSON object")
    frames = body.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError("frames cannot be empty")
    config = body.get("config") or {}
    iou_threshold = float(config.get("iouThreshold") if config.get("iouThreshold") is not None else 0.3)
    distance_threshold = float(
        config.get("distanceThreshold") if config.get("distanceThreshold") is not None else 0.5
    )
    max_outside_frames = int(
        config.get("maxOutsideFrames") if config.get("maxOutsideFrames") is not None else 50
    )
    ordered = sorted(frames, key=lambda frame: _frame_index(frame))
    tracks: list[dict[str, Any]] = []
    next_track_id = 1
    associated: list[dict[str, Any]] = []
    for frame in ordered:
        pose = _require_pose(frame)
        objects = [dict(obj) for obj in (frame.get("objects") or []) if isinstance(obj, dict)]
        assignments = _match_frame(
            objects,
            pose,
            tracks,
            iou_threshold,
            distance_threshold,
            max_outside_frames,
            _frame_index(frame),
        )
        for obj, track in zip(objects, assignments):
            if track is None:
                track = {
                    "trackingId": str(next_track_id),
                    "label": obj.get("label"),
                    "datasetClassId": obj.get("datasetClassId"),
                    "object": obj,
                    "pose": pose,
                    "frameIndex": _frame_index(frame),
                }
                next_track_id += 1
                tracks.append(track)
            else:
                track["object"] = obj
                track["pose"] = pose
                track["frameIndex"] = _frame_index(frame)
            obj["trackingId"] = track["trackingId"]
        associated.append(
            {
                "dataId": frame.get("dataId"),
                "frameIndex": frame.get("frameIndex"),
                "pose": frame.get("pose"),
                "objects": objects,
            }
        )
    return {"frames": associated}


def _match_frame(
    objects: list[dict[str, Any]],
    pose: dict[str, float],
    tracks: list[dict[str, Any]],
    iou_threshold: float,
    distance_threshold: float,
    max_outside_frames: int,
    frame_index: int,
) -> list[dict[str, Any] | None]:
    candidates: list[tuple[float, float, int, int]] = []
    for object_index, obj in enumerate(objects):
        for track_index, track in enumerate(tracks):
            if frame_index - int(track["frameIndex"]) > max_outside_frames:
                continue
            if not _same_identity(track, obj):
                continue
            projected = _project_object(track["object"], track["pose"], pose)
            iou = bev_iou(projected, obj)
            distance = math.hypot(
                float(projected.get("x") or 0.0) - float(obj.get("x") or 0.0),
                float(projected.get("y") or 0.0) - float(obj.get("y") or 0.0),
            )
            if iou > iou_threshold or distance <= distance_threshold:
                candidates.append((iou, distance, object_index, track_index))
    candidates.sort(key=lambda item: (-item[0], item[1], item[2], item[3]))
    used_objects: set[int] = set()
    used_tracks: set[int] = set()
    assignments: list[dict[str, Any] | None] = [None] * len(objects)
    for _iou, _distance, object_index, track_index in candidates:
        if object_index in used_objects or track_index in used_tracks:
            continue
        used_objects.add(object_index)
        used_tracks.add(track_index)
        assignments[object_index] = tracks[track_index]
    return assignments


def _same_identity(track: dict[str, Any], obj: dict[str, Any]) -> bool:
    track_class_id = track.get("datasetClassId")
    object_class_id = obj.get("datasetClassId")
    if track_class_id is not None and object_class_id is not None:
        return track_class_id == object_class_id
    return str(track.get("label") or "") == str(obj.get("label") or "")


def _project_object(
    source: dict[str, Any],
    source_pose: dict[str, float],
    target_pose: dict[str, float],
) -> dict[str, Any]:
    x, y, z, yaw = project_pose(
        local_x=float(source.get("x") or 0.0),
        local_y=float(source.get("y") or 0.0),
        local_z=float(source.get("z") or 0.0),
        local_yaw=float(source.get("rotZ") or 0.0),
        source_pose=source_pose,
        target_pose=target_pose,
    )
    projected = dict(source)
    projected["x"] = x
    projected["y"] = y
    projected["z"] = z
    projected["rotZ"] = yaw
    return projected


def project_pose(
    local_x: float,
    local_y: float,
    local_z: float,
    local_yaw: float,
    source_pose: dict[str, float],
    target_pose: dict[str, float],
) -> tuple[float, float, float, float]:
    world_x = source_pose["x"] + local_x * math.cos(source_pose["yaw"]) - local_y * math.sin(source_pose["yaw"])
    world_y = source_pose["y"] + local_x * math.sin(source_pose["yaw"]) + local_y * math.cos(source_pose["yaw"])
    dx = world_x - target_pose["x"]
    dy = world_y - target_pose["y"]
    target_x = dx * math.cos(target_pose["yaw"]) + dy * math.sin(target_pose["yaw"])
    target_y = -dx * math.sin(target_pose["yaw"]) + dy * math.cos(target_pose["yaw"])
    target_z = source_pose["z"] + local_z - target_pose["z"]
    yaw = local_yaw + source_pose["yaw"] - target_pose["yaw"]
    return target_x, target_y, target_z, yaw


def bev_iou(first: dict[str, Any], second: dict[str, Any]) -> float:
    first_box = _box(first)
    second_box = _box(second)
    if first_box is None or second_box is None:
        return 0.0
    intersection = _polygon(first_box)
    clip = _polygon(second_box)
    for index in range(len(clip)):
        edge_start = clip[index]
        edge_end = clip[(index + 1) % len(clip)]
        intersection = _clip_polygon(intersection, edge_start, edge_end)
        if not intersection:
            return 0.0
    intersection_area = _area(intersection)
    union_area = first_box[2] * first_box[3] + second_box[2] * second_box[3] - intersection_area
    return intersection_area / union_area if union_area > 0.0 else 0.0


def _box(obj: dict[str, Any]) -> tuple[float, float, float, float, float] | None:
    dx = float(obj.get("dx") or 0.0)
    dy = float(obj.get("dy") or 0.0)
    if dx <= 0.0 or dy <= 0.0:
        return None
    return (
        float(obj.get("x") or 0.0),
        float(obj.get("y") or 0.0),
        dx,
        dy,
        float(obj.get("rotZ") or 0.0),
    )


def _polygon(box: tuple[float, float, float, float, float]) -> list[tuple[float, float]]:
    x, y, dx, dy, yaw = box
    half_x = dx / 2.0
    half_y = dy / 2.0
    cosine = math.cos(yaw)
    sine = math.sin(yaw)
    corners = ((-half_x, -half_y), (half_x, -half_y), (half_x, half_y), (-half_x, half_y))
    return [
        (x + corner[0] * cosine - corner[1] * sine, y + corner[0] * sine + corner[1] * cosine)
        for corner in corners
    ]


def _clip_polygon(
    subject: list[tuple[float, float]],
    edge_start: tuple[float, float],
    edge_end: tuple[float, float],
) -> list[tuple[float, float]]:
    if not subject:
        return []
    output: list[tuple[float, float]] = []
    previous = subject[-1]
    for current in subject:
        current_inside = _inside(current, edge_start, edge_end)
        previous_inside = _inside(previous, edge_start, edge_end)
        if current_inside:
            if not previous_inside:
                output.append(_intersection(previous, current, edge_start, edge_end))
            output.append(current)
        elif previous_inside:
            output.append(_intersection(previous, current, edge_start, edge_end))
        previous = current
    return output


def _inside(
    point: tuple[float, float],
    edge_start: tuple[float, float],
    edge_end: tuple[float, float],
) -> bool:
    return _cross(edge_start, edge_end, point) >= -1.0e-10


def _intersection(
    line_start: tuple[float, float],
    line_end: tuple[float, float],
    edge_start: tuple[float, float],
    edge_end: tuple[float, float],
) -> tuple[float, float]:
    line_x = line_end[0] - line_start[0]
    line_y = line_end[1] - line_start[1]
    edge_x = edge_end[0] - edge_start[0]
    edge_y = edge_end[1] - edge_start[1]
    denominator = line_x * edge_y - line_y * edge_x
    if abs(denominator) < 1.0e-12:
        return line_end
    t = ((edge_start[0] - line_start[0]) * edge_y - (edge_start[1] - line_start[1]) * edge_x) / denominator
    return (line_start[0] + t * line_x, line_start[1] + t * line_y)


def _cross(
    start: tuple[float, float],
    end: tuple[float, float],
    point: tuple[float, float],
) -> float:
    return (end[0] - start[0]) * (point[1] - start[1]) - (end[1] - start[1]) * (point[0] - start[0])


def _area(polygon: list[tuple[float, float]]) -> float:
    total = 0.0
    for index, point in enumerate(polygon):
        nxt = polygon[(index + 1) % len(polygon)]
        total += point[0] * nxt[1] - nxt[0] * point[1]
    return abs(total) / 2.0


def _frame_index(frame: dict[str, Any]) -> int:
    value = frame.get("frameIndex")
    if value is None:
        raise ValueError("frameIndex is required")
    return int(value)


def _require_pose(frame: dict[str, Any]) -> dict[str, float]:
    pose = frame.get("pose") or {}
    if any(pose.get(key) is None for key in ("x", "y", "z", "yaw")):
        raise ValueError(f"Tracked frame pose is incomplete: dataId={frame.get('dataId')}")
    return {
        "x": float(pose["x"]),
        "y": float(pose["y"]),
        "z": float(pose["z"]),
        "yaw": float(pose["yaw"]),
    }
