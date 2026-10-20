"""Immutable visibility sidecar builders."""

from typing import Any, Dict


def build_frame_sidecar(
    scene_id: str,
    frame_token: str,
    source_hash: str,
    algorithm_version: str,
    boxes: Dict[str, Dict[str, Any]],
    polylines: Dict[str, Dict[str, Any]],
    occ: Dict[str, Any],
) -> Dict[str, Any]:
    """Build the independent result payload for one Xtreme frame."""
    if not scene_id:
        raise ValueError("scene_id must not be empty")
    if not frame_token:
        raise ValueError("frame_token must not be empty")
    if not source_hash:
        raise ValueError("source_hash must not be empty")
    if not algorithm_version:
        raise ValueError("algorithm_version must not be empty")

    return {
        "schemaVersion": "xtreme-visibility/v1",
        "sceneId": scene_id,
        "frameToken": frame_token,
        "source": {"hash": source_hash},
        "algorithm": {"version": algorithm_version},
        "objects": boxes,
        "polylines": polylines,
        "occ": occ,
    }
