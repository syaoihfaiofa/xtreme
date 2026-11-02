from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
from scipy.spatial import cKDTree


AUTO_NON_GROUND_TOLERANCE = 12
GROUND_FIELD = 'ground'
# Ego vehicle body (rear-axle origin); same as EGO_BODY_RANGE in pc-tool forceGround.ts.
# XY matches HORIZON_EGO_RANGE in backend/occ-worker/xtreme_occ/fusion.py, but the bottom
# is raised to 0.0 so ground under the vehicle (up to about -0.2) is not treated as body.
EGO_BODY_RANGE = np.array([-1.17, -1.2, 0.0, 3.8, 1.2, 1.4], dtype=np.float64)
# Same as WALL_PROTECTION_THICKNESS in pc-tool GroundCorrectionMaskManager.ts.
WALL_PROTECTION_THICKNESS = 0.2
PROTECTED_ANNOTATION_TYPES = ('3D_BOX', 'IRREGULAR_WALL')


@dataclass(frozen=True)
class ProtectedBox:
    center: np.ndarray
    half_size: np.ndarray
    # Columns are the box axes in world coordinates.
    rotation: np.ndarray


@dataclass(frozen=True)
class ProtectedWall:
    bottom: np.ndarray
    top: np.ndarray
    thickness: float


ProtectedVolume = Union[ProtectedBox, ProtectedWall]


def append_ground_labels(
    points: np.ndarray,
    ground_correction_mask: Optional[Dict[str, Any]],
    protected_annotations: Optional[Sequence[Dict[str, Any]]],
) -> Tuple[np.ndarray, str]:
    """Label ground the same way as pc-tool's calculateForceGround and ground shader.

    `protected_annotations` are the frame's 3D_BOX / IRREGULAR_WALL classAttributes;
    their points are never corrected to ground. Ego body points are never ground.
    """
    if points.dtype.names is None:
        raise ValueError('PCD points must be a structured array')
    if GROUND_FIELD in points.dtype.names:
        raise ValueError('PCD already contains a ground field')

    _require_xyz_fields(points)
    operations = _parse_ground_correction_mask(ground_correction_mask)
    ego_body = _ego_body_volume()
    volumes = [ego_body] + _parse_protected_annotations(protected_annotations)
    xyz = np.stack(
        [np.asarray(points[axis], dtype=np.float64) for axis in ('x', 'y', 'z')],
        axis=1,
    )
    automatic_ground = _automatic_ground_mask(points)
    forced_ground = _forced_ground_mask(xyz, operations) & ~_protected_mask(xyz, volumes)

    labeled = np.empty(
        points.shape,
        dtype=points.dtype.descr + [(GROUND_FIELD, np.uint8)],
    )
    for field_name in points.dtype.names:
        labeled[field_name] = points[field_name]
    ground = np.logical_or(automatic_ground, forced_ground) & ~_box_mask(xyz, ego_body)
    labeled[GROUND_FIELD] = ground.astype(np.uint8)

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
            raise ValueError('groundCorrectionMask polygon vertices are invalid: {}'.format(vertices))
        _validate_height_range(operation)
        return
    if operation_type == 'brush':
        samples = operation.get('samples')
        center = operation.get('center')
        if not _is_number(operation.get('radius')) or operation['radius'] <= 0:
            raise ValueError('groundCorrectionMask brush radius is invalid: {}'.format(operation.get('radius')))
        if not _is_point(center) and (
            not isinstance(samples, list) or not samples or not all(_is_point(sample) for sample in samples)
        ):
            raise ValueError('groundCorrectionMask brush center or samples are invalid')
        if operation.get('erase') is not None and not isinstance(operation['erase'], bool):
            raise ValueError('groundCorrectionMask brush erase must be a boolean: {}'.format(operation['erase']))
        _validate_height_range(operation)
        return
    if operation_type == 'cluster':
        cluster_points = operation.get('points')
        if not _is_number(operation.get('radius')) or operation['radius'] <= 0:
            raise ValueError('groundCorrectionMask cluster radius is invalid: {}'.format(operation.get('radius')))
        if not isinstance(cluster_points, list) or not cluster_points or not all(
            _is_point(point) and _is_number(point.get('z')) for point in cluster_points
        ):
            raise ValueError('groundCorrectionMask cluster points are invalid')
        return
    raise ValueError('groundCorrectionMask operation type is invalid: {}'.format(operation_type))


