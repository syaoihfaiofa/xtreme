"""NumPy-only object visibility calculations."""

from __future__ import annotations

from typing import List, Mapping, Sequence, Tuple

import numpy as np

from xtreme_occ.camera_projection import project_points
from xtreme_occ.visibility import (
    bev_visibility_or,
    split_polyline,
)


Camera = Mapping[str, object]
Segment = Tuple[np.ndarray, np.ndarray]
MIN_POLYLINE_HEIGHT = 0.1
POLYLINE_QUERY_MARGIN = 0.05


def project_subjects(
    camera: Camera, subject_xyz: np.ndarray
) -> Tuple[np.ndarray, np.ndarray]:
    """Project world-space subjects and report which ones are in the image."""
    subjects = _subject_points(subject_xyz)
    try:
        return project_points(camera, subjects)
    except (TypeError, ValueError) as error:
        raise type(error)(
            f"camera {_camera_name(camera)!r} calibration is invalid: {error}"
        ) from error


def box_visible_ratio(
    cameras: Sequence[Camera],
    occupied: np.ndarray,
    semantics: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    subject_xyz: np.ndarray,
    box_vertices: np.ndarray | None = None,
    carve_subject_xyz: np.ndarray | None = None,
) -> Tuple[np.ndarray, float]:
    """Return per-camera visible voxel disk area ratios and their maximum."""
    occupancy_grid, grid_origin = _visibility_grid(
        occupied, semantics, pc_range, voxel_size
    )
    subjects = _subject_points(subject_xyz)
    carve_subjects = (
        subjects
        if carve_subject_xyz is None
        else _subject_points(carve_subject_xyz)
    )
    subject_indices = np.floor(
        (carve_subjects - grid_origin) / voxel_size
    ).astype(np.int64)
    shape = np.asarray(occupancy_grid.shape, dtype=np.int64)
    in_grid = np.all(
        (subject_indices >= 0) & (subject_indices < shape), axis=1
    )
    if np.any(in_grid):
        carved_voxels = np.unique(
            np.ravel_multi_index(
                subject_indices[in_grid].T, occupancy_grid.shape
            )
        )
    else:
        carved_voxels = np.empty(0, dtype=np.int64)

    ratios = np.zeros(len(cameras), dtype=np.float64)
    if subjects.shape[0] == 0:
        return ratios, 0.0

    for index, camera in enumerate(cameras):
        rotation, translation = _camera_extrinsics(camera)
        subject_pixels, in_fov = project_subjects(camera, subjects)
        camera_origin = -rotation.T @ translation
        occluded = _sampled_ray_occluded(
            occupancy_grid,
            grid_origin=grid_origin,
            voxel_size=voxel_size,
            camera_origin=camera_origin,
            target_points=subjects,
            carved_voxels=carved_voxels,
        )
        visible_pixels = _visible_subject_pixels(
            camera,
            subjects[in_fov & ~occluded],
            subject_pixels[in_fov & ~occluded],
            voxel_size,
        )
        if box_vertices is None:
            ratios[index] = np.count_nonzero(in_fov & ~occluded) / subjects.shape[0]
        else:
            hull_area = _projected_hull_area(camera, box_vertices)
            ratios[index] = (
                min(1.0, len(visible_pixels) / hull_area)
                if hull_area > 0.0
                else 0.0
            )
    maximum = float(np.max(ratios)) if ratios.size else 0.0
    return ratios, maximum


def _sampled_ray_occluded(
    occupied: np.ndarray,
    grid_origin: np.ndarray,
    voxel_size: float,
    camera_origin: np.ndarray,
    target_points: np.ndarray,
    carved_voxels: np.ndarray,
) -> np.ndarray:
    """Sample the open camera ray at the Horizon visibility fractions."""
    fractions = np.linspace(0.02, 0.92, 48, dtype=np.float64)
    samples = (
        camera_origin[None, None, :]
        + fractions[None, :, None]
        * (target_points[:, None, :] - camera_origin[None, None, :])
    )
    indices = np.floor((samples - grid_origin) / voxel_size).astype(np.int64)
    shape = np.asarray(occupied.shape, dtype=np.int64)
    in_grid = np.all((indices >= 0) & (indices < shape), axis=2)
    result = np.zeros(in_grid.shape, dtype=bool)
    valid_indices = indices[in_grid]
    if valid_indices.size == 0:
        return np.any(result, axis=1)
    flat_indices = np.ravel_multi_index(valid_indices.T, occupied.shape)
    sampled_occupied = occupied.ravel()[flat_indices]
    if carved_voxels.size:
        sampled_occupied &= ~np.isin(flat_indices, carved_voxels)
    result[in_grid] = sampled_occupied
    return np.any(result, axis=1)


