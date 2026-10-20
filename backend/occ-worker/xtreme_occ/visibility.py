"""NumPy-only voxel occupancy and visibility helpers."""

from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter_ns
from typing import List, Optional, Sequence, Tuple

import numpy as np

try:
    from numba import njit

    _HAS_NUMBA = True
except ImportError:
    _HAS_NUMBA = False


@dataclass(frozen=True)
class RaycastVisibilityProfile:
    """Durations and ray counts collected from one visibility raycast."""

    input_ray_count: int
    unique_ray_count: int
    traced_ray_count: int
    endpoint_deduplicate_ns: int
    deduplicate_ns: int
    sample_ns: int
    setup_ns: int
    kernel_ns: int


@dataclass(frozen=True)
class VoxelizedPoints:
    """Prepared point voxel data for occupancy and raycast consumers."""

    valid_point_mask: np.ndarray
    voxel_indices: np.ndarray
    linear_indices: np.ndarray
    raycast_points: np.ndarray
    endpoint_deduplicate_ns: int


if _HAS_NUMBA:

    @njit(cache=False)
    def _raycast_dda_flat_kernel(
        occupied_flat: np.ndarray,
        points: np.ndarray,
        origin_x: float,
        origin_y: float,
        origin_z: float,
        sensor_x: float,
        sensor_y: float,
        sensor_z: float,
        voxel_size: float,
        size_x: int,
        size_y: int,
        size_z: int,
        observed_flat: np.ndarray,
        free_flat: np.ndarray,
    ) -> None:
        grid_max_x = origin_x + size_x * voxel_size
        grid_max_y = origin_y + size_y * voxel_size
        grid_max_z = origin_z + size_z * voxel_size
        epsilon = 1.0e-9
        infinity = 1.0e30
        yz_stride = size_y * size_z

        for point_index in range(points.shape[0]):
            target_x = points[point_index, 0]
            target_y = points[point_index, 1]
            target_z = points[point_index, 2]
            direction_x = target_x - sensor_x
            direction_y = target_y - sensor_y
            direction_z = target_z - sensor_z
            if (
                abs(direction_x) < epsilon
                and abs(direction_y) < epsilon
                and abs(direction_z) < epsilon
            ):
                continue

            enter = 0.0
            exit = 1.0
            valid = True
            for axis in range(3):
                if axis == 0:
                    sensor = sensor_x
                    direction = direction_x
                    lower = origin_x
                    upper = grid_max_x
                elif axis == 1:
                    sensor = sensor_y
                    direction = direction_y
                    lower = origin_y
                    upper = grid_max_y
                else:
                    sensor = sensor_z
                    direction = direction_z
                    lower = origin_z
                    upper = grid_max_z

                if abs(direction) < epsilon:
                    if sensor < lower or sensor >= upper:
                        valid = False
                        break
                    continue

                first = (lower - sensor) / direction
                second = (upper - sensor) / direction
                if first > second:
                    first, second = second, first
                if first > enter:
                    enter = first
                if second < exit:
                    exit = second

            if not valid or enter >= exit:
                continue

            start = max(enter, 0.0) + epsilon
            if start >= exit or start >= 1.0:
                continue
            position_x = sensor_x + start * direction_x
            position_y = sensor_y + start * direction_y
            position_z = sensor_z + start * direction_z
            index_x = int(np.floor((position_x - origin_x) / voxel_size))
            index_y = int(np.floor((position_y - origin_y) / voxel_size))
            index_z = int(np.floor((position_z - origin_z) / voxel_size))
            if index_x < 0:
                index_x = 0
            elif index_x >= size_x:
                index_x = size_x - 1
            if index_y < 0:
                index_y = 0
            elif index_y >= size_y:
                index_y = size_y - 1
            if index_z < 0:
                index_z = 0
            elif index_z >= size_z:
                index_z = size_z - 1

            step_x = 1 if direction_x > 0.0 else (-1 if direction_x < 0.0 else 0)
            step_y = 1 if direction_y > 0.0 else (-1 if direction_y < 0.0 else 0)
            step_z = 1 if direction_z > 0.0 else (-1 if direction_z < 0.0 else 0)

            if step_x != 0:
                boundary_x = origin_x + (index_x + (1 if step_x > 0 else 0)) * voxel_size
                next_x = (boundary_x - sensor_x) / direction_x
                delta_x = voxel_size / abs(direction_x)
            else:
                next_x = infinity
                delta_x = infinity
            if step_y != 0:
                boundary_y = origin_y + (index_y + (1 if step_y > 0 else 0)) * voxel_size
                next_y = (boundary_y - sensor_y) / direction_y
                delta_y = voxel_size / abs(direction_y)
            else:
                next_y = infinity
                delta_y = infinity
            if step_z != 0:
                boundary_z = origin_z + (index_z + (1 if step_z > 0 else 0)) * voxel_size
                next_z = (boundary_z - sensor_z) / direction_z
                delta_z = voxel_size / abs(direction_z)
            else:
                next_z = infinity
                delta_z = infinity

            for _ in range(size_x + size_y + size_z + 3):
                if (
                    index_x < 0
                    or index_x >= size_x
                    or index_y < 0
                    or index_y >= size_y
                    or index_z < 0
                    or index_z >= size_z
                ):
                    break
                flat_index = index_x * yz_stride + index_y * size_z + index_z
                observed_flat[flat_index] = True
                if occupied_flat[flat_index]:
                    break
                free_flat[flat_index] = True

                crossing = min(next_x, next_y, next_z)
                if crossing >= exit - epsilon or crossing >= 1.0 - epsilon:
                    break
                if abs(next_x - crossing) <= epsilon:
                    index_x += step_x
                    next_x += delta_x
                if abs(next_y - crossing) <= epsilon:
                    index_y += step_y
                    next_y += delta_y
                if abs(next_z - crossing) <= epsilon:
                    index_z += step_z
                    next_z += delta_z