def _validate_height_range(operation: Dict[str, Any]) -> None:
    height_range = operation.get('heightRange')
    if height_range is not None and (
        not isinstance(height_range, dict)
        or not _is_number(height_range.get('min'))
        or not _is_number(height_range.get('max'))
        or height_range['min'] > height_range['max']
    ):
        raise ValueError(
            'groundCorrectionMask {} heightRange is invalid: {}'.format(operation['type'], height_range)
        )


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and np.isfinite(value)


def _is_point(value: Any) -> bool:
    return isinstance(value, dict) and _is_number(value.get('x')) and _is_number(value.get('y'))


def _vector3(value: Any, name: str) -> np.ndarray:
    if not isinstance(value, dict) or not all(_is_number(value.get(axis)) for axis in ('x', 'y', 'z')):
        raise ValueError('{} must be an object with finite x/y/z: {}'.format(name, value))
    return np.array([value['x'], value['y'], value['z']], dtype=np.float64)


def _parse_protected_annotations(
    protected_annotations: Optional[Sequence[Dict[str, Any]]],
) -> List[ProtectedVolume]:
    if protected_annotations is None:
        return []
    if not isinstance(protected_annotations, list):
        raise ValueError('groundCorrectionProtections must be a list')
    volumes: List[ProtectedVolume] = []
    for index, attributes in enumerate(protected_annotations):
        if not isinstance(attributes, dict) or attributes.get('type') not in PROTECTED_ANNOTATION_TYPES:
            raise ValueError(
                'groundCorrectionProtections[{}] must be a {} annotation: {}'.format(
                    index, '/'.join(PROTECTED_ANNOTATION_TYPES), attributes,
                )
            )
        contour = attributes.get('contour')
        if not isinstance(contour, dict):
            raise ValueError('groundCorrectionProtections[{}].contour must be an object'.format(index))
        if attributes['type'] == '3D_BOX':
            volumes.append(_protected_box(contour, index))
        else:
            wall = _protected_wall(contour, index)
            if wall is not None:
                volumes.append(wall)
    return volumes


def _protected_box(contour: Dict[str, Any], index: int) -> ProtectedBox:
    prefix = 'groundCorrectionProtections[{}].contour'.format(index)
    center = _vector3(contour.get('center3D'), prefix + '.center3D')
    size = _vector3(contour.get('size3D'), prefix + '.size3D')
    rotation = contour.get('rotation3D')
    angles = np.zeros(3) if rotation is None else _vector3(rotation, prefix + '.rotation3D')
    return ProtectedBox(center=center, half_size=np.abs(size) / 2, rotation=_euler_xyz_matrix(angles))


def _euler_xyz_matrix(angles: np.ndarray) -> np.ndarray:
    """Rotation matrix of a THREE.Euler with the default 'XYZ' order."""
    cos_x, cos_y, cos_z = np.cos(angles)
    sin_x, sin_y, sin_z = np.sin(angles)
    rotate_x = np.array([[1, 0, 0], [0, cos_x, -sin_x], [0, sin_x, cos_x]])
    rotate_y = np.array([[cos_y, 0, sin_y], [0, 1, 0], [-sin_y, 0, cos_y]])
    rotate_z = np.array([[cos_z, -sin_z, 0], [sin_z, cos_z, 0], [0, 0, 1]])
    return rotate_x @ rotate_y @ rotate_z


