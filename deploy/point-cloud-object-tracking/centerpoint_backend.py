from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

from pointcloud_io import load_point_cloud


NUSCENES_CLASSES = [
    "car",
    "truck",
    "construction_vehicle",
    "bus",
    "trailer",
    "barrier",
    "motorcycle",
    "bicycle",
    "pedestrian",
    "traffic_cone",
]

DEFAULT_CONFIG_URL = (
    "https://raw.githubusercontent.com/open-mmlab/mmdetection3d/main/configs/centerpoint/"
    "centerpoint_voxel0075_second_secfpn_head-circlenms_8xb4-cyclic-20e_nus-3d.py"
)
DEFAULT_CHECKPOINT_URL = (
    "https://download.openmmlab.com/mmdetection3d/v1.0.0_models/centerpoint/"
    "centerpoint_0075voxel_second_secfpn_circlenms_4x8_cyclic_20e_nus/"
    "centerpoint_0075voxel_second_secfpn_circlenms_4x8_cyclic_20e_nus_20220810_011659-04cb3a3b.pth"
)


@dataclass
class CenterPointConfig:
    config: str
    checkpoint: str
    device: str
    score_threshold: float
    auto_download: bool
    config_url: str
    checkpoint_url: str
    mock_detections: str | None = None

    @classmethod
    def from_env(cls) -> "CenterPointConfig":
        return cls(
            config=os.environ.get(
                "CENTERPOINT_CONFIG",
                "/models/configs/centerpoint_voxel0075_second_secfpn_head-circlenms_8xb4-cyclic-20e_nus-3d.py",
            ),
            checkpoint=os.environ.get("CENTERPOINT_CHECKPOINT", "/models/centerpoint_nuscenes.pth"),
            device=os.environ.get("MODEL_DEVICE", "cuda:0"),
            score_threshold=float(os.environ.get("CENTERPOINT_SCORE_THRESHOLD", "0.25")),
            auto_download=os.environ.get("CENTERPOINT_AUTO_DOWNLOAD", "true").lower() == "true",
            config_url=os.environ.get("CENTERPOINT_CONFIG_URL", DEFAULT_CONFIG_URL),
            checkpoint_url=os.environ.get("CENTERPOINT_CHECKPOINT_URL", DEFAULT_CHECKPOINT_URL),
            mock_detections=os.environ.get("CENTERPOINT_MOCK_DETECTIONS"),
        )


class CenterPointBackend:
    name = "centerpoint"

    def __init__(self, config: CenterPointConfig):
        self.config = config
        self._model: Any | None = None

    def health(self) -> dict[str, Any]:
        ready = self.config.mock_detections is not None or (
            Path(self.config.config).exists() and Path(self.config.checkpoint).exists()
        )
        return {
            "status": "ok" if ready else "degraded",
            "backend": self.name,
            "deepLearning": True,
            "config": self.config.config,
            "checkpoint": self.config.checkpoint,
            "device": self.config.device,
            "ready": ready,
        }

    def predict(self, payload: dict[str, Any], seeds: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.config.mock_detections:
            return json.loads(self.config.mock_detections)

        target = payload.get("targetData") or {}
        point_cloud_url = target.get("pointCloudUrl")
        if not point_cloud_url:
            raise RuntimeError("targetData.pointCloudUrl is required for CenterPoint tracking")

        points = load_point_cloud(point_cloud_url)
        result = self._infer(points)
        return self._to_xtreme1_objects(result)

    def _infer(self, points):
        try:
            from mmdet3d.apis import inference_detector, init_model
        except ImportError as exc:
            raise ImportError(
                "MMDetection3D is not installed. Build the tracking image with MMLab dependencies "
                "or set TRACKING_BACKEND=heuristic for fallback mode."
            ) from exc

        if self._model is None:
            self._ensure_assets()
            if not Path(self.config.config).exists():
                raise FileNotFoundError(f"CenterPoint config not found: {self.config.config}")
            if not Path(self.config.checkpoint).exists():
                raise FileNotFoundError(f"CenterPoint checkpoint not found: {self.config.checkpoint}")
            self._model = init_model(self.config.config, self.config.checkpoint, device=self.config.device)

        # MMDetection3D versions differ on ndarray support; a temporary .bin path is the most
        # stable API surface for single point-cloud inference.
        with tempfile.NamedTemporaryFile(suffix=".bin") as tmp:
            points.astype("float32").tofile(tmp.name)
            return inference_detector(self._model, tmp.name)

    def _ensure_assets(self) -> None:
        if not self.config.auto_download:
            return
        download_if_missing(self.config.config, self.config.config_url)
        download_if_missing(self.config.checkpoint, self.config.checkpoint_url)

    def _to_xtreme1_objects(self, result: Any) -> list[dict[str, Any]]:
        pred = extract_pred_instances_3d(result)
        bboxes = to_numpy(pred.get("bboxes_3d"))
        scores = to_numpy(pred.get("scores_3d"))
        labels = to_numpy(pred.get("labels_3d"))
        if bboxes is None or scores is None or labels is None:
            return []

        tensor = getattr(bboxes, "tensor", bboxes)
        boxes = to_numpy(tensor)
        objects: list[dict[str, Any]] = []
        for box, score, label_idx in zip(boxes, scores, labels):
            score = float(score)
            if score < self.config.score_threshold:
                continue
            # Common LiDAR box order in MMDetection3D: x, y, z, dx, dy, dz, yaw.
            objects.append(
                {
                    "label": label_name(label_idx),
                    "confidence": score,
                    "x": float(box[0]),
                    "y": float(box[1]),
                    "z": float(box[2]),
                    "dimX": float(box[3]),
                    "dimY": float(box[4]),
                    "dimZ": float(box[5]),
                    "rotX": 0.0,
                    "rotY": 0.0,
                    "rotZ": float(box[6]) if len(box) > 6 else 0.0,
                }
            )
        return objects


def extract_pred_instances_3d(result: Any) -> dict[str, Any]:
    # MMDet3D v1 often returns (Det3DDataSample, data) or just Det3DDataSample.
    if isinstance(result, tuple):
        result = result[0]
    pred = getattr(result, "pred_instances_3d", None)
    if pred is None and isinstance(result, dict):
        pred = result.get("pred_instances_3d") or result
    if pred is None:
        return {}
    if isinstance(pred, dict):
        return pred
    return {
        "bboxes_3d": getattr(pred, "bboxes_3d", None),
        "scores_3d": getattr(pred, "scores_3d", None),
        "labels_3d": getattr(pred, "labels_3d", None),
    }


def to_numpy(value: Any):
    if value is None:
        return None
    if hasattr(value, "detach"):
        return value.detach().cpu().numpy()
    if hasattr(value, "cpu") and hasattr(value, "numpy"):
        return value.cpu().numpy()
    if hasattr(value, "numpy"):
        return value.numpy()
    return value


def label_name(label_idx: Any) -> str:
    idx = int(label_idx)
    if 0 <= idx < len(NUSCENES_CLASSES):
        return NUSCENES_CLASSES[idx]
    return str(idx)


def download_if_missing(path: str, url: str) -> None:
    target = Path(path)
    if target.exists() or not url:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=60) as response:
        response.raise_for_status()
        with target.open("wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