def _visible_subject_pixels(
    camera: Camera,
    subjects: np.ndarray,
    pixels: np.ndarray,
    voxel_size: float,
) -> set[Tuple[int, int]]:
    visible_pixels: set[Tuple[int, int]] = set()
    width = _positive_camera_dimension(camera, "width")
    height = _positive_camera_dimension(camera, "height")
    for subject, pixel in zip(subjects, pixels):
        radius = _subject_disk_radius(camera, subject, pixel, voxel_size)
        x_min = max(0, int(np.ceil(pixel[0] - radius)))
        x_max = min(width - 1, int(np.floor(pixel[0] + radius)))
        y_min = max(0, int(np.ceil(pixel[1] - radius)))
        y_max = min(height - 1, int(np.floor(pixel[1] + radius)))
        for y in range(y_min, y_max + 1):
            for x in range(x_min, x_max + 1):
                if (x - pixel[0]) ** 2 + (y - pixel[1]) ** 2 <= radius**2:
                    visible_pixels.add((x, y))
    return visible_pixels


def _subject_disk_radius(
    camera: Camera,
    subject: np.ndarray,
    pixel: np.ndarray,
    voxel_size: float,
) -> float:
    offsets = np.array(
        [
            [x, y, z]
            for x in (-0.5, 0.5)
            for y in (-0.5, 0.5)
            for z in (-0.5, 0.5)
        ],
        dtype=np.float64,
    ) * voxel_size
    corners, in_image = project_points(camera, subject[None, :] + offsets)
    finite_corners = corners[np.isfinite(corners).all(axis=1) & in_image]
    if finite_corners.size == 0:
        return 0.5
    return max(0.5, float(np.max(np.linalg.norm(finite_corners - pixel, axis=1))))


def _projected_hull_area(camera: Camera, vertices: np.ndarray) -> float:
    points = _subject_points(vertices)
    pixels, _ = project_subjects(camera, points)
    pixels = pixels[np.isfinite(pixels).all(axis=1)]
    if pixels.shape[0] < 3:
        return 0.0
    hull = _convex_hull(pixels)
    if hull.shape[0] < 3:
        return 0.0
    return abs(
        0.5
        * float(
            np.dot(hull[:, 0], np.roll(hull[:, 1], -1))
            - np.dot(hull[:, 1], np.roll(hull[:, 0], -1))
        )
    )


def _convex_hull(points: np.ndarray) -> np.ndarray:
    ordered = sorted({(float(x), float(y)) for x, y in points})
    if len(ordered) <= 1:
        return np.asarray(ordered, dtype=np.float64)

    def cross(
        origin: Tuple[float, float],
        first: Tuple[float, float],
        second: Tuple[float, float],
    ) -> float:
        return (
            (first[0] - origin[0]) * (second[1] - origin[1])
            - (first[1] - origin[1]) * (second[0] - origin[0])
        )

    lower: List[Tuple[float, float]] = []
    for point in ordered:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0.0:
            lower.pop()
        lower.append(point)
    upper: List[Tuple[float, float]] = []
    for point in reversed(ordered):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0.0:
            upper.pop()
        upper.append(point)
    return np.asarray(lower[:-1] + upper[:-1], dtype=np.float64)


def polyline_bev_visibility(
    points: np.ndarray,
    segment_length: float,
    per_camera: np.ndarray,
) -> Tuple[List[Segment], np.ndarray]:
    """Split a polyline and OR its per-camera visibility for the BEV view."""
    segments = split_polyline(points, segment_length)
    camera_visibility = np.asarray(per_camera, dtype=bool)
    if camera_visibility.ndim != 2 or camera_visibility.shape[1] != len(segments):
        raise ValueError(
            "per_camera must have shape (camera, segment) matching the "
            f"{len(segments)} split segments, got {camera_visibility.shape}"
        )
    return segments, bev_visibility_or(camera_visibility)


