from typing import List, Sequence, Union

Matrix4 = List[List[float]]
CameraExternal = Union[Sequence[float], Sequence[Sequence[float]]]


def build_lidar_to_camera(camera_external: CameraExternal) -> Matrix4:
    """Validate the Xtreme LiDAR-to-camera extrinsic matrix."""
    if len(camera_external) == 4 and all(
        isinstance(row, Sequence) and len(row) == 4 for row in camera_external
    ):
        return [[float(value) for value in row] for row in camera_external]  # type: ignore[arg-type]

    if len(camera_external) != 16:
        raise ValueError(
            f"cameraExternal must contain 16 values or be a 4x4 matrix, got {len(camera_external)} values"
        )

    values = [float(value) for value in camera_external]  # type: ignore[arg-type]
    return [values[index:index + 4] for index in range(0, 16, 4)]
