from typing import Tuple

import torch
from torch import Tensor


MIN_DEPTH = 1e-5
MIN_RADIUS = 1e-8
MAX_THETA = torch.pi / 2 - 1e-5
NEWTON_TOLERANCE = 1e-6


def _expand_camera_values(values: Tensor, point_dimensions: int) -> Tensor:
    """Expand per-camera values across point dimensions."""
    spatial_dimensions = point_dimensions - 3
    shape = (
        *values.shape[:2],
        *((1, ) * spatial_dimensions),
        *values.shape[2:],
    )
    return values.reshape(shape)


def _normalized_image_coordinates(pixels: Tensor,
                                  intrinsics: Tensor) -> Tensor:
    point_dimensions = pixels.ndim
    fx = _expand_camera_values(intrinsics[..., 0, 0], point_dimensions)
    fy = _expand_camera_values(intrinsics[..., 1, 1], point_dimensions)
    cx = _expand_camera_values(intrinsics[..., 0, 2], point_dimensions)
    cy = _expand_camera_values(intrinsics[..., 1, 2], point_dimensions)
    x = (pixels[..., 0] - cx) / fx
    y = (pixels[..., 1] - cy) / fy
    return torch.stack((x, y), dim=-1)


def _distort_equidistant(theta: Tensor, distortion: Tensor) -> Tensor:
    point_dimensions = theta.ndim + 1
    coefficients = [
        _expand_camera_values(distortion[..., index], point_dimensions)
        for index in range(4)
    ]
    theta2 = theta.square()
    polynomial = (
        1 + coefficients[0] * theta2 +
        coefficients[1] * theta2.square() +
        coefficients[2] * theta2.pow(3) +
        coefficients[3] * theta2.pow(4))
    return theta * polynomial


def _invert_equidistant(
        distorted_theta: Tensor,
        distortion: Tensor,
        newton_iterations: int) -> Tuple[Tensor, Tensor]:
    if newton_iterations <= 0:
        raise ValueError(
            f'newton_iterations must be positive, got {newton_iterations}')

    point_dimensions = distorted_theta.ndim + 1
    coefficients = [
        _expand_camera_values(distortion[..., index], point_dimensions)
        for index in range(4)
    ]
    theta = distorted_theta.clamp(min=0.0, max=MAX_THETA)
    for _ in range(newton_iterations):
        theta2 = theta.square()
        theta4 = theta2.square()
        theta6 = theta4 * theta2
        theta8 = theta4.square()
        estimate = theta * (
            1 + coefficients[0] * theta2 + coefficients[1] * theta4 +
            coefficients[2] * theta6 + coefficients[3] * theta8)
        derivative = (
            1 + 3 * coefficients[0] * theta2 +
            5 * coefficients[1] * theta4 +
            7 * coefficients[2] * theta6 +
            9 * coefficients[3] * theta8)
        safe_derivative = torch.where(
            derivative.abs() > MIN_RADIUS, derivative,
            torch.full_like(derivative, MIN_RADIUS))
        theta = (theta - (estimate - distorted_theta) /
                 safe_derivative).clamp(min=0.0, max=MAX_THETA)

    residual = (_distort_equidistant(theta, distortion) -
                distorted_theta).abs()
    converged = torch.isfinite(theta) & (residual <= NEWTON_TOLERANCE)
    return theta, converged