def _protected_wall(contour: Dict[str, Any], index: int) -> Optional[ProtectedWall]:
    prefix = 'groundCorrectionProtections[{}].contour'.format(index)
    bottom = _polyline(contour.get('bottomPoints'), prefix + '.bottomPoints')
    top = _polyline(contour.get('topPoints'), prefix + '.topPoints')
    # Like IrregularWall.getSurfaceSamples(), a wall without a top polyline has no surface.
    if len(bottom) < 2 or len(top) < 2:
        return None
    top = _oriented_top_points(bottom, top)
    parameters = np.unique(np.concatenate([_polyline_parameters(bottom), _polyline_parameters(top)]))
    keep = np.concatenate([[True], np.diff(parameters) > 1e-8])
    parameters = parameters[keep]
    return ProtectedWall(
        bottom=np.array([_interpolate(bottom, value) for value in parameters]),
        top=np.array([_interpolate(top, value) for value in parameters]),
        thickness=WALL_PROTECTION_THICKNESS,
    )


def _polyline(value: Any, name: str) -> np.ndarray:
    if value is None:
        return np.zeros((0, 3))
    if not isinstance(value, list):
        raise ValueError('{} must be a list: {}'.format(name, value))
    return np.array(
        [_vector3(point, '{}[{}]'.format(name, index)) for index, point in enumerate(value)],
        dtype=np.float64,
    ).reshape(-1, 3)


def _oriented_top_points(bottom: np.ndarray, top: np.ndarray) -> np.ndarray:
    direct = np.sum((bottom[0] - top[0]) ** 2) + np.sum((bottom[-1] - top[-1]) ** 2)
    reversed_distance = np.sum((bottom[0] - top[-1]) ** 2) + np.sum((bottom[-1] - top[0]) ** 2)
    return top[::-1] if reversed_distance < direct else top


def _polyline_parameters(points: np.ndarray) -> np.ndarray:
    lengths = np.concatenate([[0.0], np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))])
    return lengths / lengths[-1]


def _interpolate(points: np.ndarray, parameter: float) -> np.ndarray:
    parameters = _polyline_parameters(points)
    for index in range(1, len(parameters)):
        if parameter <= parameters[index] + 1e-8:
            span = parameters[index] - parameters[index - 1]
            ratio = 0.0 if span <= 1e-8 else (parameter - parameters[index - 1]) / span
            return points[index - 1] + (points[index] - points[index - 1]) * ratio
    return points[-1]


def _ego_body_volume() -> ProtectedBox:
    return ProtectedBox(
        center=(EGO_BODY_RANGE[:3] + EGO_BODY_RANGE[3:]) / 2,
        half_size=(EGO_BODY_RANGE[3:] - EGO_BODY_RANGE[:3]) / 2,
        rotation=np.eye(3),
    )


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


def _forced_ground_mask(xyz: np.ndarray, operations: Sequence[Dict[str, Any]]) -> np.ndarray:
    forced = np.zeros(len(xyz), dtype=bool)
    undecided = np.ones(len(xyz), dtype=bool)
    # Newest operation wins, so an eraser stroke only undoes corrections made before it.
    for operation in reversed(operations):
        candidates = np.flatnonzero(undecided)
        if candidates.size == 0:
            break
        matched = candidates[_operation_matches(xyz[candidates], operation)]
        undecided[matched] = False
        forced[matched] = not (operation['type'] == 'brush' and operation.get('erase') is True)
    return forced


def _operation_matches(xyz: np.ndarray, operation: Dict[str, Any]) -> np.ndarray:
    if operation['type'] == 'polygon':
        return _height_matches(xyz, operation) & _polygon_matches(xyz, operation['vertices'])
    if operation['type'] == 'brush':
        samples = operation.get('samples') or [operation['center']]
        sample_xy = np.array([[sample['x'], sample['y']] for sample in samples], dtype=np.float64)
        return _height_matches(xyz, operation) & _within_radius(xyz[:, :2], sample_xy, operation['radius'])
    cluster_xyz = np.array(
        [[point['x'], point['y'], point['z']] for point in operation['points']],
        dtype=np.float64,
    )
    return _within_radius(xyz, cluster_xyz, operation['radius'])