def build_voxel_grid(
    points_xyz: np.ndarray,
    grid_origin: np.ndarray,
    voxel_size: float,
    grid_shape: Sequence[int],
    min_points_per_voxel: int,
) -> np.ndarray:
    """Build an xyz-indexed boolean occupancy grid from finite points."""
    prepared = prepare_voxelized_points(
        points_xyz=points_xyz,
        grid_origin=grid_origin,
        voxel_size=voxel_size,
        grid_shape=grid_shape,
    )
    return build_voxel_grid_from_prepared(
        prepared=prepared,
        grid_shape=grid_shape,
        min_points_per_voxel=min_points_per_voxel,
    )


def prepare_voxelized_points(
    points_xyz: np.ndarray,
    grid_origin: np.ndarray,
    voxel_size: float,
    grid_shape: Sequence[int],
) -> VoxelizedPoints:
    """Compute reusable voxel coordinates for finite in-bounds points."""
    points = np.asarray(points_xyz, dtype=np.float64)
    origin = np.asarray(grid_origin, dtype=np.float64)
    shape = tuple(int(value) for value in grid_shape)
    if points.ndim != 2 or points.shape[1] != 3:
        raise ValueError(f"points_xyz must have shape (N, 3), got {points.shape}")
    if origin.shape != (3,) or not np.all(np.isfinite(origin)):
        raise ValueError(f"grid_origin must contain 3 finite values, got {grid_origin}")
    if len(shape) != 3 or any(value <= 0 for value in shape):
        raise ValueError(f"grid_shape must contain 3 positive values, got {grid_shape}")
    if not np.isfinite(voxel_size) or voxel_size <= 0:
        raise ValueError(f"voxel_size must be positive and finite, got {voxel_size}")

    finite = np.all(np.isfinite(points), axis=1)
    finite_points = points[finite]
    all_voxel_indices = np.floor(
        (finite_points - origin) / voxel_size
    ).astype(np.int64)
    endpoint_deduplicate_started_ns = perf_counter_ns()
    raycast_points = _first_points_by_voxel(finite_points, all_voxel_indices)
    endpoint_deduplicate_ns = perf_counter_ns() - endpoint_deduplicate_started_ns
    indices = all_voxel_indices
    shape_array = np.asarray(shape, dtype=np.int64)
    in_bounds = np.all((indices >= 0) & (indices < shape_array), axis=1)
    indices = indices[in_bounds]
    valid_point_mask = finite.copy()
    valid_point_mask[finite] = in_bounds
    linear_indices = np.ravel_multi_index(indices.T, shape)
    return VoxelizedPoints(
        valid_point_mask=valid_point_mask,
        voxel_indices=indices,
        linear_indices=linear_indices,
        raycast_points=raycast_points,
        endpoint_deduplicate_ns=endpoint_deduplicate_ns,
    )