def polyline_segment_visibility(
    cameras: Sequence[Camera],
    occupied: np.ndarray,
    semantics: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    points: np.ndarray,
    top_points: np.ndarray,
    subject_xyz: np.ndarray,
    segment_length: float,
    half_width: float,
    slab_height: float,
    slab_visible_ratio: float,
    segment_visible_ratio: float,
) -> Tuple[List[Segment], np.ndarray, np.ndarray]:
    """Calculate per-camera and BEV visibility for vertical polyline slabs."""
    bottom = _subject_points(points)
    top = _subject_points(top_points)
    subjects = _subject_points(subject_xyz)
    segments = split_polyline(bottom, segment_length)
    per_camera = np.zeros((len(cameras), len(segments)), dtype=bool)
    if not segments:
        return segments, per_camera, np.zeros(0, dtype=bool)

    if top.shape[0] < 2:
        raise ValueError("top_points must contain at least 2 points")
    if (
        np.linalg.norm(bottom[0] - top[-1])
        + np.linalg.norm(bottom[-1] - top[0])
        < np.linalg.norm(bottom[0] - top[0])
        + np.linalg.norm(bottom[-1] - top[-1])
    ):
        top = top[::-1]
    bottom_vertices = np.vstack((segments[0][0], [end for _, end in segments]))
    bottom_fractions = _polyline_arc_fractions(bottom, bottom_vertices)
    top_vertices = _sample_polyline(top, bottom_fractions)
    if np.any(top_vertices[:, 2] - bottom_vertices[:, 2] < MIN_POLYLINE_HEIGHT):
        raise ValueError(
            f"top_points must be at least {MIN_POLYLINE_HEIGHT} above bottom points"
        )

    for segment_index, (start, end) in enumerate(segments):
        top_start = top_vertices[segment_index]
        top_end = top_vertices[segment_index + 1]
        segment_candidates = subjects[
            _points_inside_polyline_envelope(
                subjects,
                start,
                end,
                top_start,
                top_end,
                half_width,
                slab_height,
            )
        ]
        maximum_height = max(
            abs(float(top_start[2] - start[2])),
            abs(float(top_end[2] - end[2])),
        )
        slab_fractions = _slab_fractions(maximum_height, slab_height)
        slab_count = len(slab_fractions) - 1
        segment_subjects = segment_candidates[
            _points_inside_polyline_slab(
                segment_candidates,
                start,
                end,
                top_start,
                top_end,
                half_width,
                slab_height,
                0,
                1,
            )
        ]
        visible_slabs = np.zeros((len(cameras), slab_count), dtype=bool)
        for slab_index, (lower_fraction, upper_fraction) in enumerate(
            zip(slab_fractions[:-1], slab_fractions[1:])
        ):
            slab_subjects = segment_candidates[
                _points_inside_polyline_slab(
                    segment_candidates,
                    start,
                    end,
                    top_start,
                    top_end,
                    half_width,
                    slab_height,
                    lower_fraction,
                    upper_fraction,
                )
            ]
            if slab_subjects.shape[0] == 0:
                continue
            ratios, _ = box_visible_ratio(
                cameras,
                occupied,
                semantics,
                pc_range,
                voxel_size,
                slab_subjects,
                _polyline_slab_vertices(
                    start,
                    end,
                    top_start,
                    top_end,
                    half_width,
                    lower_fraction,
                    upper_fraction,
                ),
                segment_subjects,
            )
            visible_slabs[:, slab_index] = ratios > slab_visible_ratio
        per_camera[:, segment_index] = (
            np.count_nonzero(visible_slabs, axis=1) / slab_count
            > segment_visible_ratio
        )
    return segments, per_camera, bev_visibility_or(per_camera)


def _points_inside_polyline_envelope(
    points: np.ndarray,
    start: np.ndarray,
    end: np.ndarray,
    top_start: np.ndarray,
    top_end: np.ndarray,
    half_width: float,
    slab_height: float,
) -> np.ndarray:
    """Return a conservative candidate mask for all slabs in one segment."""
    vertices = np.vstack((start, end, top_start, top_end))
    xy_margin = half_width + POLYLINE_QUERY_MARGIN
    z_margin = max(POLYLINE_QUERY_MARGIN, slab_height / 2.0)
    return (
        (points[:, 0] >= np.min(vertices[:, 0]) - xy_margin)
        & (points[:, 0] <= np.max(vertices[:, 0]) + xy_margin)
        & (points[:, 1] >= np.min(vertices[:, 1]) - xy_margin)
        & (points[:, 1] <= np.max(vertices[:, 1]) + xy_margin)
        & (points[:, 2] >= np.min(vertices[:, 2]) - z_margin)
        & (points[:, 2] <= np.max(vertices[:, 2]) + z_margin)
    )


