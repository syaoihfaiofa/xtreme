"""Sparse JSON payloads for OCC visualization."""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np


VISUALIZATION_SCHEMA_VERSION = "xtreme-occ-visualization/v1"
DEFAULT_MAX_VOXELS = 100_000


def build_occ_visualization(
    labels: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    semantic_ids: Optional[Sequence[int]] = None,
    selection: str = "semantic",
    max_voxels: int = DEFAULT_MAX_VOXELS,
    mask_lidar: Optional[np.ndarray] = None,
    mask_camera: Optional[np.ndarray] = None,
    source_class_ids: Optional[np.ndarray] = None,
) -> Dict[str, object]:
    """Build a deterministic sparse representation of a semantic OCC grid."""
    label_grid = np.asarray(labels)
    bounds = np.asarray(pc_range, dtype=np.float64)
    _validate_inputs(label_grid, bounds, voxel_size, semantic_ids, max_voxels)
    lidar_mask = _mask_or_none(mask_lidar, label_grid.shape, "mask_lidar")
    camera_mask = _mask_or_none(mask_camera, label_grid.shape, "mask_camera")

    if selection == "lidar-mask":
        if lidar_mask is None:
            raise ValueError("mask_lidar is required for lidar-mask visualization")
        selected = lidar_mask
    elif selection == "camera-mask":
        if camera_mask is None:
            raise ValueError("mask_camera is required for camera-mask visualization")
        selected = camera_mask
    elif selection != "semantic":
        raise ValueError(f"unsupported visualization selection: {selection!r}")
    elif semantic_ids is None:
        # 255 represents unobserved/unknown space, not an occupied semantic
        # voxel. Rendering it floods the capped response and hides real objects.
        selected = (label_grid != 0) & (label_grid != 255)
    else:
        selected = np.isin(
            label_grid,
            np.asarray(semantic_ids, dtype=label_grid.dtype),
        )

    coordinates = np.argwhere(selected)
    if coordinates.shape[0] > max_voxels:
        selected_indices = np.linspace(
            0,
            coordinates.shape[0] - 1,
            num=max_voxels,
            dtype=np.int64,
        )
        coordinates = coordinates[selected_indices]

    source_class_grid = _grid_or_none(
        source_class_ids, label_grid.shape, "source_class_ids"
    )
    voxels: List[Dict[str, object]] = []
    for x, y, z in coordinates:
        voxel: Dict[str, object] = {
            "x": int(x),
            "y": int(y),
            "z": int(z),
            "semanticId": int(label_grid[x, y, z]),
        }
        if lidar_mask is not None:
            voxel["lidarObserved"] = bool(lidar_mask[x, y, z])
        if camera_mask is not None:
            voxel["cameraObserved"] = bool(camera_mask[x, y, z])
        if source_class_grid is not None and int(source_class_grid[x, y, z]) > 0:
            voxel["sourceClassId"] = int(source_class_grid[x, y, z])
        voxels.append(voxel)

    return {
        "schemaVersion": VISUALIZATION_SCHEMA_VERSION,
        "voxelSize": float(voxel_size),
        "pcRange": bounds.tolist(),
        "voxels": voxels,
    }


def _mask_or_none(
    value: Optional[np.ndarray], expected_shape: Tuple[int, ...], name: str
) -> Optional[np.ndarray]:
    if value is None:
        return None
    mask = np.asarray(value, dtype=bool)
    if mask.shape != expected_shape:
        raise ValueError(
            f"{name} shape must match labels shape, got {mask.shape} and {expected_shape}"
        )
    return mask


def _grid_or_none(
    value: Optional[np.ndarray], expected_shape: Tuple[int, ...], name: str
) -> Optional[np.ndarray]:
    if value is None:
        return None
    grid = np.asarray(value)
    if grid.shape != expected_shape:
        raise ValueError(
            f"{name} shape must match labels shape, got {grid.shape} and {expected_shape}"
        )
    if not np.issubdtype(grid.dtype, np.integer):
        raise TypeError(f"{name} must contain integers, got {grid.dtype}")
    return grid


def _validate_inputs(
    labels: np.ndarray,
    pc_range: np.ndarray,
    voxel_size: float,
    semantic_ids: Optional[Sequence[int]],
    max_voxels: int,
) -> None:
    if labels.ndim != 3:
        raise ValueError(f"labels must be 3-dimensional, got {labels.shape}")
    if not np.issubdtype(labels.dtype, np.integer):
        raise TypeError(f"labels must contain integers, got {labels.dtype}")
    if pc_range.shape != (6,) or not np.all(np.isfinite(pc_range)):
        raise ValueError(
            f"pc_range must contain 6 finite values, got {pc_range.tolist()}"
        )
    if not np.all(pc_range[3:] > pc_range[:3]):
        raise ValueError(
            f"pc_range maxima must exceed minima, got {pc_range.tolist()}"
        )
    if not np.isfinite(voxel_size) or voxel_size <= 0:
        raise ValueError(
            f"voxel_size must be positive and finite, got {voxel_size}"
        )
    if not isinstance(max_voxels, int) or isinstance(max_voxels, bool):
        raise TypeError(f"max_voxels must be an integer, got {max_voxels}")
    if max_voxels <= 0:
        raise ValueError(f"max_voxels must be positive, got {max_voxels}")
    if semantic_ids is not None:
        if any(
            not isinstance(semantic_id, (int, np.integer))
            or isinstance(semantic_id, (bool, np.bool_))
            for semantic_id in semantic_ids
        ):
            raise TypeError("semantic_ids must contain only integers")
