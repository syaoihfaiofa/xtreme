"""Self-contained CenterNet parking-slot inference service for Xtreme."""
import json
import os
import struct
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple

import cv2
import numpy as np
import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "centernet" / "lib"))

from detectors.multi_pose import MultiPoseDetector  # noqa: E402
from opts import opts  # noqa: E402


LABELS = tuple((ROOT / "config" / "labels.txt").read_text().split())
# Partial parked slots have the same annotation semantics in Xtreme. Keep the
# model's fifth output channel for inference compatibility, but merge it into
# the editable parked-slot category returned to the backend/UI.
OUTPUT_LABEL_MAP = {
    "parkinglot_parked_partial": "parkinglot_parked",
}


def _load_projection() -> Mapping[str, float]:
    path = Path(os.environ.get("PARKING_PROJECTION_PATH", ROOT / "config" / "projection.json"))
    return json.loads(path.read_text())


def _load_image(url: str) -> np.ndarray:
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    image = cv2.imdecode(np.frombuffer(response.content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("stitched image cannot be decoded")
    return image


def _load_pcd(url: str) -> np.ndarray:
    if not url:
        return np.empty((0, 3), dtype=np.float64)
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    text = response.content.decode("utf-8", errors="replace")
    marker = "\nDATA ascii\n"
    if marker not in text:
        return np.empty((0, 7), dtype=np.float64)
    header, body = text.split(marker, 1)
    fields_line = next((line for line in header.splitlines() if line.upper().startswith("FIELDS ")), "")
    fields = fields_line.split()[1:]
    field_index = {field.lower(): index for index, field in enumerate(fields)}

    def value(values: List[str], *names: str) -> float:
        for name in names:
            index = field_index.get(name)
            if index is not None and index < len(values):
                return float(values[index])
        return float("nan")

    def packed_rgb(raw: float) -> Tuple[float, float, float]:
        # PCD stores a packed rgb field either as its uint32 value or as the
        # bitwise-equivalent float. Support both common ASCII encodings.
        packed = int(raw) if abs(raw) >= 1 else struct.unpack("I", struct.pack("f", float(raw)))[0]
        return float((packed >> 16) & 255), float((packed >> 8) & 255), float(packed & 255)

    rows: List[Tuple[float, float, float, float, float, float, float]] = []
    for line in body.splitlines():
        values = line.split()
        if len(values) < 3:
            continue
        try:
            x, y, z = value(values, "x"), value(values, "y"), value(values, "z")
            intensity = value(values, "int", "intensity", "i")
            red, green, blue = value(values, "r", "red"), value(values, "g", "green"), value(values, "b", "blue")
            if not np.isfinite([red, green, blue]).all():
                packed = value(values, "rgb", "rgba")
                if np.isfinite(packed):
                    red, green, blue = packed_rgb(packed)
            rows.append((x, y, z, intensity, red, green, blue))
        except ValueError:
            continue
    return np.asarray(rows, dtype=np.float64) if rows else np.empty((0, 7), dtype=np.float64)


def _project_detector_quad(points: Sequence[Tuple[float, float]], projection: Mapping[str, float]) -> List[Tuple[float, float]]:
    """Project the model's ordered corners without losing the entrance edge.

    Parking-slot training annotations carry more information than an arbitrary
    quadrilateral: the first/last edge is the slot entrance.  Sorting corners
    by their angle discards that information and makes a valid footprint whose
    direction arrow is unrelated to the actual parking direction.  The pixel
    to vehicle-plane transform is a reflection, so reverse the whole sequence
    after projecting to retain the clockwise P0..P3 convention expected by
    ``GroundPolygon`` (P3 -> P0 is its entrance edge).
    """
    if len(points) != 4:
        raise ValueError("parking detection must have exactly four keypoints")
    array = np.asarray(points, dtype=np.float64)
    if not np.isfinite(array).all():
        raise ValueError("parking detection has non-finite keypoints")
    area = np.dot(array[:, 0], np.roll(array[:, 1], -1)) - np.dot(array[:, 1], np.roll(array[:, 0], -1))
    if abs(area) < 1e-6:
        raise ValueError("parking detection has degenerate keypoints")
    projected = [
        ((projection["car_origin_y"] - v) / projection["pixels_per_meter"],
         (projection["car_origin_x"] - u) / projection["pixels_per_meter"])
        for u, v in array
    ]
    return [(float(x), float(y)) for x, y in reversed(projected)]


def _fit_ground(
    points: np.ndarray,
    quad: Sequence[Tuple[float, float]],
    fallback: float,
    max_slope: float = 0.12,
) -> List[float]:
    if points.size == 0:
        return [fallback] * 4
    xy = np.asarray(quad, dtype=np.float64)
    margin = 0.4
    mask = (
        (points[:, 0] >= xy[:, 0].min() - margin) & (points[:, 0] <= xy[:, 0].max() + margin)
        & (points[:, 1] >= xy[:, 1].min() - margin) & (points[:, 1] <= xy[:, 1].max() + margin)
    )
    candidates = points[mask]
    # Dataset convention: points whose grayscale RGB exactly repeats intensity
    # are not ground. The remaining colour-coded points are the supplied ground
    # cloud and are the only points allowed to determine parking-slot height.
    if candidates.shape[1] >= 7:
        intensity = candidates[:, 3]
        rgb = candidates[:, 4:7]
        has_ground_mark = np.isfinite(intensity) & np.isfinite(rgb).all(axis=1)
        marked_ground = has_ground_mark & np.any(np.abs(rgb - intensity[:, None]) > 1e-6, axis=1)
        if marked_ground.any():
            candidates = candidates[marked_ground]
    if len(candidates) < 12:
        return [fallback] * 4
    # Retain the lower ground band before a robust planar least-squares fit.
    cutoff = np.quantile(candidates[:, 2], 0.45)
    ground = candidates[candidates[:, 2] <= cutoff]
    if len(ground) < 6:
        return [float(np.median(candidates[:, 2]))] * 4
    design = np.column_stack((ground[:, 0], ground[:, 1], np.ones(len(ground))))
    coef, *_ = np.linalg.lstsq(design, ground[:, 2], rcond=None)
    residuals = np.abs(design @ coef - ground[:, 2])
    inliers = ground[residuals <= max(0.08, np.quantile(residuals, 0.8))]
    if len(inliers) >= 6:
        design = np.column_stack((inliers[:, 0], inliers[:, 1], np.ones(len(inliers))))
        coef, *_ = np.linalg.lstsq(design, inliers[:, 2], rcond=None)
    # A local parking surface can have a gentle ramp, but a steep fitted plane
    # is almost always a vehicle/wall/curb contaminating the selected points.
    # Do not let those outliers tilt the projected parking footprint in 3D.
    if float(np.hypot(coef[0], coef[1])) > max_slope:
        return [float(np.median(ground[:, 2]))] * 4
    return [float(coef[0] * x + coef[1] * y + coef[2]) for x, y in quad]


class ParkingService:
    def __init__(self) -> None:
        self.projection = _load_projection()
        self.score_threshold = float(os.environ.get("PARKING_SCORE_THRESHOLD", "0.3"))
        if not 0.0 <= self.score_threshold <= 1.0:
            raise ValueError("PARKING_SCORE_THRESHOLD must be within [0, 1]")
        args = [
            "my_multi_pose", "--gpus", "0", "--load_model", os.environ.get("PARKING_MODEL_PATH", str(ROOT / "models" / "model_last.pth")),
            "--labels_file", str(ROOT / "config" / "labels.txt"), "--arch", "regnet_8", "--input_res", "512",
            "--deconv_type", "0", "--not_reg_offset", "--not_hm_hp", "--not_reg_bbox", "--not_reg_hp_offset", "--eccentric",
        ]
        self.detector = MultiPoseDetector(opts().init(args))

    def health(self) -> Dict[str, Any]:
        return {"status": "ok", "labels": list(LABELS), "scoreThreshold": self.score_threshold}

    def recognize(self, frame: Mapping[str, Any]) -> Dict[str, Any]:
        frame_id = frame.get("id")
        try:
            image_url = frame.get("stitchedImageUrl")
            if not isinstance(image_url, str) or not image_url:
                raise ValueError("stitchedImageUrl is required")
            image = _load_image(image_url)
            expected = (int(self.projection["image_height"]), int(self.projection["image_width"]))
            if image.shape[:2] != expected:
                raise ValueError("stitched image must be {}x{}; got {}x{}".format(expected[1], expected[0], image.shape[1], image.shape[0]))
            ground_points = _load_pcd(str(frame.get("pointCloudUrl") or ""))
            results = self.detector.run(image)["results"]
            objects: List[Dict[str, Any]] = []
            for class_id, detections in results.get("", {}).items():
                if class_id < 1 or class_id > len(LABELS):
                    continue
                for detection in detections:
                    score = float(detection[4])
                    if score < self.score_threshold:
                        continue
                    pixels = [(float(detection[5 + index * 2]), float(detection[6 + index * 2])) for index in range(4)]
                    try:
                        vehicle_quad = _project_detector_quad(pixels, self.projection)
                    except ValueError:
                        continue
                    zs = _fit_ground(
                        ground_points,
                        vehicle_quad,
                        float(self.projection["fallback_ground_z"]),
                        float(self.projection.get("max_ground_slope", 0.12)),
                    )
                    objects.append({
                        "objType": "GROUND_POLYGON",
                        "modelClass": OUTPUT_LABEL_MAP.get(LABELS[class_id - 1], LABELS[class_id - 1]),
                        "confidence": score,
                        "points": [{"x": x, "y": y, "z": z} for (x, y), z in zip(vehicle_quad, zs)],
                        "sourceViewIndexes": [0], "sourceKeypoints": [[value for point in pixels for value in point]],
                    })
            return {"id": frame_id, "code": "OK", "message": "", "objects": objects, "rejections": []}
        except Exception as error:  # individual bad frames must not fail a batch run
            return {"id": frame_id, "code": "ERROR", "message": str(error), "objects": [], "rejections": []}


app = FastAPI(title="Xtreme parking slot detection")
_service: ParkingService | None = None


def service() -> ParkingService:
    global _service
    if _service is None:
        _service = ParkingService()
    return _service


@app.get("/health")
def health() -> Dict[str, Any]:
    return service().health()


@app.post("/parking-slot/recognition")
async def recognition(request: Request) -> JSONResponse:
    try:
        body = await request.json()
        frames = body.get("datas") if isinstance(body, Mapping) else None
        if not isinstance(frames, list) or not frames:
            raise ValueError("datas must be a non-empty array")
        return JSONResponse({"code": "OK", "message": "", "data": [service().recognize(frame) for frame in frames]})
    except ValueError as error:
        return JSONResponse(status_code=400, content={"code": "ERROR", "message": str(error), "data": []})