def project_camera_points(
        camera_points: Tensor,
        intrinsics: Tensor,
        distortion: Tensor,
        fisheye_mask: Tensor,
        axis_signs: Tensor) -> Tuple[Tensor, Tensor, Tensor]:
    """Project camera-frame points using mixed pinhole/fisheye models."""
    if camera_points.shape[-1] != 3:
        raise ValueError(
            f'camera_points must end with 3 values, got '
            f'{tuple(camera_points.shape)}')

    expanded_axis_signs = _expand_camera_values(axis_signs,
                                                camera_points.ndim)
    optical_points = camera_points * expanded_axis_signs
    xy = optical_points[..., :2]
    depths = optical_points[..., 2]
    safe_depths = torch.where(
        depths.abs() > MIN_DEPTH, depths, torch.full_like(depths, MIN_DEPTH))
    expanded_intrinsics = _expand_camera_values(intrinsics,
                                                camera_points.ndim)
    pinhole_homogeneous = expanded_intrinsics.matmul(
        optical_points.unsqueeze(-1)).squeeze(-1)
    pinhole_pixels = (
        pinhole_homogeneous[..., :2] /
        pinhole_homogeneous[..., 2:3].clamp(min=MIN_DEPTH))

    radius = torch.linalg.vector_norm(xy, dim=-1)
    theta = torch.atan2(radius, depths)
    distorted_theta = _distort_equidistant(theta, distortion)
    fish_scale = torch.where(
        radius > MIN_RADIUS, distorted_theta / radius,
        torch.ones_like(radius))
    fisheye_xy = xy * fish_scale.unsqueeze(-1)

    expanded_fisheye_mask = _expand_camera_values(fisheye_mask,
                                                  camera_points.ndim)
    fx = _expand_camera_values(intrinsics[..., 0, 0], camera_points.ndim)
    fy = _expand_camera_values(intrinsics[..., 1, 1], camera_points.ndim)
    cx = _expand_camera_values(intrinsics[..., 0, 2], camera_points.ndim)
    cy = _expand_camera_values(intrinsics[..., 1, 2], camera_points.ndim)
    fisheye_pixels = torch.stack(
        (fx * fisheye_xy[..., 0] + cx,
         fy * fisheye_xy[..., 1] + cy),
        dim=-1)
    pixels = torch.where(
        expanded_fisheye_mask.unsqueeze(-1), fisheye_pixels,
        pinhole_pixels)
    valid = (
        torch.isfinite(pixels).all(dim=-1) & torch.isfinite(depths) &
        (depths > MIN_DEPTH))
    return pixels, depths, valid


def unproject_image_points(
        pixels: Tensor,
        depths: Tensor,
        intrinsics: Tensor,
        distortion: Tensor,
        fisheye_mask: Tensor,
        axis_signs: Tensor,
        newton_iterations: int) -> Tuple[Tensor, Tensor, Tensor]:
    """Unproject image pixels at optical z-depth into camera coordinates."""
    if pixels.shape[-1] != 2:
        raise ValueError(
            f'pixels must end with 2 values, got {tuple(pixels.shape)}')
    if pixels.shape[:-1] != depths.shape:
        raise ValueError(
            f'pixels/depths shape mismatch: {tuple(pixels.shape)} versus '
            f'{tuple(depths.shape)}')

    normalized_xy = _normalized_image_coordinates(pixels, intrinsics)
    distorted_theta = torch.linalg.vector_norm(normalized_xy, dim=-1)
    theta, fisheye_converged = _invert_equidistant(
        distorted_theta, distortion, newton_iterations)
    fish_scale = torch.where(
        distorted_theta > MIN_RADIUS,
        torch.tan(theta) / distorted_theta,
        torch.ones_like(distorted_theta))
    fisheye_xy = normalized_xy * fish_scale.unsqueeze(-1)

    expanded_fisheye_mask = _expand_camera_values(fisheye_mask, pixels.ndim)
    homogeneous_pixels = torch.cat(
        (pixels, torch.ones_like(depths).unsqueeze(-1)), dim=-1)
    expanded_inverse_intrinsics = _expand_camera_values(
        torch.inverse(intrinsics), pixels.ndim)
    pinhole_rays = expanded_inverse_intrinsics.matmul(
        homogeneous_pixels.unsqueeze(-1)).squeeze(-1)
    pinhole_rays = pinhole_rays / pinhole_rays[..., 2:3]
    fisheye_rays = torch.cat(
        (fisheye_xy, torch.ones_like(depths).unsqueeze(-1)), dim=-1)
    rays = torch.where(
        expanded_fisheye_mask.unsqueeze(-1), fisheye_rays, pinhole_rays)
    optical_points = rays * depths.unsqueeze(-1)
    expanded_axis_signs = _expand_camera_values(axis_signs,
                                                optical_points.ndim)
    camera_points = optical_points * expanded_axis_signs

    converged = torch.where(
        expanded_fisheye_mask, fisheye_converged,
        torch.ones_like(fisheye_converged))
    valid = (
        converged & torch.isfinite(camera_points).all(dim=-1) &
        (depths > MIN_DEPTH) &
        (~expanded_fisheye_mask | (theta < MAX_THETA)))
    return camera_points, valid, converged
