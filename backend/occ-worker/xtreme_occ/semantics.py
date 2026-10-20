"""NumPy-only semantic occupancy generation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence, Tuple

import numpy as np

from xtreme_occ.visibility import (
    VoxelizedPoints,
    build_voxel_grid_from_prepared,
    prepare_voxelized_points,
)


@dataclass(frozen=True)
class OccLabels:
    """Horizon-compatible occupancy labels and visibility masks."""

    semantics: np.ndarray
    mask_lidar: np.ndarray
    mask_camera: np.ndarray
    occupied: np.ndarray
    origin: np.ndarray
    voxel_size: float
    class_map: dict[str, int]
    prepared_points: VoxelizedPoints


def generate_semantics(
    points_xyz: np.ndarray,
    semantic_ids: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    free_id: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """Voxelize labeled points and assign one majority semantic per voxel."""
    points = np.asarray(points_xyz, dtype=np.float64)
    labels = np.asarray(semantic_ids)
    origin, grid_shape = _grid_geometry(pc_range, voxel_size)
    _validate_labeled_points(points, labels)

    output_dtype = np.result_type(labels.dtype, np.min_scalar_type(free_id))
    prepared = prepare_voxelized_points(
        points_xyz=points,
        grid_origin=origin,
        voxel_size=voxel_size,
        grid_shape=grid_shape,
    )
    occupied = build_voxel_grid_from_prepared(
        prepared=prepared,
        grid_shape=grid_shape,
        min_points_per_voxel=1,
    )
    return _semantics_for_occupied_voxels(
        labels,
        prepared,
        free_id,
        occupied,
        output_dtype,
    )


def _semantics_for_occupied_voxels(
    labels: np.ndarray,
    prepared: VoxelizedPoints,
    free_id: int,
    occupied: np.ndarray,
    output_dtype: np.dtype,
) -> Tuple[np.ndarray, np.ndarray]:
    semantics = np.full(occupied.shape, free_id, dtype=output_dtype)
    if not np.any(occupied):
        return semantics, occupied

    valid_labels = labels[prepared.valid_point_mask]
    vote_mask = occupied.reshape(-1)[prepared.linear_indices]
    vote_indices = prepared.linear_indices[vote_mask]
    vote_labels = valid_labels[vote_mask]
    if not vote_indices.size:
        return semantics, occupied

    unique_labels, label_codes = np.unique(vote_labels, return_inverse=True)
    label_count = unique_labels.size
    maximum_index = int(vote_indices.max())
    maximum_key = maximum_index * label_count + label_count - 1
    if maximum_key <= np.iinfo(np.int64).max:
        pair_keys = vote_indices * label_count + label_codes
        unique_keys, pair_counts = np.unique(pair_keys, return_counts=True)
        pair_indices = unique_keys // label_count
        pair_labels = unique_labels[unique_keys % label_count]
    else:
        pair_dtype = np.dtype(
            [("voxel", vote_indices.dtype), ("label", vote_labels.dtype)]
        )
        pairs = np.empty(vote_indices.size, dtype=pair_dtype)
        pairs["voxel"] = vote_indices
        pairs["label"] = vote_labels
        unique_pairs, pair_counts = np.unique(pairs, return_counts=True)
        pair_indices = unique_pairs["voxel"]
        pair_labels = unique_pairs["label"]
    pair_order = np.lexsort(
        (
            pair_labels,
            -pair_counts,
            pair_indices,
        )
    )
    ranked_indices = pair_indices[pair_order]
    first_per_voxel = np.concatenate(
        ([True], ranked_indices[1:] != ranked_indices[:-1])
    )
    winners = pair_order[first_per_voxel]
    semantics.flat[pair_indices[winners]] = pair_labels[winners]
    return semantics, occupied


def generate_occ_labels(
    points_xyz: np.ndarray,
    semantic_ids: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    unknown_id: int,
    min_points_per_voxel: int,
    min_neighbors: int,
    class_map: dict[str, int],
) -> OccLabels:
    """Create unobserved semantic labels before visibility masks are applied."""
    points = np.asarray(points_xyz, dtype=np.float64)
    labels = np.asarray(semantic_ids)
    origin, grid_shape = _grid_geometry(pc_range, voxel_size)
    _validate_labeled_points(points, labels)
    if min_points_per_voxel < 1:
        raise ValueError(
            "min_points_per_voxel must be at least 1, "
            f"got {min_points_per_voxel}"
        )
    if min_neighbors < 0:
        raise ValueError(f"min_neighbors must be non-negative, got {min_neighbors}")

    prepared = prepare_voxelized_points(
        points_xyz=points,
        grid_origin=origin,
        voxel_size=voxel_size,
        grid_shape=grid_shape,
    )
    occupied = build_voxel_grid_from_prepared(
        prepared=prepared,
        grid_shape=grid_shape,
        min_points_per_voxel=min_points_per_voxel,
    )
    if min_neighbors:
        occupied = _cleanup_occupied(occupied, min_neighbors)
    semantics, _ = _semantics_for_occupied_voxels(
        labels,
        prepared,
        unknown_id,
        occupied,
        np.result_type(labels.dtype, np.min_scalar_type(unknown_id)),
    )
    semantics[~occupied] = unknown_id
    empty_mask = np.zeros(grid_shape, dtype=bool)
    return OccLabels(
        semantics=semantics,
        mask_lidar=empty_mask,
        mask_camera=empty_mask.copy(),
        occupied=occupied,
        origin=origin,
        voxel_size=float(voxel_size),
        class_map=dict(class_map),
        prepared_points=prepared,
    )


def _cleanup_occupied(occupied: np.ndarray, min_neighbors: int) -> np.ndarray:
    neighbors = np.zeros_like(occupied, dtype=np.int8)
    neighbors[1:] += occupied[:-1]
    neighbors[:-1] += occupied[1:]
    neighbors[:, 1:] += occupied[:, :-1]
    neighbors[:, :-1] += occupied[:, 1:]
    neighbors[:, :, 1:] += occupied[:, :, :-1]
    neighbors[:, :, :-1] += occupied[:, :, 1:]
    return occupied & (neighbors >= min_neighbors)


def overlay_box_semantics(
    semantics: np.ndarray,
    occupied: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    centers: np.ndarray,
    sizes: np.ndarray,
    yaws: np.ndarray,
    semantic_ids: np.ndarray,
    margin: float = 0.0,
) -> np.ndarray:
    """Override occupied voxel centers inside Z-axis-oriented 3D boxes."""
    semantic_grid = np.asarray(semantics)
    occupancy_grid = np.asarray(occupied, dtype=bool)
    origin, grid_shape = _grid_geometry(pc_range, voxel_size)
    if semantic_grid.ndim != 3:
        raise ValueError(
            f"semantics must be 3-dimensional, got {semantic_grid.shape}"
        )
    if semantic_grid.shape != grid_shape:
        raise ValueError(
            f"semantics shape must be {grid_shape}, got {semantic_grid.shape}"
        )
    if occupancy_grid.shape != semantic_grid.shape:
        raise ValueError(
            "occupied shape must match semantics shape, "
            f"got {occupancy_grid.shape} and {semantic_grid.shape}"
        )

    box_centers = np.asarray(centers, dtype=np.float64)
    box_sizes = np.asarray(sizes, dtype=np.float64)
    box_yaws = np.asarray(yaws, dtype=np.float64)
    box_labels = np.asarray(semantic_ids)
    _validate_boxes(box_centers, box_sizes, box_yaws, box_labels)

    result = semantic_grid.copy()
    for center, size, yaw, semantic_id in zip(
        box_centers, box_sizes, box_yaws, box_labels
    ):
        x_slice, y_slice, z_slice = _box_voxel_slices(
            center, size, yaw, margin, origin, grid_shape, voxel_size
        )
        if x_slice.stop == x_slice.start or y_slice.stop == y_slice.start:
            continue
        x_centers = (
            origin[0]
            + (np.arange(x_slice.start, x_slice.stop, dtype=np.float64) + 0.5)
            * voxel_size
        )[:, np.newaxis]
        y_centers = (
            origin[1]
            + (np.arange(y_slice.start, y_slice.stop, dtype=np.float64) + 0.5)
            * voxel_size
        )[np.newaxis, :]
        z_centers = (
            origin[2]
            + (np.arange(z_slice.start, z_slice.stop, dtype=np.float64) + 0.5)
            * voxel_size
        )
        delta_x = x_centers - center[0]
        delta_y = y_centers - center[1]
        cosine = np.cos(yaw)
        sine = np.sin(yaw)
        local_x = cosine * delta_x + sine * delta_y
        local_y = -sine * delta_x + cosine * delta_y
        inside_xy = (np.abs(local_x) <= size[0] / 2.0 + margin) & (
            np.abs(local_y) <= size[1] / 2.0 + margin
        )
        inside_z = np.abs(z_centers - center[2]) <= size[2] / 2.0 + margin
        inside = inside_xy[:, :, np.newaxis] & inside_z[np.newaxis, np.newaxis, :]
        result_slice = result[x_slice, y_slice, z_slice]
        result_slice[inside & occupancy_grid[x_slice, y_slice, z_slice]] = semantic_id
    return result


def _box_voxel_slices(
    center: np.ndarray,
    size: np.ndarray,
    yaw: float,
    margin: float,
    origin: np.ndarray,
    grid_shape: Tuple[int, int, int],
    voxel_size: float,
) -> Tuple[slice, slice, slice]:
    half_x = size[0] / 2.0 + margin
    half_y = size[1] / 2.0 + margin
    cosine = abs(np.cos(yaw))
    sine = abs(np.sin(yaw))
    xy_radius = np.asarray(
        [
            cosine * half_x + sine * half_y,
            sine * half_x + cosine * half_y,
        ]
    )
    radius = np.asarray([xy_radius[0], xy_radius[1], size[2] / 2.0 + margin])
    lower = center - radius
    upper = center + radius
    starts = np.floor((lower - origin) / voxel_size - 0.5).astype(np.int64)
    stops = np.ceil((upper - origin) / voxel_size - 0.5).astype(np.int64) + 1
    starts = np.clip(starts, 0, np.asarray(grid_shape, dtype=np.int64))
    stops = np.clip(stops, 0, np.asarray(grid_shape, dtype=np.int64))
    return tuple(
        slice(int(start), int(stop)) for start, stop in zip(starts, stops)
    )


def _grid_geometry(
    pc_range: Sequence[float], voxel_size: float
) -> Tuple[np.ndarray, Tuple[int, int, int]]:
    bounds = np.asarray(pc_range, dtype=np.float64)
    if bounds.shape != (6,) or not np.all(np.isfinite(bounds)):
        raise ValueError(f"pc_range must contain 6 finite values, got {pc_range}")
    if not np.all(bounds[3:] > bounds[:3]):
        raise ValueError(f"pc_range maxima must exceed minima, got {pc_range}")
    if not np.isfinite(voxel_size) or voxel_size <= 0:
        raise ValueError(f"voxel_size must be positive and finite, got {voxel_size}")

    dimensions = (bounds[3:] - bounds[:3]) / voxel_size
    rounded_dimensions = np.rint(dimensions)
    if not np.allclose(dimensions, rounded_dimensions, rtol=0.0, atol=1e-9):
        raise ValueError(
            "pc_range extents must be integer multiples of voxel_size, "
            f"got extents {bounds[3:] - bounds[:3]} and voxel_size {voxel_size}"
        )
    grid_shape = tuple(int(value) for value in rounded_dimensions)
    return bounds[:3], grid_shape


def _validate_labeled_points(points: np.ndarray, labels: np.ndarray) -> None:
    if points.ndim != 2 or points.shape[1] != 3:
        raise ValueError(f"points_xyz must have shape (N, 3), got {points.shape}")
    if labels.ndim != 1 or labels.shape[0] != points.shape[0]:
        raise ValueError(
            "semantic_ids must have shape (N,) matching points_xyz, "
            f"got {labels.shape} for {points.shape[0]} points"
        )
    if not np.issubdtype(labels.dtype, np.integer):
        raise TypeError(f"semantic_ids must contain integers, got {labels.dtype}")


def _validate_boxes(
    centers: np.ndarray,
    sizes: np.ndarray,
    yaws: np.ndarray,
    semantic_ids: np.ndarray,
) -> None:
    if centers.ndim != 2 or centers.shape[1] != 3:
        raise ValueError(f"centers must have shape (N, 3), got {centers.shape}")
    if sizes.shape != centers.shape:
        raise ValueError(
            f"sizes must match centers shape {centers.shape}, got {sizes.shape}"
        )
    box_count = centers.shape[0]
    if yaws.shape != (box_count,) or semantic_ids.shape != (box_count,):
        raise ValueError(
            "yaws and semantic_ids must each have shape (N,), "
            f"got {yaws.shape} and {semantic_ids.shape}"
        )
    if not np.all(np.isfinite(centers)) or not np.all(np.isfinite(yaws)):
        raise ValueError("centers and yaws must contain only finite values")
    if not np.all(np.isfinite(sizes)) or np.any(sizes <= 0):
        raise ValueError("sizes must contain only positive finite values")
    if not np.issubdtype(semantic_ids.dtype, np.integer):
        raise TypeError(
            f"semantic_ids must contain integers, got {semantic_ids.dtype}"
        )