def _height_matches(xyz: np.ndarray, operation: Dict[str, Any]) -> np.ndarray:
    height_range = operation.get('heightRange')
    if height_range is None:
        return np.ones(len(xyz), dtype=bool)
    return (xyz[:, 2] >= height_range['min']) & (xyz[:, 2] <= height_range['max'])


def _within_radius(queries: np.ndarray, centers: np.ndarray, radius: float) -> np.ndarray:
    if len(queries) == 0:
        return np.zeros(0, dtype=bool)
    # Widen the search bound slightly; the exact inclusive test is done on the returned distance.
    distances, _ = cKDTree(centers).query(queries, k=1, distance_upper_bound=radius * (1 + 1e-9) + 1e-12)
    return distances <= radius


def _polygon_matches(xyz: np.ndarray, vertices: Sequence[Dict[str, Any]]) -> np.ndarray:
    x = xyz[:, 0]
    y = xyz[:, 1]
    inside = np.zeros(len(xyz), dtype=bool)
    on_edge = np.zeros(len(xyz), dtype=bool)
    previous = vertices[-1]
    for current in vertices:
        start_x, start_y = float(previous['x']), float(previous['y'])
        end_x, end_y = float(current['x']), float(current['y'])
        dx = end_x - start_x
        dy = end_y - start_y
        cross = (x - start_x) * dy - (y - start_y) * dx
        dot = (x - start_x) * dx + (y - start_y) * dy
        on_edge |= (np.abs(cross) <= np.finfo(float).eps) & (dot >= 0) & (dot <= dx * dx + dy * dy)
        crosses = (start_y > y) != (end_y > y)
        with np.errstate(divide='ignore', invalid='ignore'):
            intersection = dx * (y - start_y) / dy + start_x
        inside ^= crosses & (x < intersection)
        previous = current
    return inside | on_edge


def _protected_mask(xyz: np.ndarray, volumes: Sequence[ProtectedVolume]) -> np.ndarray:
    protected = np.zeros(len(xyz), dtype=bool)
    for volume in volumes:
        if isinstance(volume, ProtectedBox):
            protected |= _box_mask(xyz, volume)
        else:
            protected |= _wall_mask(xyz, volume)
    return protected


def _box_mask(xyz: np.ndarray, box: ProtectedBox) -> np.ndarray:
    local = (xyz - box.center) @ box.rotation
    return np.all(np.abs(local) <= box.half_size, axis=1)


def _wall_mask(xyz: np.ndarray, wall: ProtectedWall) -> np.ndarray:
    matched = np.zeros(len(xyz), dtype=bool)
    thickness_squared = wall.thickness * wall.thickness
    for index in range(len(wall.bottom) - 1):
        start_bottom, end_bottom = wall.bottom[index], wall.bottom[index + 1]
        start_top, end_top = wall.top[index], wall.top[index + 1]
        dx = end_bottom[0] - start_bottom[0]
        dy = end_bottom[1] - start_bottom[1]
        length_squared = dx * dx + dy * dy
        if length_squared <= 0:
            t = np.zeros(len(xyz))
        else:
            t = np.clip(
                ((xyz[:, 0] - start_bottom[0]) * dx + (xyz[:, 1] - start_bottom[1]) * dy) / length_squared,
                0,
                1,
            )
        offset_x = xyz[:, 0] - (start_bottom[0] + dx * t)
        offset_y = xyz[:, 1] - (start_bottom[1] + dy * t)
        bottom_z = start_bottom[2] + (end_bottom[2] - start_bottom[2]) * t
        top_z = start_top[2] + (end_top[2] - start_top[2]) * t
        matched |= (
            (offset_x * offset_x + offset_y * offset_y <= thickness_squared)
            & (xyz[:, 2] >= np.minimum(bottom_z, top_z))
            & (xyz[:, 2] <= np.maximum(bottom_z, top_z))
        )
    return matched
