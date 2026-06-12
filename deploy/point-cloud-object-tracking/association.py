from __future__ import annotations

import math
from typing import Any


def associate_detections_to_seeds(
    detections: list[dict[str, Any]],
    seeds: list[dict[str, Any]],
    max_distance: float,
) -> list[dict[str, Any]]:
    """Match target-frame detections back to Xtreme1 seed tracks.

    CenterPoint returns detections for the target frame. Xtreme1 expects tracked objects that
    preserve the seed `trackingId`. We do a conservative one-to-one match by class and center
    distance, leaving unmatched detections out to avoid creating noisy new tracks.
    """

    used_detection_indexes: set[int] = set()
    tracked: list[dict[str, Any]] = []

    for seed in seeds:
        best_index: int | None = None
        best_distance = max_distance

        for index, detection in enumerate(detections):
            if index in used_detection_indexes:
                continue
            if not same_label(seed, detection):
                continue
            distance = center_distance(seed, detection)
            if distance <= best_distance:
                best_index = index
                best_distance = distance

        if best_index is None:
            continue

        used_detection_indexes.add(best_index)
        matched = dict(detections[best_index])
        matched["trackingId"] = seed.get("trackingId")
        if not matched.get("label"):
            matched["label"] = seed.get("label")
        tracked.append(matched)

    return tracked


def same_label(seed: dict[str, Any], detection: dict[str, Any]) -> bool:
    seed_label = normalize_label(seed.get("label"))
    detection_label = normalize_label(detection.get("label"))
    return not seed_label or not detection_label or seed_label == detection_label


def normalize_label(label: Any) -> str:
    return str(label or "").strip().lower()


def center_distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    ax, ay, az = float(a.get("x") or 0), float(a.get("y") or 0), float(a.get("z") or 0)
    bx, by, bz = float(b.get("x") or 0), float(b.get("y") or 0), float(b.get("z") or 0)
    return math.sqrt((ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2)
