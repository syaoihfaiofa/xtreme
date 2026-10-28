from typing import Any, Dict, Optional, Sequence, Tuple

import numpy as np


AUTO_NON_GROUND_TOLERANCE = 12
GROUND_FIELD = 'ground'


def append_ground_labels(
    points: np.ndarray,
    ground_correction_mask: Optional[Dict[str, Any]],
) -> Tuple[np.ndarray, str]:
    if points.dtype.names is None:
        raise ValueError('PCD points must be a structured array')
    if GROUND_FIELD in points.dtype.names:
        raise ValueError('PCD already contains a ground field')

    _require_xyz_fields(points)
    operations = _parse_ground_correction_mask(ground_correction_mask)
    automatic_ground = _automatic_ground_mask(points)
    forced_ground = _forced_ground_mask(points, operations)

    labeled = np.empty(
        points.shape,
        dtype=points.dtype.descr + [(GROUND_FIELD, np.uint8)],
    )
    for field_name in points.dtype.names:
        labeled[field_name] = points[field_name]
    labeled[GROUND_FIELD] = np.logical_or(automatic_ground, forced_ground).astype(np.uint8)

    rule = 'auto-plus-manual' if _has_color_and_intensity(points) else 'manual-only'
    return labeled, rule


def _require_xyz_fields(points: np.ndarray) -> None:
    required = {'x', 'y', 'z'}
    missing = required.difference(points.dtype.names)
    if missing:
        raise ValueError('PCD is missing required XYZ fields: {}'.format(', '.join(sorted(missing))))


def _parse_ground_correction_mask(
    ground_correction_mask: Optional[Dict[str, Any]],
) -> Sequence[Dict[str, Any]]:
    if ground_correction_mask is None:
        return []
    if not isinstance(ground_correction_mask, dict):
        raise ValueError('groundCorrectionMask must be an object')
    if ground_correction_mask.get('version') != 1:
        raise ValueError('groundCorrectionMask version must be 1')
    operations = ground_correction_mask.get('operations')
    if not isinstance(operations, list):
        raise ValueError('groundCorrectionMask operations must be a list')
    for operation in operations:
        _validate_operation(operation)
    return operations


def _validate_operation(operation: Any) -> None:
    if not isinstance(operation, dict):
        raise ValueError('groundCorrectionMask operation must be an object')
    operation_type = operation.get('type')
    if operation_type == 'polygon':
        vertices = operation.get('vertices')
        if not isinstance(vertices, list) or len(vertices) < 3 or not all(_is_point(vertex) for vertex in vertices):
            raise ValueError('groundCorrectionMask polygon vertices are invalid')
        return
    if operation_type == 'brush':
        samples = operation.get('samples')
        center = operation.get('center')
        if not _is_number(operation.get('radius')) or operation['radius'] <= 0:
            raise ValueError('groundCorrectionMask brush radius is invalid')
        if not _is_point(center) and (
            not isinstance(samples, list) or not samples or not all(_is_point(sample) for sample in samples)
        ):
            raise ValueError('groundCorrectionMask brush center or samples are invalid')
        height_range = operation.get('heightRange')
        if height_range is not None and (
            not isinstance(height_range, dict)
            or not _is_number(height_range.get('min'))
            or not _is_number(height_range.get('max'))
            or height_range['min'] > height_range['max']
        ):
            raise ValueError('groundCorrectionMask brush heightRange is invalid')
        return
    raise ValueError('groundCorrectionMask operation type is invalid')


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and np.isfinite(value)


def _is_point(value: Any) -> bool:
    return isinstance(value, dict) and _is_number(value.get('x')) and _is_number(value.get('y'))


def _has_color_and_intensity(points: np.ndarray) -> bool:
    fields = set(points.dtype.names)
    return ('rgb' in fields or {'r', 'g', 'b'}.issubset(fields)) and _intensity_field(points) is not None


def _intensity_field(points: np.ndarray) -> Optional[str]:
    for field_name in ('intensity', 'i', 'int'):
        if field_name in points.dtype.names:
            return field_name
    return None


def _automatic_ground_mask(points: np.ndarray) -> np.ndarray:
    if not _has_color_and_intensity(points):
        return np.zeros(len(points), dtype=bool)
    red, green, blue = _color_channels(points)
    intensity = np.asarray(points[_intensity_field(points)], dtype=np.float64)
    intensity = np.where((intensity > 0) & (intensity < 1), intensity * 255, intensity)
    automatic_non_ground = (
        np.abs(red - intensity) < AUTO_NON_GROUND_TOLERANCE
    ) & (
        np.abs(green - intensity) < AUTO_NON_GROUND_TOLERANCE
    ) & (
        np.abs(blue - intensity) < AUTO_NON_GROUND_TOLERANCE
    )
    return ~automatic_non_ground


def _color_channels(points: np.ndarray) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    fields = set(points.dtype.names)
    if {'r', 'g', 'b'}.issubset(fields):
        return (
            np.asarray(points['r'], dtype=np.float64),
            np.asarray(points['g'], dtype=np.float64),
            np.asarray(points['b'], dtype=np.float64),
        )
    rgb = np.asarray(points['rgb'])
    if np.issubdtype(rgb.dtype, np.floating):
        if rgb.dtype.itemsize != 4:
            raise ValueError('PCD rgb float field must be float32')
        rgb = rgb.astype(np.float32, copy=False).view(np.uint32)
    else:
        rgb = rgb.astype(np.uint32, copy=False)
    return (
        ((rgb >> 16) & 0xff).astype(np.float64),
        ((rgb >> 8) & 0xff).astype(np.float64),
        (rgb & 0xff).astype(np.float64),
    )


def _forced_ground_mask(points: np.ndarray, operations: Sequence[Dict[str, Any]]) -> np.ndarray:
    forced = np.zeros(len(points), dtype=bool)
    for index, point in enumerate(points):
        x, y, z = float(point['x']), float(point['y']), float(point['z'])
        forced[index] = any(
            _is_inside_polygon(x, y, operation['vertices'])
            if operation['type'] == 'polygon'
            else _is_inside_brush(x, y, z, operation)
            for operation in operations
        )
    return forced


def _is_inside_brush(x: float, y: float, z: float, operation: Dict[str, Any]) -> bool:
    height_range = operation.get('heightRange')
    if height_range is not None and (z < height_range['min'] or z > height_range['max']):
        return False
    samples = operation.get('samples') or [operation['center']]
    radius_squared = operation['radius'] * operation['radius']
    return any(
        (x - sample['x']) * (x - sample['x']) + (y - sample['y']) * (y - sample['y'])
        <= radius_squared
        for sample in samples
    )


def _is_inside_polygon(x: float, y: float, vertices: Sequence[Dict[str, Any]]) -> bool:
    inside = False
    previous = vertices[-1]
    for current in vertices:
        if _is_on_segment(x, y, previous, current):
            return True
        if (current['y'] > y) != (previous['y'] > y):
            intersection = (previous['x'] - current['x']) * (y - current['y']) / (
                previous['y'] - current['y']
            ) + current['x']
            if x < intersection:
                inside = not inside
        previous = current
    return inside


def _is_on_segment(x: float, y: float, start: Dict[str, Any], end: Dict[str, Any]) -> bool:
    dx = end['x'] - start['x']
    dy = end['y'] - start['y']
    cross = (x - start['x']) * dy - (y - start['y']) * dx
    if abs(cross) > np.finfo(float).eps:
        return False
    dot = (x - start['x']) * dx + (y - start['y']) * dy
    return 0 <= dot <= dx * dx + dy * dy
