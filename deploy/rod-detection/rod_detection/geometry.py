import math
from typing import List, Mapping, Sequence, Tuple

import numpy as np

from rod_detection.schemas import (
    Box3D,
    CameraCalibration,
    KeypointDetection,
    PinholeCalibration,
    Vector3,
)


Point2D = Tuple[float, float]


class GeometryError(ValueError):
    pass


def camera_ray_from_pixel(pixel: Point2D, calibration: CameraCalibration) -> np.ndarray:
    if len(pixel) != 2 or not np.isfinite(pixel).all():
        raise GeometryError("Pixel must contain two finite coordinates: {!r}".format(pixel))
    intrinsics = calibration.intrinsics
    distorted_x = (float(pixel[0]) - intrinsics.cx) / intrinsics.fx
    distorted_y = (float(pixel[1]) - intrinsics.cy) / intrinsics.fy
    if isinstance(calibration, PinholeCalibration):
        return np.asarray((distorted_x, distorted_y, 1.0), dtype=np.float64)

    radius_distorted = math.hypot(distorted_x, distorted_y)
    if radius_distorted <= 1e-15:
        return np.asarray((0.0, 0.0, 1.0), dtype=np.float64)
    coefficients = calibration.distortion_vector
    theta = radius_distorted
    converged = False
    for _ in range(12):
        theta2 = theta * theta
        polynomial = (
            1.0
            + coefficients[0] * theta2
            + coefficients[1] * theta2**2
            + coefficients[2] * theta2**3
            + coefficients[3] * theta2**4
        )
        derivative = (
            1.0
            + 3.0 * coefficients[0] * theta2
            + 5.0 * coefficients[1] * theta2**2
            + 7.0 * coefficients[2] * theta2**3
            + 9.0 * coefficients[3] * theta2**4
        )
        if abs(float(derivative)) <= 1e-12:
            raise GeometryError("Fisheye undistortion derivative is degenerate")
        update = (theta * polynomial - radius_distorted) / derivative
        theta -= float(update)
        if abs(float(update)) <= 1e-12:
            converged = True
            break
    theta2 = theta * theta
    residual = theta * (
        1.0
        + coefficients[0] * theta2
        + coefficients[1] * theta2**2
        + coefficients[2] * theta2**3
        + coefficients[3] * theta2**4
    ) - radius_distorted
    if not converged or abs(float(residual)) > 1e-10 * max(1.0, radius_distorted):
        raise GeometryError("Fisheye undistortion did not converge")
    if not math.isfinite(theta) or theta < 0.0 or theta >= math.pi / 2.0:
        raise GeometryError("Fisheye pixel cannot be mapped to a forward camera ray")
    scale = math.tan(theta) / radius_distorted
    return np.asarray((distorted_x * scale, distorted_y * scale, 1.0), dtype=np.float64)


def intersect_ray_with_ground(
    origin: np.ndarray, direction: np.ndarray, ground_z: float
) -> np.ndarray:
    if origin.shape != (3,) or direction.shape != (3,):
        raise GeometryError("Ray origin and direction must be three-dimensional")
    if not np.isfinite(origin).all() or not np.isfinite(direction).all():
        raise GeometryError("Ray origin and direction must be finite")
    if abs(float(direction[2])) <= 1e-12:
        raise GeometryError("Ray is parallel to the z=0 ground plane")
    if not math.isfinite(ground_z):
        raise GeometryError("Ground z must be finite: {!r}".format(ground_z))
    distance = (ground_z - float(origin[2])) / float(direction[2])
    if distance <= 0.0:
        raise GeometryError("Ground intersection is behind the camera")
    point = origin + distance * direction
    point[2] = ground_z
    if not np.isfinite(point).all():
        raise GeometryError("Ground intersection is non-finite")
    return point


def intersect_pixel_with_ground(
    pixel: Point2D, calibration: CameraCalibration, ground_z: float
) -> np.ndarray:
    camera_to_lidar = np.linalg.inv(calibration.camera_external)
    origin = camera_to_lidar[:3, 3].copy()
    camera_ray = camera_ray_from_pixel(pixel, calibration)
    direction = camera_to_lidar[:3, :3].dot(camera_ray)
    return intersect_ray_with_ground(origin, direction, ground_z)


def _signed_area(points: Sequence[np.ndarray]) -> float:
    return 0.5 * sum(
        float(point[0] * points[(index + 1) % len(points)][1])
        - float(points[(index + 1) % len(points)][0] * point[1])
        for index, point in enumerate(points)
    )


