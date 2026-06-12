from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Protocol

from association import associate_detections_to_seeds
from centerpoint_backend import CenterPointBackend, CenterPointConfig
from pointcloud_io import PointCloudLoadError

LOG = logging.getLogger(__name__)


class TrackingBackend(Protocol):
    name: str

    def health(self) -> dict[str, Any]:
        ...

    def predict(self, payload: dict[str, Any], seeds: list[dict[str, Any]]) -> list[dict[str, Any]]:
        ...


@dataclass
class HeuristicBackend:
    """Small deterministic fallback used when deep-learning dependencies are unavailable."""

    frame_offset: float = 0.5
    name: str = "heuristic"

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "backend": self.name, "deepLearning": False}

    def predict(self, payload: dict[str, Any], seeds: list[dict[str, Any]]) -> list[dict[str, Any]]:
        direction = payload.get("direction", "FORWARD")
        sign = 1 if direction == "FORWARD" else -1
        results: list[dict[str, Any]] = []
        for seed in seeds:
            x = float(seed.get("x") or 0)
            copied = dict(seed)
            copied["x"] = x + sign * self.frame_offset
            results.append(copied)
        return results


class TrackingService:
    def __init__(self, backend: TrackingBackend, fallback_backend: TrackingBackend | None = None):
        self.backend = backend
        self.fallback_backend = fallback_backend

    @classmethod
    def from_env(cls) -> "TrackingService":
        mode = os.environ.get("TRACKING_BACKEND", "auto").lower()
        fallback = HeuristicBackend(float(os.environ.get("TRACK_FRAME_OFFSET", "0.5")))
        if mode == "heuristic":
            return cls(fallback)

        config = CenterPointConfig.from_env()
        centerpoint = CenterPointBackend(config)
        if mode == "centerpoint":
            return cls(centerpoint)
        return cls(centerpoint, fallback_backend=fallback)

    def health(self) -> dict[str, Any]:
        status = self.backend.health()
        if self.fallback_backend:
            status["fallbackBackend"] = self.fallback_backend.name
        return status

    def track(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        seeds = [normalize_seed(obj) for obj in payload.get("objects", [])]
        if not seeds:
            return []

        try:
            detections = self.backend.predict(payload, seeds)
        except (ImportError, PointCloudLoadError, FileNotFoundError, RuntimeError) as exc:
            if not self.fallback_backend:
                raise
            LOG.warning("tracking backend %s unavailable, using fallback: %s", self.backend.name, exc)
            detections = self.fallback_backend.predict(payload, seeds)

        if self.backend.name == "centerpoint":
            return associate_detections_to_seeds(
                detections,
                seeds,
                max_distance=float(os.environ.get("TRACK_MATCH_MAX_DISTANCE", "4.0")),
            )

        return normalize_output_objects(detections)


def normalize_seed(obj: dict[str, Any]) -> dict[str, Any]:
    center = obj.get("center3D") or {}
    rotation = obj.get("rotation3D") or {}
    size = obj.get("size3D") or {}
    return normalize_output_object(
        {
            "trackingId": obj.get("trackingId"),
            "label": obj.get("label") or obj.get("modelClass"),
            "confidence": obj.get("confidence", 0.9),
            "x": center.get("x", obj.get("x", 0)),
            "y": center.get("y", obj.get("y", 0)),
            "z": center.get("z", obj.get("z", 0)),
            "dimX": size.get("x", obj.get("dimX", obj.get("dx", 1))),
            "dimY": size.get("y", obj.get("dimY", obj.get("dy", 1))),
            "dimZ": size.get("z", obj.get("dimZ", obj.get("dz", 1))),
            "rotX": rotation.get("x", obj.get("rotX", 0)),
            "rotY": rotation.get("y", obj.get("rotY", 0)),
            "rotZ": rotation.get("z", obj.get("rotZ", 0)),
        }
    )


def normalize_output_objects(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [normalize_output_object(obj) for obj in objects]


def normalize_output_object(obj: dict[str, Any]) -> dict[str, Any]:
    return {
        "trackingId": obj.get("trackingId") or obj.get("trackId"),
        "label": obj.get("label") or obj.get("modelClass"),
        "confidence": as_float(obj.get("confidence", 0.9)),
        "x": as_float(obj.get("x", 0)),
        "y": as_float(obj.get("y", 0)),
        "z": as_float(obj.get("z", 0)),
        "dimX": as_float(obj.get("dimX", obj.get("dx", 1))),
        "dimY": as_float(obj.get("dimY", obj.get("dy", 1))),
        "dimZ": as_float(obj.get("dimZ", obj.get("dz", 1))),
        "rotX": as_float(obj.get("rotX", 0)),
        "rotY": as_float(obj.get("rotY", 0)),
        "rotZ": as_float(obj.get("rotZ", obj.get("yaw", 0))),
    }


def as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)
