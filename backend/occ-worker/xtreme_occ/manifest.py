"""Immutable worker input manifest builders."""

from typing import Any, Dict, List


def build_run_manifest(
    run_id: int,
    dataset_id: int,
    scene_id: int,
    source_hash: str,
    algorithm_version: str,
    frames: List[Dict[str, Any]],
    selected_data_ids: List[int],
    camera_config_object_key: str,
    output_prefix: str,
) -> Dict[str, Any]:
    """Build the persisted input contract for one scene visibility run."""
    if run_id <= 0 or dataset_id <= 0 or scene_id <= 0:
        raise ValueError("run_id, dataset_id, and scene_id must be positive")
    if len(source_hash) != 64:
        raise ValueError("source_hash must be a SHA-256 hexadecimal digest")
    if not algorithm_version:
        raise ValueError("algorithm_version must not be empty")
    if not frames:
        raise ValueError("frames must not be empty")
    if not selected_data_ids or any(
        not isinstance(data_id, int) or data_id <= 0 for data_id in selected_data_ids
    ):
        raise ValueError("selected_data_ids must contain positive integers")
    if not camera_config_object_key:
        raise ValueError("camera_config_object_key must not be empty")
    if not output_prefix:
        raise ValueError("output_prefix must not be empty")

    return {
        "schemaVersion": "xtreme-occ-run/v1",
        "runId": run_id,
        "datasetId": dataset_id,
        "sceneId": scene_id,
        "source": {"hash": source_hash},
        "algorithm": {"version": algorithm_version},
        "frames": frames,
        "selectedDataIds": selected_data_ids,
        "cameraConfigObjectKey": camera_config_object_key,
        "outputPrefix": output_prefix,
    }