def _polyline_slab_vertices(
    start: np.ndarray,
    end: np.ndarray,
    top_start: np.ndarray,
    top_end: np.ndarray,
    half_width: float,
    lower_fraction: float,
    upper_fraction: float,
) -> np.ndarray:
    lower_start = start + lower_fraction * (top_start - start)
    lower_end = end + lower_fraction * (top_end - end)
    upper_start = start + upper_fraction * (top_start - start)
    upper_end = end + upper_fraction * (top_end - end)
    direction = ((lower_end + upper_end) - (lower_start + upper_start))[:2]
    length = float(np.linalg.norm(direction))
    if length <= np.finfo(np.float64).eps:
        raise ValueError("polyline slab must span a non-zero BEV distance")
    offset = np.array(
        [-direction[1] / length * half_width, direction[0] / length * half_width, 0.0]
    )
    return np.asarray(
        [
            lower_start - offset,
            lower_start + offset,
            lower_end - offset,
            lower_end + offset,
            upper_start - offset,
            upper_start + offset,
            upper_end - offset,
            upper_end + offset,
        ],
        dtype=np.float64,
    )


def _sample_polyline(points: np.ndarray, fractions: np.ndarray) -> np.ndarray:
    edge_lengths = np.linalg.norm(np.diff(points[:, :2], axis=0), axis=1)
    useful_edges = edge_lengths > 0.0
    if not np.any(useful_edges):
        raise ValueError("top_points must span a non-zero BEV distance")
    retained = np.concatenate(([True], useful_edges))
    vertices = points[retained]
    edge_lengths = np.linalg.norm(np.diff(vertices[:, :2], axis=0), axis=1)
    cumulative = np.concatenate(([0.0], np.cumsum(edge_lengths)))
    cuts = np.asarray(fractions, dtype=np.float64) * float(cumulative[-1])
    return np.stack(
        [
            np.interp(cuts, cumulative, vertices[:, dimension])
            for dimension in range(3)
        ],
        axis=1,
    )


def _polyline_arc_fractions(
    points: np.ndarray, samples: np.ndarray
) -> np.ndarray:
    vertices = _subject_points(points)
    sampled = _subject_points(samples)
    edge_vectors = np.diff(vertices[:, :2], axis=0)
    edge_lengths = np.linalg.norm(edge_vectors, axis=1)
    useful_edges = edge_lengths > 0.0
    if not np.any(useful_edges):
        raise ValueError("polyline must span a non-zero BEV distance")
    starts = vertices[:-1, :2][useful_edges]
    vectors = edge_vectors[useful_edges]
    lengths = edge_lengths[useful_edges]
    relative = sampled[:, None, :2] - starts[None, :, :]
    parameters = np.clip(
        np.sum(relative * vectors[None, :, :], axis=2) / lengths[None, :] ** 2,
        0.0,
        1.0,
    )
    closest = starts[None, :, :] + parameters[:, :, None] * vectors[None, :, :]
    edge_index = np.argmin(
        np.sum((sampled[:, None, :2] - closest) ** 2, axis=2), axis=1
    )
    cumulative = np.concatenate(([0.0], np.cumsum(lengths)))
    distances = cumulative[edge_index] + parameters[
        np.arange(sampled.shape[0]), edge_index
    ] * lengths[edge_index]
    return distances / cumulative[-1]


def _points_inside_polyline_slab(
    points: np.ndarray,
    start: np.ndarray,
    end: np.ndarray,
    top_start: np.ndarray,
    top_end: np.ndarray,
    half_width: float,
    slab_height: float,
    lower_fraction: float,
    upper_fraction: float,
) -> np.ndarray:
    slab_center_fraction = (lower_fraction + upper_fraction) / 2.0
    slab_start = start + slab_center_fraction * (top_start - start)
    slab_end = end + slab_center_fraction * (top_end - end)
    direction = slab_end[:2] - slab_start[:2]
    length_squared = float(direction @ direction)
    if length_squared <= np.finfo(np.float64).eps:
        return np.zeros(points.shape[0], dtype=bool)
    raw_along = (
        (points[:, :2] - slab_start[:2]) @ direction
    ) / length_squared
    along = np.clip(raw_along, 0.0, 1.0)
    closest = slab_start[:2] + along[:, None] * direction
    within_footprint = (
        (raw_along >= -POLYLINE_QUERY_MARGIN / np.sqrt(length_squared))
        & (raw_along <= 1.0 + POLYLINE_QUERY_MARGIN / np.sqrt(length_squared))
        & (
            np.linalg.norm(points[:, :2] - closest, axis=1)
            <= half_width + POLYLINE_QUERY_MARGIN
        )
    )
    bottom_z = start[2] + along * (end[2] - start[2])
    top_z = top_start[2] + along * (top_end[2] - top_start[2])
    lower = np.minimum(bottom_z, top_z)
    upper = np.maximum(bottom_z, top_z)
    zero_height = np.isclose(lower, upper)
    lower[zero_height] -= slab_height / 2.0
    upper[zero_height] += slab_height / 2.0
    slab_lower = lower + (upper - lower) * lower_fraction
    slab_upper = lower + (upper - lower) * upper_fraction
    return within_footprint & (
        points[:, 2] >= slab_lower - POLYLINE_QUERY_MARGIN
    ) & (
        points[:, 2] <= slab_upper + POLYLINE_QUERY_MARGIN
    )


