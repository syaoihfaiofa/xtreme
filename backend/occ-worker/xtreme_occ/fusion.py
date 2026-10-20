"""Pure NumPy point-cloud fusion with dynamic-object alignment."""

from dataclasses import dataclass, field
from typing import Dict, Mapping, Sequence

import numpy as np


HORIZON_EGO_RANGE = np.array(
    [-1.17, -1.2, -0.3, 3.8, 1.2, 1.4],
    dtype=np.float64,
)


@dataclass(frozen=True)
class EgoPose:
    translation: np.ndarray
    yaw: float


@dataclass(frozen=True)
class Box3D:
    identity: str
    center: np.ndarray
    size: np.ndarray
    rotation: np.ndarray
    rotation_matrix: np.ndarray = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "rotation_matrix", _rotation_matrix(self.rotation))


@dataclass(frozen=True)
class PreparedFusionFrame:
    points: np.ndarray
    static_points: np.ndarray
    dynamic_local_points: Mapping[str, np.ndarray]
    pose_rotation: np.ndarray


def drop_ego_body_points(points: np.ndarray) -> np.ndarray:
    """Remove LiDAR points inside Horizon's fixed ego-body volume."""
    if points.ndim != 2 or points.shape[1] != 3:
        raise ValueError(f"points must have shape (N, 3), got {points.shape}")
    ego_range = HORIZON_EGO_RANGE
    inside_ego_body = np.all(
        (points >= ego_range[:3]) & (points <= ego_range[3:]),
        axis=1,
    )
    return points[~inside_ego_body]


def fuse_frame_points(
    point_clouds: Sequence[np.ndarray],
    poses: Sequence[EgoPose],
    dynamic_boxes: Sequence[Mapping[str, Box3D]],
    target_index: int,
    window: int,
    single_frame: bool,
) -> np.ndarray:
    target_points = point_clouds[target_index]
    if single_frame:
        return target_points

    start = max(0, target_index - window)
    stop = min(len(point_clouds), target_index + window + 1)
    target_boxes = dynamic_boxes[target_index]
    fused: list[np.ndarray] = []
    for source_index in range(start, stop):
        source_points = point_clouds[source_index]
        if source_index == target_index:
            fused.append(source_points)
            continue
        fused.append(
            _align_neighbor_points(
                points=source_points,
                source_pose=poses[source_index],
                target_pose=poses[target_index],
                source_boxes=dynamic_boxes[source_index],
                target_boxes=target_boxes,
            )
        )
    return np.concatenate(fused, axis=0)


def prepare_fusion_frames(
    point_clouds: Sequence[np.ndarray],
    poses: Sequence[EgoPose],
    dynamic_boxes: Sequence[Mapping[str, Box3D]],
) -> list[PreparedFusionFrame]:
    if len(point_clouds) != len(poses) or len(point_clouds) != len(dynamic_boxes):
        raise ValueError(
            "point_clouds, poses, and dynamic_boxes must have equal lengths"
        )
    return [
        _prepare_fusion_frame(points, pose, boxes)
        for points, pose, boxes in zip(point_clouds, poses, dynamic_boxes)
    ]


def fuse_prepared_frame_points(
    prepared_frames: Sequence[PreparedFusionFrame],
    poses: Sequence[EgoPose],
    dynamic_boxes: Sequence[Mapping[str, Box3D]],
    target_index: int,
    window: int,
    single_frame: bool,
) -> np.ndarray:
    target_points = prepared_frames[target_index].points
    if single_frame:
        return target_points

    start = max(0, target_index - window)
    stop = min(len(prepared_frames), target_index + window + 1)
    target_boxes = dynamic_boxes[target_index]
    target_pose = poses[target_index]
    target_rotation = _yaw_rotation(target_pose.yaw)
    fused: list[np.ndarray] = []
    for source_index in range(start, stop):
        prepared = prepared_frames[source_index]
        if source_index == target_index:
            fused.append(target_points)
            continue
        fused.append(
            _align_prepared_neighbor_points(
                prepared,
                poses[source_index],
                target_pose,
                target_rotation,
                target_boxes,
            )
        )
    return np.concatenate(fused, axis=0)