def build_voxel_grid_from_prepared(
    prepared: VoxelizedPoints,
    grid_shape: Sequence[int],
    min_points_per_voxel: int,
) -> np.ndarray:
    """Build an occupancy grid from reusable voxelized point indices."""
    shape = tuple(int(value) for value in grid_shape)
    if len(shape) != 3 or any(value <= 0 for value in shape):
        raise ValueError(f"grid_shape must contain 3 positive values, got {grid_shape}")
    if min_points_per_voxel < 1:
        raise ValueError(
            "min_points_per_voxel must be at least 1, "
            f"got {min_points_per_voxel}"
        )
    counts = np.zeros(shape, dtype=np.int64)
    if prepared.linear_indices.size:
        np.add.at(counts.reshape(-1), prepared.linear_indices, 1)
    return counts >= min_points_per_voxel


def ray_occluded(
    occupied: np.ndarray,
    grid_origin: np.ndarray,
    voxel_size: float,
    camera_origin: np.ndarray,
    target_points: np.ndarray,
) -> np.ndarray:
    """Return whether each open camera-to-target segment crosses occupancy."""
    grid = np.asarray(occupied, dtype=bool)
    origin = np.asarray(grid_origin, dtype=np.float64)
    camera = np.asarray(camera_origin, dtype=np.float64)
    targets = np.asarray(target_points, dtype=np.float64)
    if grid.ndim != 3:
        raise ValueError(f"occupied must be 3-dimensional, got {grid.shape}")
    if origin.shape != (3,) or camera.shape != (3,):
        raise ValueError("grid_origin and camera_origin must each have shape (3,)")
    if not np.all(np.isfinite(origin)) or not np.all(np.isfinite(camera)):
        raise ValueError("grid_origin and camera_origin must contain finite values")
    if targets.ndim != 2 or targets.shape[1] != 3:
        raise ValueError(f"target_points must have shape (N, 3), got {targets.shape}")
    if not np.all(np.isfinite(targets)):
        raise ValueError("target_points must contain only finite values")
    if not np.isfinite(voxel_size) or voxel_size <= 0:
        raise ValueError(f"voxel_size must be positive and finite, got {voxel_size}")

    return np.asarray(
        [
            _ray_hits_grid(grid, origin, voxel_size, camera, target)
            for target in targets
        ],
        dtype=bool,
    )