def _slab_fractions(height: float, slab_height: float) -> np.ndarray:
    if not np.isfinite(height) or height <= 0.0:
        return np.asarray([0.0, 1.0], dtype=np.float64)
    cuts = np.arange(0.0, height, slab_height, dtype=np.float64)
    cuts = np.append(cuts, height)
    if cuts.size > 2 and height - cuts[-2] < 0.5 * slab_height:
        cuts = np.delete(cuts, -2)
    return cuts / height


def _camera_extrinsics(camera: Camera) -> Tuple[np.ndarray, np.ndarray]:
    rotation = np.asarray(camera.get("R"), dtype=np.float64)
    translation = np.asarray(camera.get("t"), dtype=np.float64)
    if rotation.shape != (3, 3):
        raise ValueError(f"camera R must have shape (3, 3), got {rotation.shape}")
    if translation.shape != (3,):
        raise ValueError(f"camera t must have shape (3,), got {translation.shape}")
    if not np.all(np.isfinite(rotation)) or not np.all(np.isfinite(translation)):
        raise ValueError("camera R and t must contain only finite values")
    return rotation, translation


def _camera_name(camera: Camera) -> str:
    value = camera.get("name", "unknown")
    return value if isinstance(value, str) and value else "unknown"


def _finite_camera_scalar(camera: Camera, key: str) -> float:
    value = camera.get(key)
    if not isinstance(value, (int, float, np.integer, np.floating)):
        raise TypeError(f"camera {key} must be numeric, got {value!r}")
    result = float(value)
    if not np.isfinite(result):
        raise ValueError(f"camera {key} must be finite, got {value!r}")
    return result


def _positive_camera_dimension(camera: Camera, key: str) -> int:
    value = _finite_camera_scalar(camera, key)
    if value <= 0 or not value.is_integer():
        raise ValueError(f"camera {key} must be a positive integer, got {value}")
    return int(value)


def _subject_points(subject_xyz: np.ndarray) -> np.ndarray:
    subjects = np.asarray(subject_xyz, dtype=np.float64)
    if subjects.ndim != 2 or subjects.shape[1] != 3:
        raise ValueError(
            f"subject_xyz must have shape (N, 3), got {subjects.shape}"
        )
    if not np.all(np.isfinite(subjects)):
        raise ValueError("subject_xyz must contain only finite values")
    return subjects


def _visibility_grid(
    occupied: np.ndarray,
    semantics: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
) -> Tuple[np.ndarray, np.ndarray]:
    occupancy_grid = np.asarray(occupied, dtype=bool)
    semantic_grid = np.asarray(semantics)
    if occupancy_grid.ndim != 3:
        raise ValueError(
            f"occupied must be 3-dimensional, got {occupancy_grid.shape}"
        )
    if semantic_grid.shape != occupancy_grid.shape:
        raise ValueError(
            "semantics shape must match occupied shape, "
            f"got {semantic_grid.shape} and {occupancy_grid.shape}"
        )
    bounds = np.asarray(pc_range, dtype=np.float64)
    if bounds.shape != (6,) or not np.all(np.isfinite(bounds)):
        raise ValueError(f"pc_range must contain 6 finite values, got {pc_range}")
    if not np.all(bounds[3:] > bounds[:3]):
        raise ValueError(f"pc_range maxima must exceed minima, got {pc_range}")
    if not np.isfinite(voxel_size) or voxel_size <= 0:
        raise ValueError(
            f"voxel_size must be positive and finite, got {voxel_size}"
        )
    dimensions = (bounds[3:] - bounds[:3]) / voxel_size
    if not np.allclose(
        dimensions, occupancy_grid.shape, rtol=0.0, atol=1e-9
    ):
        raise ValueError(
            "occupied shape must match pc_range and voxel_size, "
            f"got {occupancy_grid.shape} for dimensions {dimensions}"
        )
    return occupancy_grid, bounds[:3]
