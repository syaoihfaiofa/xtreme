from __future__ import annotations

import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import requests

DEFAULT_MAX_POINT_CLOUD_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_POINT_CLOUD_POINTS = 10_000_000
DOWNLOAD_CHUNK_BYTES = 1024 * 1024


class PointCloudLoadError(RuntimeError):
    pass


def _positive_env_int(name: str, default: int) -> int:
    raw_value = os.environ.get(name, str(default))
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise PointCloudLoadError(
            f"{name} must be a positive integer, got {raw_value!r}"
        ) from exc
    if value <= 0:
        raise PointCloudLoadError(
            f"{name} must be a positive integer, got {raw_value!r}"
        )
    return value


def load_point_cloud(url_or_path: str) -> np.ndarray:
    """Load Xtreme1 point cloud model input.

    The backend usually sends the converted `binary-*.pcd` relation URL for `.pcd` files.
    That binary file is read as float32 and reshaped to Nx4 when possible. Plain PCD files
    are supported for development and debugging.
    """

    if not url_or_path:
        raise PointCloudLoadError("pointCloudUrl is empty")

    parsed = urlparse(url_or_path)
    is_remote = parsed.scheme in {"http", "https"}
    path = fetch_to_local(url_or_path)
    try:
        max_bytes = _positive_env_int(
            "MAX_POINT_CLOUD_BYTES", DEFAULT_MAX_POINT_CLOUD_BYTES
        )
        file_size = path.stat().st_size
        if file_size > max_bytes:
            raise PointCloudLoadError(
                f"point cloud exceeds MAX_POINT_CLOUD_BYTES: "
                f"url={url_or_path!r}, bytes={file_size}, limit={max_bytes}"
            )

        suffix = path.suffix.lower()
        points = read_pcd(path) if suffix == ".pcd" else read_binary_float32(path)
        max_points = _positive_env_int(
            "MAX_POINT_CLOUD_POINTS", DEFAULT_MAX_POINT_CLOUD_POINTS
        )
        if points.shape[0] > max_points:
            raise PointCloudLoadError(
                f"point cloud exceeds MAX_POINT_CLOUD_POINTS: "
                f"url={url_or_path!r}, points={points.shape[0]}, limit={max_points}"
            )
        return points
    finally:
        if is_remote:
            path.unlink(missing_ok=True)


def fetch_to_local(url_or_path: str) -> Path:
    parsed = urlparse(url_or_path)
    if parsed.scheme in {"http", "https"}:
        max_bytes = _positive_env_int(
            "MAX_POINT_CLOUD_BYTES", DEFAULT_MAX_POINT_CLOUD_BYTES
        )
        suffix = Path(parsed.path).suffix or ".bin"
        temp_path: Path | None = None
        try:
            with requests.get(
                url_or_path,
                stream=True,
                timeout=float(
                    os.environ.get("POINT_CLOUD_DOWNLOAD_TIMEOUT", "30")
                ),
            ) as response:
                response.raise_for_status()
                content_length = response.headers.get("Content-Length")
                if content_length:
                    try:
                        declared_size = int(content_length)
                    except ValueError:
                        declared_size = None
                    if declared_size is not None and declared_size > max_bytes:
                        raise PointCloudLoadError(
                            f"point cloud download exceeds MAX_POINT_CLOUD_BYTES: "
                            f"url={url_or_path!r}, bytes={declared_size}, limit={max_bytes}"
                        )

                with tempfile.NamedTemporaryFile(
                    delete=False, suffix=suffix
                ) as temp_file:
                    temp_path = Path(temp_file.name)
                    downloaded = 0
                    for chunk in response.iter_content(
                        chunk_size=DOWNLOAD_CHUNK_BYTES
                    ):
                        if not chunk:
                            continue
                        downloaded += len(chunk)
                        if downloaded > max_bytes:
                            raise PointCloudLoadError(
                                f"point cloud download exceeds MAX_POINT_CLOUD_BYTES: "
                                f"url={url_or_path!r}, bytes>{max_bytes}, limit={max_bytes}"
                            )
                        temp_file.write(chunk)
            return temp_path
        except Exception:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)
            raise
    return Path(url_or_path)


def read_binary_float32(path: Path) -> np.ndarray:
    points = np.fromfile(path, dtype=np.float32)
    if points.size == 0:
        raise PointCloudLoadError(f"point cloud file is empty: {path}")
    for width in (4, 5, 3):
        if points.size % width == 0:
            reshaped = points.reshape((-1, width))
            if width == 3:
                intensity = np.zeros((reshaped.shape[0], 1), dtype=np.float32)
                return np.concatenate([reshaped, intensity], axis=1)
            return reshaped[:, :4]
    raise PointCloudLoadError(f"cannot infer binary point format for {path}, float count={points.size}")


def read_pcd(path: Path) -> np.ndarray:
    with path.open("rb") as f:
        header_lines: list[bytes] = []
        while True:
            line = f.readline()
            if not line:
                raise PointCloudLoadError(f"invalid pcd header: {path}")
            header_lines.append(line)
            if line.strip().lower().startswith(b"data"):
                break

        header = b"".join(header_lines).decode("utf-8", errors="ignore").lower()
        fields = parse_header_value(header, "fields")
        data_type = parse_header_value(header, "data")
        points_count = int((parse_header_value(header, "points") or "0").split()[0] or 0)

        if "binary" in data_type:
            # Xtreme1 pcd-tools converts the source PCD to a model-friendly binary relation;
            # this branch only handles simple float32 binary PCDs for local development.
            field_count = len(fields.split()) if fields else 4
            raw = np.frombuffer(f.read(), dtype=np.float32)
            if points_count and raw.size >= points_count * field_count:
                raw = raw[: points_count * field_count]
            points = raw.reshape((-1, field_count))
            return to_xyzi(points, fields)

        rows: list[list[float]] = []
        for line in f:
            text = line.decode("utf-8", errors="ignore").strip()
            if not text:
                continue
            rows.append([float(v) for v in text.split()])
        if not rows:
            raise PointCloudLoadError(f"pcd contains no points: {path}")
        return to_xyzi(np.asarray(rows, dtype=np.float32), fields)


def parse_header_value(header: str, key: str) -> str:
    for line in header.splitlines():
        if line.startswith(key):
            return line[len(key) :].strip()
    return ""


def to_xyzi(points: np.ndarray, fields: str) -> np.ndarray:
    names = fields.split()
    if not names:
        names = ["x", "y", "z", "intensity"][: points.shape[1]]

    def column(name: str, default: float = 0.0) -> np.ndarray:
        if name in names:
            return points[:, names.index(name)]
        return np.full((points.shape[0],), default, dtype=np.float32)

    return np.stack([column("x"), column("y"), column("z"), column("intensity")], axis=1).astype(np.float32)