def raycast_visibility(
    occupied: np.ndarray,
    grid_origin: np.ndarray,
    voxel_size: float,
    lidar_origin: np.ndarray,
    target_points: np.ndarray,
    max_rays: int = 60000,
    seed: int = 0,
    prepared_points: Optional[VoxelizedPoints] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """Mark free and hit voxels using Horizon-compatible DDA LiDAR raycasting."""
    observed, free, _ = _raycast_visibility(
        occupied=occupied,
        grid_origin=grid_origin,
        voxel_size=voxel_size,
        lidar_origin=lidar_origin,
        target_points=target_points,
        max_rays=max_rays,
        seed=seed,
        prepared_points=prepared_points,
        collect_profile=False,
    )
    return observed, free


def raycast_visibility_profiled(
    occupied: np.ndarray,
    grid_origin: np.ndarray,
    voxel_size: float,
    lidar_origin: np.ndarray,
    target_points: np.ndarray,
    max_rays: int = 60000,
    seed: int = 0,
    prepared_points: Optional[VoxelizedPoints] = None,
) -> Tuple[np.ndarray, np.ndarray, RaycastVisibilityProfile]:
    """Run DDA raycasting and return masks with per-stage timing data."""
    observed, free, profile = _raycast_visibility(
        occupied=occupied,
        grid_origin=grid_origin,
        voxel_size=voxel_size,
        lidar_origin=lidar_origin,
        target_points=target_points,
        max_rays=max_rays,
        seed=seed,
        prepared_points=prepared_points,
        collect_profile=True,
    )
    if profile is None:
        raise RuntimeError("profile collection was unexpectedly disabled")
    return observed, free, profile


def _raycast_visibility(
    occupied: np.ndarray,
    grid_origin: np.ndarray,
    voxel_size: float,
    lidar_origin: np.ndarray,
    target_points: np.ndarray,
    max_rays: int,
    seed: int,
    prepared_points: Optional[VoxelizedPoints],
    collect_profile: bool,
) -> Tuple[np.ndarray, np.ndarray, Optional[RaycastVisibilityProfile]]:
    grid = np.asarray(occupied, dtype=bool)
    origin = np.asarray(grid_origin, dtype=np.float64)
    sensor = np.asarray(lidar_origin, dtype=np.float64)
    targets = np.asarray(target_points, dtype=np.float64)
    if grid.ndim != 3:
        raise ValueError(f"occupied must be 3-dimensional, got {grid.shape}")
    if origin.shape != (3,) or sensor.shape != (3,):
        raise ValueError("grid_origin and lidar_origin must each have shape (3,)")
    if targets.ndim != 2 or targets.shape[1] != 3:
        raise ValueError(f"target_points must have shape (N, 3), got {targets.shape}")
    if not np.all(np.isfinite(sensor)) or not np.all(np.isfinite(targets)):
        raise ValueError("lidar_origin and target_points must contain finite values")
    if max_rays < 1:
        raise ValueError(f"max_rays must be positive, got {max_rays}")
    if not _HAS_NUMBA:
        raise RuntimeError("DDA raycast requires numba")

    deduplicate_started_ns = perf_counter_ns() if collect_profile else 0
    points = (
        prepared_points.raycast_points
        if prepared_points is not None
        else unique_points_by_voxel(
            targets,
            [
                *origin.tolist(),
                *(origin + np.asarray(grid.shape) * voxel_size).tolist(),
            ],
            voxel_size,
        )
    )
    unique_ray_count = points.shape[0]
    deduplicate_finished_ns = perf_counter_ns() if collect_profile else 0
    sample_started_ns = perf_counter_ns() if collect_profile else 0
    if points.shape[0] > max_rays:
        generator = np.random.default_rng(seed)
        points = points[generator.choice(points.shape[0], size=max_rays, replace=False)]
    sample_finished_ns = perf_counter_ns() if collect_profile else 0

    setup_started_ns = perf_counter_ns() if collect_profile else 0
    observed = np.zeros(grid.shape, dtype=bool)
    free = np.zeros(grid.shape, dtype=bool)
    occupied_flat = np.ascontiguousarray(grid).reshape(-1)
    observed_flat = observed.reshape(-1)
    free_flat = free.reshape(-1)
    setup_finished_ns = perf_counter_ns() if collect_profile else 0
    kernel_started_ns = perf_counter_ns() if collect_profile else 0
    _raycast_dda_flat_kernel(
        occupied_flat,
        points,
        float(origin[0]),
        float(origin[1]),
        float(origin[2]),
        float(sensor[0]),
        float(sensor[1]),
        float(sensor[2]),
        float(voxel_size),
        grid.shape[0],
        grid.shape[1],
        grid.shape[2],
        observed_flat,
        free_flat,
    )
    kernel_finished_ns = perf_counter_ns() if collect_profile else 0
    if not collect_profile:
        return observed, free, None
    return (
        observed,
        free,
        RaycastVisibilityProfile(
            input_ray_count=targets.shape[0],
            unique_ray_count=unique_ray_count,
            traced_ray_count=points.shape[0],
            endpoint_deduplicate_ns=(
                0
                if prepared_points is None
                else prepared_points.endpoint_deduplicate_ns
            ),
            deduplicate_ns=(
                0
                if prepared_points is not None
                else deduplicate_finished_ns - deduplicate_started_ns
            ),
            sample_ns=sample_finished_ns - sample_started_ns,
            setup_ns=setup_finished_ns - setup_started_ns,
            kernel_ns=kernel_finished_ns - kernel_started_ns,
        ),
    )


def unique_points_by_voxel(
    points: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
) -> np.ndarray:
    """Keep one point per endpoint voxel while retaining out-of-bounds bins."""
    array = np.asarray(points, dtype=np.float64)
    if array.ndim != 2 or array.shape[1] != 3:
        raise ValueError(f"points must have shape (N, 3), got {array.shape}")
    if len(pc_range) != 6:
        raise ValueError(f"pc_range must contain 6 values, got {pc_range}")
    if not np.isfinite(voxel_size) or voxel_size <= 0:
        raise ValueError(f"voxel_size must be positive and finite, got {voxel_size}")
    if array.shape[0] == 0:
        return array
    origin = np.asarray(pc_range[:3], dtype=np.float64)
    indices = np.floor((array - origin) / voxel_size).astype(np.int64)
    return _first_points_by_voxel(array, indices)


def _first_points_by_voxel(
    points: np.ndarray,
    voxel_indices: np.ndarray,
) -> np.ndarray:
    """Select each voxel's first input point without packing int64 coordinates."""
    if points.shape[0] == 0:
        return points
    ordered_indices = np.lexsort(
        (
            voxel_indices[:, 2],
            voxel_indices[:, 1],
            voxel_indices[:, 0],
        )
    )
    ordered_voxels = voxel_indices[ordered_indices]
    first_in_voxel = np.empty(ordered_indices.size, dtype=bool)
    first_in_voxel[0] = True
    first_in_voxel[1:] = np.any(
        ordered_voxels[1:] != ordered_voxels[:-1],
        axis=1,
    )
    first_input_indices = np.sort(ordered_indices[first_in_voxel])
    return points[first_input_indices]


def _ray_voxel_indices(
    grid_shape: Sequence[int],
    grid_origin: np.ndarray,
    voxel_size: float,
    ray_origin: np.ndarray,
    target: np.ndarray,
) -> List[Tuple[int, int, int]]:
    direction = target - ray_origin
    distance = float(np.linalg.norm(direction))
    if distance == 0.0:
        return []
    sample_count = max(1, int(np.ceil(distance / (voxel_size / 4.0))))
    samples = ray_origin + np.linspace(0.0, 1.0, sample_count + 1)[:, None] * direction
    indices = np.floor((samples - grid_origin) / voxel_size).astype(np.int64)
    shape = np.asarray(grid_shape, dtype=np.int64)
    in_bounds = np.all((indices >= 0) & (indices < shape), axis=1)
    result: List[Tuple[int, int, int]] = []
    for index in indices[in_bounds]:
        item = tuple(int(value) for value in index)
        if not result or item != result[-1]:
            result.append(item)
    return result


def _ray_hits_grid(
    grid: np.ndarray,
    grid_origin: np.ndarray,
    voxel_size: float,
    camera_origin: np.ndarray,
    target: np.ndarray,
) -> bool:
    direction = target - camera_origin
    if not np.any(direction):
        return False

    bounds_max = grid_origin + np.asarray(grid.shape) * voxel_size
    t_enter = 0.0
    t_exit = 1.0
    for axis in range(3):
        if direction[axis] == 0.0:
            if not grid_origin[axis] <= camera_origin[axis] < bounds_max[axis]:
                return False
            continue
        first = (grid_origin[axis] - camera_origin[axis]) / direction[axis]
        second = (bounds_max[axis] - camera_origin[axis]) / direction[axis]
        axis_enter, axis_exit = sorted((first, second))
        t_enter = max(t_enter, axis_enter)
        t_exit = min(t_exit, axis_exit)
    if t_enter >= t_exit:
        return False

    epsilon = 1e-10
    start_t = min(t_exit, max(t_enter, 0.0) + epsilon)
    start = camera_origin + start_t * direction
    index = np.floor((start - grid_origin) / voxel_size).astype(np.int64)
    index = np.minimum(np.maximum(index, 0), np.asarray(grid.shape) - 1)
    step = np.sign(direction).astype(np.int64)

    next_boundary = grid_origin + (
        index + (step > 0).astype(np.int64)
    ) * voxel_size
    t_max = np.full(3, np.inf, dtype=np.float64)
    moving = direction != 0.0
    t_max[moving] = (
        next_boundary[moving] - camera_origin[moving]
    ) / direction[moving]
    t_delta = np.full(3, np.inf, dtype=np.float64)
    t_delta[moving] = voxel_size / np.abs(direction[moving])

    camera_index = np.floor(
        (camera_origin - grid_origin) / voxel_size
    ).astype(np.int64)
    target_index = np.floor((target - grid_origin) / voxel_size).astype(np.int64)
    shape = np.asarray(grid.shape, dtype=np.int64)
    max_steps = int(shape.sum()) + 3

    for _ in range(max_steps):
        if np.any(index < 0) or np.any(index >= shape):
            return False
        at_camera = np.array_equal(index, camera_index)
        at_target = np.array_equal(index, target_index)
        if not at_camera and not at_target and grid[tuple(index)]:
            return True

        crossing_t = float(np.min(t_max))
        if crossing_t >= t_exit - epsilon or crossing_t >= 1.0 - epsilon:
            return False
        crossed_axes = np.isclose(t_max, crossing_t, rtol=0.0, atol=epsilon)
        index[crossed_axes] += step[crossed_axes]
        t_max[crossed_axes] += t_delta[crossed_axes]
    return False


def split_polyline(
    points: np.ndarray, segment_length: float
) -> List[Tuple[np.ndarray, np.ndarray]]:
    """Split a polyline at near-uniform BEV arc-length intervals."""
    vertices = np.asarray(points, dtype=np.float64)
    if vertices.ndim != 2 or vertices.shape[1] < 2:
        raise ValueError(f"points must have shape (N, D), D >= 2, got {vertices.shape}")
    if not np.all(np.isfinite(vertices)):
        raise ValueError("points must contain only finite values")
    if not np.isfinite(segment_length) or segment_length <= 0:
        raise ValueError(
            f"segment_length must be positive and finite, got {segment_length}"
        )
    if vertices.shape[0] < 2:
        return []

    edge_lengths = np.linalg.norm(np.diff(vertices[:, :2], axis=0), axis=1)
    useful_edges = edge_lengths > 0
    if not np.any(useful_edges):
        return []
    retained = np.concatenate(([True], useful_edges))
    vertices = vertices[retained]
    edge_lengths = np.linalg.norm(np.diff(vertices[:, :2], axis=0), axis=1)
    cumulative = np.concatenate(([0.0], np.cumsum(edge_lengths)))
    total_length = float(cumulative[-1])

    cuts = np.arange(0.0, total_length, segment_length, dtype=np.float64)
    cuts = np.append(cuts, total_length)
    if (
        cuts.size > 2
        and total_length - cuts[-2] < 0.5 * segment_length
    ):
        cuts = np.delete(cuts, -2)
    sampled = np.stack(
        [
            np.interp(cuts, cumulative, vertices[:, dimension])
            for dimension in range(vertices.shape[1])
        ],
        axis=1,
    )
    return list(zip(sampled[:-1], sampled[1:]))


def bev_visibility_or(per_camera: np.ndarray) -> np.ndarray:
    """Combine per-camera segment visibility into one BEV visibility row."""
    visibility = np.asarray(per_camera, dtype=bool)
    if visibility.ndim != 2:
        raise ValueError(
            f"per_camera must have shape (camera, segment), got {visibility.shape}"
        )
    return np.any(visibility, axis=0)