def _prepare_fusion_frame(
    points: np.ndarray,
    pose: EgoPose,
    source_boxes: Mapping[str, Box3D],
) -> PreparedFusionFrame:
    dynamic_mask = np.zeros(points.shape[0], dtype=bool)
    dynamic_local_points: Dict[str, np.ndarray] = {}
    for identity, source_box in source_boxes.items():
        box_mask = _points_inside_box(points, source_box) & ~dynamic_mask
        dynamic_mask |= box_mask
        if np.any(box_mask):
            dynamic_local_points[identity] = _points_to_box_local(
                points[box_mask], source_box
            )
    return PreparedFusionFrame(
        points=points,
        static_points=points[~dynamic_mask],
        dynamic_local_points=dynamic_local_points,
        pose_rotation=_yaw_rotation(pose.yaw),
    )


def _align_prepared_neighbor_points(
    prepared: PreparedFusionFrame,
    source_pose: EgoPose,
    target_pose: EgoPose,
    target_rotation: np.ndarray,
    target_boxes: Mapping[str, Box3D],
) -> np.ndarray:
    world_points = (
        prepared.static_points @ prepared.pose_rotation.T
        + source_pose.translation
    )
    static_points = (world_points - target_pose.translation) @ target_rotation
    aligned_dynamic: list[np.ndarray] = []
    for identity, local_points in prepared.dynamic_local_points.items():
        target_box = target_boxes.get(identity)
        if target_box is None:
            continue
        aligned_points = _box_local_to_points(local_points, target_box)
        aligned_dynamic.append(
            aligned_points[_points_inside_box(aligned_points, target_box)]
        )
    return np.concatenate([static_points, *aligned_dynamic], axis=0)


def _align_neighbor_points(
    points: np.ndarray,
    source_pose: EgoPose,
    target_pose: EgoPose,
    source_boxes: Mapping[str, Box3D],
    target_boxes: Mapping[str, Box3D],
) -> np.ndarray:
    dynamic_mask = np.zeros(points.shape[0], dtype=bool)
    aligned_dynamic: list[np.ndarray] = []
    for identity, source_box in source_boxes.items():
        box_mask = _points_inside_box(points, source_box) & ~dynamic_mask
        dynamic_mask |= box_mask
        target_box = target_boxes.get(identity)
        if target_box is None or not np.any(box_mask):
            continue
        local_points = _points_to_box_local(points[box_mask], source_box)
        aligned_points = _box_local_to_points(local_points, target_box)
        aligned_dynamic.append(
            aligned_points[_points_inside_box(aligned_points, target_box)]
        )

    static_points = _transform_static_points(
        points[~dynamic_mask],
        source_pose=source_pose,
        target_pose=target_pose,
    )
    return np.concatenate([static_points, *aligned_dynamic], axis=0)


def _transform_static_points(
    points: np.ndarray,
    source_pose: EgoPose,
    target_pose: EgoPose,
) -> np.ndarray:
    source_rotation = _yaw_rotation(source_pose.yaw)
    target_rotation = _yaw_rotation(target_pose.yaw)
    world_points = points @ source_rotation.T + source_pose.translation
    return (world_points - target_pose.translation) @ target_rotation


def _points_inside_box(points: np.ndarray, box: Box3D) -> np.ndarray:
    local_points = _points_to_box_local(points, box)
    return np.all(np.abs(local_points) <= box.size / 2.0, axis=1)


def _points_to_box_local(points: np.ndarray, box: Box3D) -> np.ndarray:
    return (points - box.center) @ box.rotation_matrix


def _box_local_to_points(local_points: np.ndarray, box: Box3D) -> np.ndarray:
    return local_points @ box.rotation_matrix.T + box.center


def _yaw_rotation(yaw: float) -> np.ndarray:
    cosine = np.cos(yaw)
    sine = np.sin(yaw)
    return np.array(
        [[cosine, -sine, 0.0], [sine, cosine, 0.0], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )


def _rotation_matrix(rotation: np.ndarray) -> np.ndarray:
    rx, ry, rz = rotation
    cosine_x, sine_x = np.cos(rx), np.sin(rx)
    cosine_y, sine_y = np.cos(ry), np.sin(ry)
    cosine_z, sine_z = np.cos(rz), np.sin(rz)
    return np.array(
        [
            [
                cosine_z * cosine_y,
                cosine_z * sine_y * sine_x - sine_z * cosine_x,
                cosine_z * sine_y * cosine_x + sine_z * sine_x,
            ],
            [
                sine_z * cosine_y,
                sine_z * sine_y * sine_x + cosine_z * cosine_x,
                sine_z * sine_y * cosine_x - cosine_z * sine_x,
            ],
            [-sine_y, cosine_y * sine_x, cosine_y * cosine_x],
        ],
        dtype=np.float64,
    )