def order_quad_points(points: Sequence[np.ndarray]) -> List[np.ndarray]:
    if len(points) != 4:
        raise GeometryError("A quadrilateral must contain exactly four points")
    coordinates = np.asarray([point[:2] for point in points], dtype=np.float64)
    if not np.isfinite(coordinates).all():
        raise GeometryError("Quadrilateral contains non-finite points")
    if len({(float(point[0]), float(point[1])) for point in coordinates}) != 4:
        raise GeometryError("Quadrilateral contains duplicate points")

    center = coordinates.mean(axis=0)
    order = sorted(
        range(4),
        key=lambda index: math.atan2(
            float(coordinates[index, 1] - center[1]),
            float(coordinates[index, 0] - center[0]),
        ),
    )
    ordered = [points[index].copy() for index in order]
    if abs(_signed_area(ordered)) <= 1e-8:
        raise GeometryError("Quadrilateral area is degenerate")
    cross_products = []
    for index in range(4):
        first = ordered[(index + 1) % 4][:2] - ordered[index][:2]
        second = ordered[(index + 2) % 4][:2] - ordered[(index + 1) % 4][:2]
        cross_products.append(float(first[0] * second[1] - first[1] * second[0]))
    if min(cross_products) <= 1e-8:
        raise GeometryError("Quadrilateral must be strictly convex")

    start = min(
        range(4), key=lambda index: (float(ordered[index][0]), float(ordered[index][1]))
    )
    return ordered[start:] + ordered[:start]


MIN_RECTANGLE_SIDE = 0.05


def fit_rectangle(
    ccw_points: np.ndarray,
) -> Tuple[np.ndarray, float, float, float]:
    """Rectangle from the two midlines of a quad, as in tips_perception
    NormalizePolyToRectSimple.

    Length/width are the midline lengths between opposite edge midpoints, yaw
    follows the longer midline, and the center is the point mean. Sides shorter
    than MIN_RECTANGLE_SIDE are clamped to it. Returns (center_xy, length, width,
    yaw) with length >= width.
    """
    if ccw_points.shape != (4, 2):
        raise GeometryError(
            "Rectangle fit requires four XY points, got shape {}".format(ccw_points.shape)
        )
    first_midline = (ccw_points[1] + ccw_points[2]) / 2.0 - (
        ccw_points[0] + ccw_points[3]
    ) / 2.0
    second_midline = (ccw_points[0] + ccw_points[1]) / 2.0 - (
        ccw_points[2] + ccw_points[3]
    ) / 2.0
    first_length = float(np.linalg.norm(first_midline))
    second_length = float(np.linalg.norm(second_midline))
    if max(first_length, second_length) <= 1e-8:
        raise GeometryError("Quadrilateral edges are degenerate")
    if first_length >= second_length:
        length, width, axis = first_length, second_length, first_midline / first_length
    else:
        length, width, axis = second_length, first_length, second_midline / second_length
    length = max(length, MIN_RECTANGLE_SIDE)
    width = max(width, MIN_RECTANGLE_SIDE)
    center = ccw_points.mean(axis=0)
    # A rectangle is symmetric under a half turn; keep yaw in (-pi/2, pi/2].
    if axis[0] < 0.0 or (axis[0] == 0.0 and axis[1] < 0.0):
        axis = -axis
    return center, length, width, math.atan2(float(axis[1]), float(axis[0]))


def lift_quad(
    detection: KeypointDetection,
    calibration: CameraCalibration,
    height: float,
    ground_z: float,
) -> Box3D:
    if not math.isfinite(height) or height <= 0.0:
        raise GeometryError("Box height must be finite and positive: {!r}".format(height))
    if not math.isfinite(detection.confidence):
        raise GeometryError("Detection confidence must be finite")
    keypoints = detection.keypoints
    if len(keypoints) != 8 or not np.isfinite(keypoints).all():
        raise GeometryError("Detection keypoints must contain eight finite values")

    ground_points = [
        intersect_pixel_with_ground(
            (keypoints[index], keypoints[index + 1]), calibration, ground_z
        )
        for index in range(0, 8, 2)
    ]
    ordered = order_quad_points(ground_points)
    center, length, width, yaw = fit_rectangle(
        np.asarray([point[:2] for point in ordered], dtype=np.float64)
    )

    return Box3D(
        objType="3D_BOX",
        modelClass=detection.model_class,
        confidence=detection.confidence,
        center3D=Vector3(
            float(center[0]), float(center[1]), ground_z + height / 2.0
        ),
        size3D=Vector3(length, width, height),
        rotation3D=Vector3(0.0, 0.0, yaw),
        source_view_indexes=(detection.view_index,),
        source_keypoints=(detection.keypoints,),
    )


def lift_detection(
    detection: KeypointDetection,
    calibration: CameraCalibration,
    height_defaults: Mapping[str, float],
    ground_z: float,
) -> Box3D:
    if detection.model_class not in height_defaults:
        raise GeometryError(
            "No height default configured for class {!r}".format(
                detection.model_class
            )
        )
    return lift_quad(
        detection,
        calibration,
        height=float(height_defaults[detection.model_class]),
        ground_z=ground_z,
    )
