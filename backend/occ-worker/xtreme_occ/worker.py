"""Independent HTTP entry point for OCC manifest runs."""

from __future__ import annotations

import io
import json
import os
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from hmac import compare_digest
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Mapping, MutableMapping, Protocol, Sequence, Tuple

import numpy as np
from flask import Flask, jsonify, request
from minio import Minio
from minio.error import S3Error

from xtreme_occ.camera_projection import camera_fov_mask, load_surround_cameras
from xtreme_occ.fusion import (
    Box3D,
    drop_ego_body_points,
    EgoPose,
    PreparedFusionFrame,
    fuse_prepared_frame_points,
    prepare_fusion_frames,
)
from xtreme_occ.object_visibility import (
    box_visible_ratio,
    polyline_segment_visibility,
)
from xtreme_occ.pcd import read_pcd_xyz
from xtreme_occ.semantics import (
    OccLabels,
    generate_occ_labels,
    overlay_box_semantics,
)
from xtreme_occ.sidecar import build_frame_sidecar
from xtreme_occ.visualization import (
    DEFAULT_MAX_VOXELS,
    build_occ_visualization,
)
from xtreme_occ.visibility import (
    RaycastVisibilityProfile,
    raycast_visibility_profiled,
)


SCHEMA_VERSION = "xtreme-occ-run/v1"
WORKER_SECRET_HEADER = "X-Xtreme-Occ-Worker-Secret"
WORKER_PROGRESS_SECRET_HEADER = "X-Xtreme-Occ-Progress-Secret"
DEFAULT_PC_RANGE = (-15.0, -15.0, -0.7, 15.0, 15.0, 1.3)
DEFAULT_VOXEL_SIZE = 0.1
DEFAULT_SEGMENT_LENGTH = 0.2
DEFAULT_HALF_WIDTH = 0.15
DEFAULT_SLAB_HEIGHT = 0.3
DEFAULT_SLAB_VISIBLE_RATIO = 0.1
DEFAULT_SEGMENT_VISIBLE_RATIO = 0.8
OCC_FRAME_WORKERS = 2
MIN_POLYLINE_HEIGHT = 0.1
DEFAULT_WINDOW = 5
SUBJECT_QUERY_MARGIN = 0.05
POINT_AABB_GRID_CELL_SIZE = 1.0
DEFAULT_DYNAMIC_CLASS_IDS = frozenset(
    {"car", "person", "truck", "bus", "bike", "handcart"}
)


class ObjectStore(Protocol):
    def get_bytes(self, object_key: str) -> bytes:
        ...

    def put_bytes(
        self, object_key: str, content: bytes, immutable: bool = False
    ) -> None:
        ...


class PointCloudCache:
    """Share one PCD download and parse operation across frame workers."""

    def __init__(self) -> None:
        self._values: Dict[str, np.ndarray] = {}
        self._in_flight: Dict[str, Future[np.ndarray]] = {}
        self._lock = Lock()

    def get(self, object_store: ObjectStore, object_key: str) -> np.ndarray:
        with self._lock:
            cached = self._values.get(object_key)
            if cached is not None:
                return cached
            future = self._in_flight.get(object_key)
            if future is None:
                future = Future()
                self._in_flight[object_key] = future
                should_load = True
            else:
                should_load = False
        if not should_load:
            return future.result()
        try:
            points = _read_pcd_bytes(object_store.get_bytes(object_key))
        except Exception as error:
            with self._lock:
                del self._in_flight[object_key]
                future.set_exception(error)
            raise
        with self._lock:
            self._values[object_key] = points
            del self._in_flight[object_key]
            future.set_result(points)
        return points


class MinioObjectStore:
    def __init__(self, client: Minio, bucket: str) -> None:
        if not bucket:
            raise ValueError("bucket must not be empty")
        self._client = client
        self._bucket = bucket

    def get_bytes(self, object_key: str) -> bytes:
        response = self._client.get_object(self._bucket, object_key)
        try:
            return response.read()
        finally:
            response.close()
            response.release_conn()

    def put_bytes(
        self, object_key: str, content: bytes, immutable: bool = False
    ) -> None:
        if immutable:
            try:
                self._client.stat_object(self._bucket, object_key)
            except S3Error as error:
                if error.code not in {"NoSuchKey", "NoSuchObject", "NotFound"}:
                    raise
            else:
                raise FileExistsError(
                    f"immutable object already exists: {object_key}"
                )
        self._client.put_object(
            self._bucket,
            object_key,
            io.BytesIO(content),
            len(content),
            content_type="application/octet-stream",
        )


def run_manifest(
    manifest: Mapping[str, Any], object_store: ObjectStore
) -> Dict[str, Any]:
    _validate_manifest(manifest)
    task_type = _manifest_task_type(manifest)
    if task_type == "VISIBILITY":
        return _run_visibility_manifest(manifest, object_store)
    if task_type == "OCC" and _should_parallelize_occ(manifest):
        return _run_parallel_occ_manifest(manifest, object_store)
    _report_progress(manifest, "PREPARING", 0)
    algorithm = _required_mapping(manifest, "algorithm")
    pc_range = algorithm.get("pcRange", DEFAULT_PC_RANGE)
    voxel_size = algorithm.get("voxelSize", DEFAULT_VOXEL_SIZE)
    free_id = _integer_value(algorithm.get("freeId", 0), "algorithm.freeId")
    general_object_id = _integer_value(
        algorithm.get("generalObjectId", 1), "algorithm.generalObjectId"
    )
    occ_visibility = _boolean_value(
        algorithm.get("occVisibility", False), "algorithm.occVisibility"
    )
    unknown_id = _integer_value(
        algorithm.get("unknownId", 255 if occ_visibility else free_id),
        "algorithm.unknownId",
    )
    lidar_origin = _numeric_vector3(
        algorithm.get("lidarOrigin", [0.0, 0.0, 0.0]),
        "algorithm.lidarOrigin",
    )
    class_map = _semantic_class_map(algorithm)
    ground_class_ids = _semantic_id_set(algorithm.get("groundClassIds", []))
    min_points_per_voxel = _nonnegative_integer(
        algorithm.get("minPointsPerVoxel", 1), "algorithm.minPointsPerVoxel"
    )
    if min_points_per_voxel == 0:
        raise ValueError("algorithm.minPointsPerVoxel must be at least 1")
    cleanup_min_neighbors = _nonnegative_integer(
        algorithm.get("voxelCleanupMinNeighbors", 0),
        "algorithm.voxelCleanupMinNeighbors",
    )
    box_paint_margin = _nonnegative_float(
        algorithm.get("boxPaintMargin", 0.5 * float(voxel_size)),
        "algorithm.boxPaintMargin",
    )
    polyline_surface_thickness = _nonnegative_float(
        algorithm.get("polylineSurfaceThickness", 0.3),
        "algorithm.polylineSurfaceThickness",
    )
    box_visible_threshold = _ratio_value(
        algorithm.get("boxVisibleRatio", 0.2),
        "algorithm.boxVisibleRatio",
    )
    segment_length = _positive_float(
        algorithm.get("segmentLength", DEFAULT_SEGMENT_LENGTH),
        "algorithm.segmentLength",
    )
    half_width = _positive_float(
        algorithm.get("halfWidth", DEFAULT_HALF_WIDTH),
        "algorithm.halfWidth",
    )
    slab_height = _positive_float(
        algorithm.get("slabHeight", DEFAULT_SLAB_HEIGHT),
        "algorithm.slabHeight",
    )
    slab_visible_ratio = _ratio_value(
        algorithm.get("slabVisibleRatio", DEFAULT_SLAB_VISIBLE_RATIO),
        "algorithm.slabVisibleRatio",
    )
    segment_visible_ratio = _ratio_value(
        algorithm.get("segmentVisibleRatio", DEFAULT_SEGMENT_VISIBLE_RATIO),
        "algorithm.segmentVisibleRatio",
    )
    window = _nonnegative_integer(
        algorithm.get("window", DEFAULT_WINDOW), "algorithm.window"
    )
    single_frame = _boolean_value(
        algorithm.get("singleFrame", False), "algorithm.singleFrame"
    )
    drop_ego_body = _boolean_value(
        algorithm.get("dropEgoBody", False), "algorithm.dropEgoBody"
    )
    output_prefix = _required_string(manifest, "outputPrefix").rstrip("/")
    frames = manifest["frames"]
    selected_data_ids = {
        str(data_id) for data_id in manifest.get("selectedDataIds", [])
    }
    if not selected_data_ids:
        selected_data_ids = {
            str(_mapping_value(frame, "frame").get("dataId")) for frame in frames
        }
    first_frame = _mapping_value(frames[0], "frames[0]")
    first_frame_token = _required_string(first_frame, "token")
    camera_config_object_key = manifest.get("cameraConfigObjectKey")
    visibility_requested = occ_visibility or bool(camera_config_object_key)
    if occ_visibility and (
        not isinstance(camera_config_object_key, str)
        or not camera_config_object_key.strip()
    ):
        raise ValueError(
            "algorithm.occVisibility requires a non-empty "
            f"cameraConfigObjectKey for frame {first_frame_token!r}"
        )
    cameras = (
        _load_manifest_cameras(manifest, object_store, first_frame_token)
        if visibility_requested
        else []
    )
    if visibility_requested and len(cameras) != 4:
        request_name = (
            "algorithm.occVisibility" if occ_visibility else "visibility computation"
        )
        raise ValueError(
            f"{request_name} requires cameraConfigObjectKey with four valid "
            f"surround camera calibrations for frame {first_frame_token!r}"
        )
    annotations = _annotation_snapshot(manifest)
    dynamic_boxes = (
        _dynamic_boxes_by_frame(
            frames=frames,
            annotations=annotations,
            dynamic_class_ids=_dynamic_class_ids(algorithm),
        )
        if not single_frame and window > 0
        else [{} for _ in frames]
    )
    shared_point_clouds = manifest.get("_parallelPointClouds")
    point_clouds: PointCloudCache = (
        shared_point_clouds
        if isinstance(shared_point_clouds, PointCloudCache)
        else PointCloudCache()
    )
    shared_prepared_fusion_frames = manifest.get("_parallelPreparedFusionFrames")
    prepared_fusion_frames: Dict[str, PreparedFusionFrame] = (
        shared_prepared_fusion_frames
        if isinstance(shared_prepared_fusion_frames, dict)
        else {}
    )
    timings_ms = {
        "pointCloudFusionRead": 0.0,
        "voxelization": 0.0,
        "pointSemantics": 0.0,
        "occLabelGeneration": 0.0,
        "boxSemanticOverlay": 0.0,
        "lidarMask": 0.0,
        **_empty_lidar_mask_profile(),
        "cameraFovMask": 0.0,
        "boxSubjectsBuild": 0.0,
        "boxEvaluation": 0.0,
        "write": 0.0,
    }

    completed_frames = 0
    for frame_index, frame in enumerate(frames):
        frame_mapping = _mapping_value(frame, "frame")
        if str(frame_mapping.get("dataId")) not in selected_data_ids:
            continue
        token = _required_string(frame_mapping, "token")
        _report_progress(manifest, "OCC_GENERATION", completed_frames)
        started_at = time.perf_counter()
        points = _fused_frame_points(
            frames=frames,
            target_index=frame_index,
            window=window,
            single_frame=single_frame,
            exclude_ego_body=drop_ego_body,
            object_store=object_store,
            point_clouds=point_clouds,
            prepared_fusion_frames=prepared_fusion_frames,
            dynamic_boxes=dynamic_boxes,
        )
        current_frame_points = _load_frame_points(
            frame_mapping, object_store, point_clouds
        )
        timings_ms["pointCloudFusionRead"] += _elapsed_ms(started_at)
        voxelization_started_at = time.perf_counter()
        point_labels = _point_semantics(
            points=points,
            annotations=annotations,
            frame=frame_mapping,
            class_map=class_map,
            general_object_id=general_object_id,
            polyline_surface_thickness=polyline_surface_thickness,
        )
        timings_ms["pointSemantics"] += _elapsed_ms(voxelization_started_at)
        started_at = time.perf_counter()
        occ_labels = generate_occ_labels(
            points_xyz=points,
            semantic_ids=point_labels,
            pc_range=pc_range,
            voxel_size=float(voxel_size),
            unknown_id=unknown_id,
            min_points_per_voxel=min_points_per_voxel,
            min_neighbors=cleanup_min_neighbors,
            class_map=class_map,
        )
        timings_ms["occLabelGeneration"] += max(
            0.0,
            _elapsed_ms(started_at)
            - occ_labels.prepared_points.endpoint_deduplicate_ns / 1_000_000.0,
        )
        started_at = time.perf_counter()
        occ_labels, source_class_ids = _apply_annotation_semantics(
            occ_labels=occ_labels,
            annotations=annotations,
            frame=frame_mapping,
            class_map=class_map,
            box_paint_margin=box_paint_margin,
        )
        timings_ms["boxSemanticOverlay"] += _elapsed_ms(started_at)
        timings_ms["voxelization"] += _elapsed_ms(voxelization_started_at)
        occluders = _occluder_grid(
            occupied=occ_labels.occupied,
            semantics=occ_labels.semantics,
            free_id=free_id,
            ground_semantic_ids=ground_class_ids,
        )
        _report_progress(manifest, "LIDAR_VISIBILITY", completed_frames)
        started_at = time.perf_counter()
        mask_lidar, free_mask, raycast_profile = raycast_visibility_profiled(
            occupied=occluders,
            grid_origin=occ_labels.origin,
            voxel_size=occ_labels.voxel_size,
            lidar_origin=lidar_origin,
            target_points=points,
            prepared_points=occ_labels.prepared_points,
        )
        mask_lidar |= occ_labels.occupied
        timings_ms["lidarMask"] += _elapsed_ms(started_at)
        _add_timings(
            timings_ms,
            _lidar_mask_profile_ms(raycast_profile),
        )
        semantics = occ_labels.semantics.copy()
        semantics[free_mask & ~occ_labels.occupied] = free_id
        if occ_visibility:
            started_at = time.perf_counter()
            mask_camera = camera_fov_mask(
                pc_range=pc_range,
                voxel_size=float(voxel_size),
                cameras=cameras,
                candidate_mask=mask_lidar,
            )
            timings_ms["cameraFovMask"] += _elapsed_ms(started_at)
        else:
            mask_camera = mask_lidar.copy()
        occ_labels = OccLabels(
            semantics=semantics,
            mask_lidar=mask_lidar,
            mask_camera=mask_camera,
            occupied=occ_labels.occupied,
            origin=occ_labels.origin,
            voxel_size=occ_labels.voxel_size,
            class_map=class_map,
            prepared_points=occ_labels.prepared_points,
        )
        started_at = time.perf_counter()
        output = io.BytesIO()
        np.savez_compressed(
            output,
            labels=occ_labels.semantics,
            semantics=occ_labels.semantics,
            occupied=occ_labels.occupied,
            mask_lidar=occ_labels.mask_lidar,
            mask_camera=occ_labels.mask_camera,
            source_class_ids=source_class_ids,
            pc_range=np.asarray(pc_range, dtype=np.float64),
            voxel_size=np.asarray(voxel_size, dtype=np.float64),
            origin=occ_labels.origin,
            class_map=np.asarray(json.dumps(class_map, sort_keys=True)),
        )
        object_store.put_bytes(
            f"{output_prefix}/occ/{token}/labels.npz", output.getvalue()
        )
        timings_ms["write"] += _elapsed_ms(started_at)
        if task_type == "OCC":
            completed_frames += 1
            _report_progress(manifest, "WRITING", completed_frames)
            continue
        _report_progress(manifest, "ANNOTATION_VISIBILITY", completed_frames)
        boxes = _frame_box_visibility(
            annotations=annotations,
            frame=frame_mapping,
            current_frame_points=current_frame_points,
            cameras=cameras,
            occupied=occ_labels.occupied,
            occluders=occluders,
            semantics=occ_labels.semantics,
            pc_range=pc_range,
            voxel_size=float(voxel_size),
            visible_threshold=box_visible_threshold,
            free_id=free_id,
            ground_semantic_ids=ground_class_ids,
            timings_ms=timings_ms,
        )
        polylines = _frame_polyline_visibility(
            annotations=annotations,
            frame=frame_mapping,
            current_frame_points=current_frame_points,
            cameras=cameras,
            occupied=occ_labels.occupied,
            occluders=occluders,
            semantics=occ_labels.semantics,
            pc_range=pc_range,
            voxel_size=float(voxel_size),
            segment_length=segment_length,
            half_width=half_width,
            slab_height=slab_height,
            slab_visible_ratio=slab_visible_ratio,
            segment_visible_ratio=segment_visible_ratio,
            free_id=free_id,
            ground_semantic_ids=ground_class_ids,
        )
        sidecar = build_frame_sidecar(
            scene_id=str(manifest.get("sceneId", "unknown")),
            frame_token=token,
            source_hash=_source_hash(manifest),
            algorithm_version=_required_string(algorithm, "version"),
            boxes=boxes,
            polylines=polylines,
            occ={
                "voxelSize": float(voxel_size),
                "pcRange": [float(value) for value in pc_range],
                "origin": occ_labels.origin.tolist(),
                "classMap": class_map,
                "freeId": free_id,
                "unknownId": unknown_id,
                "maskLidarKey": "mask_lidar",
                "maskCameraKey": "mask_camera",
            },
        )
        object_store.put_bytes(
            f"{output_prefix}/visibility/{token}.json",
            json.dumps(
                sidecar, sort_keys=True, separators=(",", ":")
            ).encode("utf-8"),
        )
        completed_frames += 1
        _report_progress(manifest, "WRITING", completed_frames)

    manifest_key = f"{output_prefix}/manifest.json"
    if manifest.get("_parallelChild"):
        return {
            "manifestObjectKey": manifest_key,
            "frameCount": len(selected_data_ids),
            "timingsMs": timings_ms,
        }
    started_at = time.perf_counter()
    manifest_bytes = json.dumps(
        manifest, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    _write_or_reuse_manifest(object_store, manifest_key, manifest_bytes)
    timings_ms["write"] += _elapsed_ms(started_at)
    _report_progress(manifest, "WRITING", completed_frames)
    return {
        "manifestObjectKey": manifest_key,
        "frameCount": len(selected_data_ids),
        "timingsMs": timings_ms,
    }


def _should_parallelize_occ(manifest: Mapping[str, Any]) -> bool:
    if manifest.get("_parallelChild"):
        return False
    algorithm = _required_mapping(manifest, "algorithm")
    workers = _occ_frame_workers(algorithm)
    if workers <= 1:
        return False
    selected_data_ids = {
        str(data_id) for data_id in manifest.get("selectedDataIds", [])
    }
    if not selected_data_ids:
        selected_data_ids = {
            str(_mapping_value(frame, "frame").get("dataId"))
            for frame in manifest["frames"]
        }
    return len(selected_data_ids) > 1


def _run_parallel_occ_manifest(
    manifest: Mapping[str, Any], object_store: ObjectStore
) -> Dict[str, Any]:
    algorithm = _required_mapping(manifest, "algorithm")
    workers = _occ_frame_workers(algorithm)
    frames = manifest["frames"]
    selected_data_ids = {
        str(data_id) for data_id in manifest.get("selectedDataIds", [])
    }
    if not selected_data_ids:
        selected_data_ids = {
            str(_mapping_value(frame, "frame").get("dataId")) for frame in frames
        }
    shared_point_clouds = PointCloudCache()
    shared_prepared_fusion_frames: Dict[str, PreparedFusionFrame] = {}
    completed_data_ids = {
        data_id
        for data_id in selected_data_ids
        if _occ_output_exists(
            object_store, output_prefix=_required_string(manifest, "outputPrefix"),
            frames=frames, data_id=data_id
        )
    }
    child_manifests = [
        _parallel_child_manifest(
            manifest,
            algorithm,
            data_id,
            shared_point_clouds,
            shared_prepared_fusion_frames,
        )
        for data_id in selected_data_ids - completed_data_ids
    ]
    timings_ms = _empty_occ_timings()
    completed_frames = len(completed_data_ids)
    _report_progress(manifest, "PREPARING", completed_frames)
    _report_progress(manifest, "OCC_GENERATION", completed_frames)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [
            executor.submit(run_manifest, child_manifest, object_store)
            for child_manifest in child_manifests
        ]
        for future in as_completed(futures):
            result = future.result()
            _add_timings(timings_ms, result["timingsMs"])
            completed_frames += 1
            _report_progress(manifest, "WRITING", completed_frames)
    output_prefix = _required_string(manifest, "outputPrefix").rstrip("/")
    manifest_key = f"{output_prefix}/manifest.json"
    started_at = time.perf_counter()
    manifest_bytes = json.dumps(
        manifest, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    _write_or_reuse_manifest(object_store, manifest_key, manifest_bytes)
    timings_ms["write"] += _elapsed_ms(started_at)
    _report_progress(manifest, "WRITING", completed_frames)
    return {
        "manifestObjectKey": manifest_key,
        "frameCount": len(selected_data_ids),
        "timingsMs": timings_ms,
    }


def _occ_output_exists(
    object_store: ObjectStore,
    output_prefix: str,
    frames: Sequence[Any],
    data_id: str,
) -> bool:
    for frame in frames:
        frame_mapping = _mapping_value(frame, "frame")
        if str(frame_mapping.get("dataId")) != data_id:
            continue
        token = _required_string(frame_mapping, "token")
        try:
            object_store.get_bytes(
                f"{output_prefix.rstrip('/')}/occ/{token}/labels.npz"
            )
        except (KeyError, S3Error):
            return False
        return True
    raise ValueError(f"selected dataId {data_id!r} is not present in frames")


def _parallel_child_manifest(
    manifest: Mapping[str, Any],
    algorithm: Mapping[str, Any],
    data_id: str,
    shared_point_clouds: PointCloudCache,
    shared_prepared_fusion_frames: Dict[str, PreparedFusionFrame],
) -> Dict[str, Any]:
    child_manifest = dict(manifest)
    child_algorithm = dict(algorithm)
    child_algorithm["frameWorkers"] = 1
    child_manifest["algorithm"] = child_algorithm
    child_manifest["selectedDataIds"] = [data_id]
    child_manifest["_parallelChild"] = True
    child_manifest["_parallelPointClouds"] = shared_point_clouds
    child_manifest["_parallelPreparedFusionFrames"] = shared_prepared_fusion_frames
    child_manifest["_suppressProgress"] = True
    return child_manifest


def _empty_occ_timings() -> Dict[str, float]:
    return {
        "pointCloudFusionRead": 0.0,
        "voxelization": 0.0,
        "pointSemantics": 0.0,
        "occLabelGeneration": 0.0,
        "boxSemanticOverlay": 0.0,
        "lidarMask": 0.0,
        **_empty_lidar_mask_profile(),
        "cameraFovMask": 0.0,
        "write": 0.0,
    }


def _occ_frame_workers(algorithm: Mapping[str, Any]) -> int:
    workers = _nonnegative_integer(
        algorithm.get("frameWorkers", OCC_FRAME_WORKERS),
        "algorithm.frameWorkers",
    )
    if workers < 1:
        raise ValueError("algorithm.frameWorkers must be at least 1")
    return workers


def _empty_lidar_mask_profile() -> Dict[str, float]:
    return {
        "lidarMaskInputRayCount": 0.0,
        "lidarMaskUniqueRayCount": 0.0,
        "lidarMaskTracedRayCount": 0.0,
        "lidarMaskEndpointDeduplicateMs": 0.0,
        "lidarMaskDeduplicateMs": 0.0,
        "lidarMaskSampleMs": 0.0,
        "lidarMaskSetupMs": 0.0,
        "lidarMaskKernelMs": 0.0,
    }


def _lidar_mask_profile_ms(profile: RaycastVisibilityProfile) -> Dict[str, float]:
    return {
        "lidarMaskInputRayCount": float(profile.input_ray_count),
        "lidarMaskUniqueRayCount": float(profile.unique_ray_count),
        "lidarMaskTracedRayCount": float(profile.traced_ray_count),
        "lidarMaskEndpointDeduplicateMs": (
            profile.endpoint_deduplicate_ns / 1_000_000.0
        ),
        "lidarMaskDeduplicateMs": profile.deduplicate_ns / 1_000_000.0,
        "lidarMaskSampleMs": profile.sample_ns / 1_000_000.0,
        "lidarMaskSetupMs": profile.setup_ns / 1_000_000.0,
        "lidarMaskKernelMs": profile.kernel_ns / 1_000_000.0,
    }


def _add_timings(target: Dict[str, float], source: Mapping[str, float]) -> None:
    for name, value in source.items():
        target[name] = target.get(name, 0.0) + value


def _manifest_task_type(manifest: Mapping[str, Any]) -> str:
    task_type = manifest.get("taskType")
    if task_type is None:
        return "LEGACY"
    if task_type not in {"OCC", "VISIBILITY"}:
        raise ValueError("taskType must be OCC or VISIBILITY")
    return task_type


def _run_visibility_manifest(
    manifest: Mapping[str, Any], object_store: ObjectStore
) -> Dict[str, Any]:
    _report_progress(manifest, "PREPARING", 0)
    algorithm = _required_mapping(manifest, "algorithm")
    output_prefix = _required_string(manifest, "outputPrefix").rstrip("/")
    occ_output_prefix = _required_string(manifest, "occOutputPrefix").rstrip("/")
    frames = manifest["frames"]
    selected_data_ids = {
        str(data_id) for data_id in manifest.get("selectedDataIds", [])
    }
    if not selected_data_ids:
        selected_data_ids = {
            str(_mapping_value(frame, "frame").get("dataId")) for frame in frames
        }
    first_frame = _mapping_value(frames[0], "frames[0]")
    first_frame_token = _required_string(first_frame, "token")
    cameras = _load_manifest_cameras(manifest, object_store, first_frame_token)
    if len(cameras) != 4:
        raise ValueError(
            "visibility task requires cameraConfigObjectKey with four valid "
            f"surround camera calibrations for frame {first_frame_token!r}"
        )
    free_id = _integer_value(algorithm.get("freeId", 0), "algorithm.freeId")
    unknown_id = _integer_value(
        algorithm.get("unknownId", 255), "algorithm.unknownId"
    )
    ground_class_ids = _semantic_id_set(algorithm.get("groundClassIds", []))
    box_visible_threshold = _ratio_value(
        algorithm.get("boxVisibleRatio", 0.2), "algorithm.boxVisibleRatio"
    )
    segment_length = _positive_float(
        algorithm.get("segmentLength", DEFAULT_SEGMENT_LENGTH),
        "algorithm.segmentLength",
    )
    half_width = _positive_float(
        algorithm.get("halfWidth", DEFAULT_HALF_WIDTH),
        "algorithm.halfWidth",
    )
    slab_height = _positive_float(
        algorithm.get("slabHeight", DEFAULT_SLAB_HEIGHT),
        "algorithm.slabHeight",
    )
    slab_visible_ratio = _ratio_value(
        algorithm.get("slabVisibleRatio", DEFAULT_SLAB_VISIBLE_RATIO),
        "algorithm.slabVisibleRatio",
    )
    segment_visible_ratio = _ratio_value(
        algorithm.get("segmentVisibleRatio", DEFAULT_SEGMENT_VISIBLE_RATIO),
        "algorithm.segmentVisibleRatio",
    )
    annotations = _annotation_snapshot(manifest)
    point_clouds: Dict[str, np.ndarray] = {}
    timings_ms = {
        "occRead": 0.0,
        "pointCloudRead": 0.0,
        "box": 0.0,
        "boxSubjectsBuild": 0.0,
        "boxEvaluation": 0.0,
        "polyline": 0.0,
        "sidecarWrite": 0.0,
    }
    completed_frames = 0
    for frame in frames:
        frame_mapping = _mapping_value(frame, "frame")
        if str(frame_mapping.get("dataId")) not in selected_data_ids:
            continue
        token = _required_string(frame_mapping, "token")
        _report_progress(manifest, "ANNOTATION_VISIBILITY", completed_frames)
        started_at = time.perf_counter()
        semantics, occupied, pc_range, voxel_size, origin, class_map = (
            _read_visibility_labels(
                object_store.get_bytes(
                    f"{occ_output_prefix}/occ/{token}/labels.npz"
                )
            )
        )
        timings_ms["occRead"] += _elapsed_ms(started_at)
        started_at = time.perf_counter()
        current_frame_points = _load_frame_points(
            frame_mapping, object_store, point_clouds
        )
        timings_ms["pointCloudRead"] += _elapsed_ms(started_at)
        occluders = _occluder_grid(
            occupied=occupied,
            semantics=semantics,
            free_id=free_id,
            ground_semantic_ids=ground_class_ids,
        )
        started_at = time.perf_counter()
        boxes = _frame_box_visibility(
            annotations=annotations,
            frame=frame_mapping,
            current_frame_points=current_frame_points,
            cameras=cameras,
            occupied=occupied,
            occluders=occluders,
            semantics=semantics,
            pc_range=pc_range,
            voxel_size=voxel_size,
            visible_threshold=box_visible_threshold,
            free_id=free_id,
            ground_semantic_ids=ground_class_ids,
            timings_ms=timings_ms,
        )
        timings_ms["box"] += _elapsed_ms(started_at)
        started_at = time.perf_counter()
        polylines = _frame_polyline_visibility(
            annotations=annotations,
            frame=frame_mapping,
            current_frame_points=current_frame_points,
            cameras=cameras,
            occupied=occupied,
            occluders=occluders,
            semantics=semantics,
            pc_range=pc_range,
            voxel_size=voxel_size,
            segment_length=segment_length,
            half_width=half_width,
            slab_height=slab_height,
            slab_visible_ratio=slab_visible_ratio,
            segment_visible_ratio=segment_visible_ratio,
            free_id=free_id,
            ground_semantic_ids=ground_class_ids,
        )
        timings_ms["polyline"] += _elapsed_ms(started_at)
        started_at = time.perf_counter()
        sidecar = build_frame_sidecar(
            scene_id=str(manifest.get("sceneId", "unknown")),
            frame_token=token,
            source_hash=_source_hash(manifest),
            algorithm_version=_required_string(algorithm, "version"),
            boxes=boxes,
            polylines=polylines,
            occ={
                "voxelSize": voxel_size,
                "pcRange": [float(value) for value in pc_range],
                "origin": origin.tolist(),
                "classMap": class_map,
                "freeId": free_id,
                "unknownId": unknown_id,
                "maskLidarKey": "mask_lidar",
                "maskCameraKey": "mask_camera",
            },
        )
        object_store.put_bytes(
            f"{output_prefix}/visibility/{token}.json",
            json.dumps(
                sidecar, sort_keys=True, separators=(",", ":")
            ).encode("utf-8"),
        )
        timings_ms["sidecarWrite"] += _elapsed_ms(started_at)
        completed_frames += 1
        _report_progress(manifest, "WRITING", completed_frames)
    return {
        "manifestObjectKey": None,
        "frameCount": len(selected_data_ids),
        "timingsMs": timings_ms,
    }


def _elapsed_ms(started_at: float) -> float:
    return round((time.perf_counter() - started_at) * 1000.0, 3)


def _read_visibility_labels(
    content: bytes,
) -> Tuple[np.ndarray, np.ndarray, Sequence[float], float, np.ndarray, Dict[str, int]]:
    with np.load(io.BytesIO(content), allow_pickle=False) as archive:
        required_keys = {"semantics", "occupied", "pc_range", "voxel_size", "origin"}
        missing_keys = required_keys.difference(archive.files)
        if missing_keys:
            raise ValueError(
                "OCC labels.npz is missing required reusable arrays: "
                + ", ".join(sorted(missing_keys))
            )
        semantics = np.asarray(archive["semantics"])
        occupied = np.asarray(archive["occupied"], dtype=bool)
        if semantics.shape != occupied.shape:
            raise ValueError("OCC labels semantics and occupied arrays must share a shape")
        class_map = {}
        if "class_map" in archive:
            raw_class_map = str(np.asarray(archive["class_map"]).item())
            parsed_class_map = json.loads(raw_class_map)
            if not isinstance(parsed_class_map, dict):
                raise ValueError("OCC labels class_map must be a JSON object")
            class_map = {
                str(key): _integer_value(value, f"labels.class_map[{key!r}]")
                for key, value in parsed_class_map.items()
            }
        return (
            semantics,
            occupied,
            np.asarray(archive["pc_range"], dtype=np.float64).tolist(),
            float(np.asarray(archive["voxel_size"]).item()),
            np.asarray(archive["origin"], dtype=np.float64),
            class_map,
        )


def _report_progress(
    manifest: Mapping[str, Any],
    stage: str,
    completed_frames: int,
) -> None:
    if manifest.get("_suppressProgress"):
        return
    callback_url = os.environ.get("OCC_PROGRESS_CALLBACK_URL", "").strip()
    callback_secret = os.environ.get("OCC_PROGRESS_SHARED_SECRET", "")
    run_id = manifest.get("runId")
    if not callback_url or not callback_secret or run_id is None:
        return
    payload = json.dumps(
        {"stage": stage, "completedFrames": completed_frames},
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{callback_url.rstrip('/')}/{run_id}/progress",
        data=payload,
        headers={
            "Content-Type": "application/json",
            WORKER_PROGRESS_SECRET_HEADER: callback_secret,
        },
        method="POST",
    )
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(request, timeout=5):
                return
        except (OSError, urllib.error.URLError) as error:
            if attempt == 3:
                print(
                    "OCC progress callback failed "
                    f"runId={run_id} stage={stage} attempts={attempt}: {error}",
                    flush=True,
                )
                return
            time.sleep(0.2 * (2 ** (attempt - 1)))


def _write_or_reuse_manifest(
    object_store: ObjectStore, manifest_key: str, manifest_bytes: bytes
) -> None:
    try:
        object_store.put_bytes(manifest_key, manifest_bytes, immutable=True)
    except FileExistsError:
        existing_manifest = object_store.get_bytes(manifest_key)
        if existing_manifest != manifest_bytes:
            raise ValueError(
                f"immutable manifest content differs for outputPrefix: {manifest_key}"
            )


def _fused_frame_points(
    frames: Sequence[Any],
    target_index: int,
    window: int,
    single_frame: bool,
    exclude_ego_body: bool,
    object_store: ObjectStore,
    point_clouds: PointCloudCache,
    prepared_fusion_frames: Dict[str, PreparedFusionFrame],
    dynamic_boxes: Sequence[Mapping[str, Box3D]],
) -> np.ndarray:
    target_frame = _mapping_value(frames[target_index], f"frames[{target_index}]")
    if single_frame:
        points = _load_frame_points(target_frame, object_store, point_clouds)
        return drop_ego_body_points(points) if exclude_ego_body else points

    start = max(0, target_index - window)
    stop = min(len(frames), target_index + window + 1)
    if stop - start == 1:
        points = _load_frame_points(target_frame, object_store, point_clouds)
        return drop_ego_body_points(points) if exclude_ego_body else points

    frame_slice = [
        _mapping_value(frames[index], f"frames[{index}]")
        for index in range(start, stop)
    ]
    sliced_points = [
        _fused_source_points(
            frame,
            object_store,
            point_clouds,
            exclude_ego_body,
        )
        for frame in frame_slice
    ]
    sliced_poses = [
        _ego_pose(frame, start + index)
        for index, frame in enumerate(frame_slice)
    ]
    prepared_frames = [
        _prepared_fusion_frame(
            frame,
            points,
            pose,
            dynamic_boxes[start + index],
            prepared_fusion_frames,
        )
        for index, (frame, points, pose) in enumerate(
            zip(frame_slice, sliced_points, sliced_poses)
        )
    ]
    return fuse_prepared_frame_points(
        prepared_frames=prepared_frames,
        poses=sliced_poses,
        dynamic_boxes=dynamic_boxes[start:stop],
        target_index=target_index - start,
        window=window,
        single_frame=False,
    )


def _fused_source_points(
    frame: Mapping[str, Any],
    object_store: ObjectStore,
    point_clouds: PointCloudCache,
    exclude_ego_body: bool,
) -> np.ndarray:
    points = _load_frame_points(frame, object_store, point_clouds)
    return drop_ego_body_points(points) if exclude_ego_body else points


def _prepared_fusion_frame(
    frame: Mapping[str, Any],
    points: np.ndarray,
    pose: EgoPose,
    dynamic_boxes: Mapping[str, Box3D],
    prepared_fusion_frames: Dict[str, PreparedFusionFrame],
) -> PreparedFusionFrame:
    token = _required_string(frame, "token")
    cached = prepared_fusion_frames.get(token)
    if cached is not None:
        return cached
    prepared = prepare_fusion_frames(
        [points], [pose], [dynamic_boxes]
    )[0]
    prepared_fusion_frames[token] = prepared
    return prepared


def _dynamic_boxes_by_frame(
    frames: Sequence[Any],
    annotations: Sequence[Mapping[str, Any]],
    dynamic_class_ids: frozenset[str],
) -> List[Dict[str, Box3D]]:
    annotations_by_data_id: Dict[str, List[Tuple[int, Mapping[str, Any]]]] = {}
    for index, annotation in enumerate(annotations):
        annotations_by_data_id.setdefault(str(annotation.get("dataId")), []).append(
            (index, annotation)
        )

    result: List[Dict[str, Box3D]] = []
    for frame_index, frame in enumerate(frames):
        frame_mapping = _mapping_value(frame, f"frames[{frame_index}]")
        boxes: Dict[str, Box3D] = {}
        for annotation_index, annotation in annotations_by_data_id.get(
            str(frame_mapping.get("dataId")), []
        ):
            if _class_id(annotation.get("classId")) not in dynamic_class_ids:
                continue
            attributes = annotation.get("classAttributes")
            if not isinstance(attributes, dict) or attributes.get("type") != "3D_BOX":
                continue
            contour = _mapping_value(
                attributes.get("contour"), "annotation contour"
            )
            size = _vector3(contour.get("size3D"), "contour.size3D")
            if np.any(size <= 0.0):
                raise ValueError(
                    f"contour.size3D must be positive, got {size.tolist()}"
                )
            identity = _annotation_object_id(
                annotation, attributes, annotation_index
            )
            if identity in boxes:
                raise ValueError(
                    f"duplicate dynamic annotation identity: {identity}"
                )
            boxes[identity] = Box3D(
                identity=identity,
                center=_vector3(contour.get("center3D"), "contour.center3D"),
                size=size,
                rotation=_vector3(
                    contour.get("rotation3D"), "contour.rotation3D"
                ),
            )
        result.append(boxes)
    return result


def _dynamic_class_ids(algorithm: Mapping[str, Any]) -> frozenset[str]:
    values = algorithm.get("dynamicClassIds")
    if values is None:
        return DEFAULT_DYNAMIC_CLASS_IDS
    if not isinstance(values, list):
        raise TypeError("algorithm.dynamicClassIds must be an array")
    result: List[str] = []
    for index, value in enumerate(values):
        if not isinstance(value, (str, int)) or isinstance(value, bool):
            raise TypeError(
                f"algorithm.dynamicClassIds[{index}] must be a string or integer"
            )
        result.append(_class_id(value))
    return frozenset(result)


def _class_id(value: Any) -> str:
    return str(value).casefold()


def _ego_pose(frame: Mapping[str, Any], frame_index: int) -> EgoPose:
    translation, yaw = _pose_components(
        _frame_pose(frame, frame_index),
        f"frames[{frame_index}].pose",
    )
    return EgoPose(translation=translation, yaw=yaw)


def _load_frame_points(
    frame: Mapping[str, Any],
    object_store: ObjectStore,
    point_clouds: PointCloudCache | Dict[str, np.ndarray],
) -> np.ndarray:
    point_cloud_key = _required_string(frame, "pointCloudObjectKey")
    if isinstance(point_clouds, PointCloudCache):
        return point_clouds.get(object_store, point_cloud_key)
    if point_cloud_key not in point_clouds:
        point_clouds[point_cloud_key] = _read_pcd_bytes(
            object_store.get_bytes(point_cloud_key)
        )
    return point_clouds[point_cloud_key]


def _transform_points_to_target(
    points: np.ndarray,
    source_pose: Mapping[str, Any],
    target_pose: Mapping[str, Any],
) -> np.ndarray:
    source_translation, source_yaw = _pose_components(
        source_pose, "source_pose"
    )
    target_translation, target_yaw = _pose_components(
        target_pose, "target_pose"
    )
    source_rotation = _yaw_rotation(source_yaw)
    target_rotation = _yaw_rotation(target_yaw)
    world_points = points @ source_rotation.T + source_translation
    return (world_points - target_translation) @ target_rotation


def _frame_pose(frame: Mapping[str, Any], frame_index: int) -> Mapping[str, Any]:
    return _mapping_value(frame.get("pose"), f"frames[{frame_index}].pose")


def _pose_components(
    pose: Mapping[str, Any], name: str
) -> Tuple[np.ndarray, float]:
    values = []
    for key in ("x", "y", "z", "yaw"):
        value = pose.get(key)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise TypeError(f"{name}.{key} must be numeric")
        numeric_value = float(value)
        if not np.isfinite(numeric_value):
            raise ValueError(f"{name}.{key} must be finite, got {value}")
        values.append(numeric_value)
    return np.asarray(values[:3], dtype=np.float64), values[3]


def _yaw_rotation(yaw: float) -> np.ndarray:
    cosine = np.cos(yaw)
    sine = np.sin(yaw)
    return np.array(
        [[cosine, -sine, 0.0], [sine, cosine, 0.0], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )


def _load_manifest_cameras(
    manifest: Mapping[str, Any], object_store: ObjectStore, frame_token: str
) -> List[Dict[str, object]]:
    object_key = manifest.get("cameraConfigObjectKey")
    if object_key is None or object_key == "":
        return []
    if not isinstance(object_key, str):
        raise TypeError("cameraConfigObjectKey must be a string")
    try:
        content = object_store.get_bytes(object_key)
    except (KeyError, OSError) as error:
        raise ValueError(
            f"failed to load cameraConfigObjectKey {object_key!r} for frame "
            f"{frame_token!r}: object does not exist or is unreadable"
        ) from error
    descriptor, path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
        try:
            return load_surround_cameras(Path(path))
        except (OSError, ValueError) as error:
            raise ValueError(
                f"failed to parse cameraConfigObjectKey {object_key!r} for frame "
                f"{frame_token!r}: {error}"
            ) from error
    finally:
        if os.path.exists(path):
            os.unlink(path)


def _annotation_snapshot(
    manifest: Mapping[str, Any],
) -> Sequence[Mapping[str, Any]]:
    annotations = manifest.get("annotations", [])
    if not isinstance(annotations, list):
        raise TypeError("annotations must be an array")
    return [
        _mapping_value(annotation, "annotation") for annotation in annotations
    ]


def _occluder_grid(
    occupied: np.ndarray,
    semantics: np.ndarray,
    free_id: int,
    ground_semantic_ids: set[int],
) -> np.ndarray:
    non_occluder_ids = np.asarray([free_id, *sorted(ground_semantic_ids)])
    return np.asarray(occupied, dtype=bool) & ~np.isin(semantics, non_occluder_ids)


def _semantic_class_map(algorithm: Mapping[str, Any]) -> Dict[str, int]:
    raw = algorithm.get("classMap", {})
    if not isinstance(raw, dict):
        raise TypeError("algorithm.classMap must be an object")
    return {
        str(class_id): _integer_value(semantic_id, f"algorithm.classMap[{class_id!r}]")
        for class_id, semantic_id in raw.items()
    }


def _semantic_id_set(value: Any) -> set[int]:
    if not isinstance(value, list):
        raise TypeError("algorithm.groundClassIds must be an array")
    return {
        _integer_value(item, f"algorithm.groundClassIds[{index}]")
        for index, item in enumerate(value)
    }


def _point_semantics(
    points: np.ndarray,
    annotations: Sequence[Mapping[str, Any]],
    frame: Mapping[str, Any],
    class_map: Mapping[str, int],
    general_object_id: int,
    polyline_surface_thickness: float,
) -> np.ndarray:
    labels = np.full(points.shape[0], general_object_id, dtype=np.int64)
    frame_data_id = str(frame.get("dataId"))
    point_grid: _PointAabbGrid | None = None
    for annotation in annotations:
        if str(annotation.get("dataId")) != frame_data_id:
            continue
        attributes = annotation.get("classAttributes")
        if not isinstance(attributes, dict):
            continue
        semantic_id = class_map.get(str(annotation.get("classId")))
        if semantic_id is None:
            continue
        contour = attributes.get("contour")
        if not isinstance(contour, dict):
            continue
        if attributes.get("type") == "GROUND_POLYLINE":
            if point_grid is None:
                point_grid = _PointAabbGrid(
                    points, cell_size=POINT_AABB_GRID_CELL_SIZE
                )
            bottom = _vectors3(contour.get("points"), "contour.points")
            height = _nonnegative_float(
                attributes.get("wallHeight", 0.0), "annotation wallHeight"
            )
            top = bottom + np.array([0.0, 0.0, height])
            _apply_indexed_polyline_semantic(
                labels,
                points,
                point_grid,
                bottom,
                top,
                polyline_surface_thickness / 2.0,
                semantic_id,
            )
        elif attributes.get("type") == "IRREGULAR_WALL":
            if point_grid is None:
                point_grid = _PointAabbGrid(
                    points, cell_size=POINT_AABB_GRID_CELL_SIZE
                )
            _apply_indexed_polyline_semantic(
                labels,
                points,
                point_grid,
                _vectors3(contour.get("points"), "contour.points"),
                _vectors3(contour.get("topPoints"), "contour.topPoints"),
                polyline_surface_thickness / 2.0,
                semantic_id,
            )
    return labels


class _PointAabbGrid:
    def __init__(self, points: np.ndarray, cell_size: float) -> None:
        if cell_size <= 0.0:
            raise ValueError(f"cell_size must be positive, got {cell_size}")
        self._points = points
        self._cell_size = cell_size
        buckets: Dict[Tuple[int, int, int], List[int]] = {}
        cell_coordinates = np.floor(points / cell_size).astype(np.int64)
        for point_index, cell in enumerate(cell_coordinates):
            cell_key = (int(cell[0]), int(cell[1]), int(cell[2]))
            buckets.setdefault(cell_key, []).append(point_index)
        self._buckets = {
            cell_key: np.asarray(indices, dtype=np.int64)
            for cell_key, indices in buckets.items()
        }

    def candidate_indices(self, lower: np.ndarray, upper: np.ndarray) -> np.ndarray:
        lower_cell = np.floor(lower / self._cell_size).astype(np.int64)
        upper_cell = np.floor(upper / self._cell_size).astype(np.int64)
        cell_count = int(
            np.prod(upper_cell.astype(object) - lower_cell.astype(object) + 1)
        )
        if cell_count <= len(self._buckets):
            bucket_indices = [
                self._buckets[cell_key]
                for x in range(int(lower_cell[0]), int(upper_cell[0]) + 1)
                for y in range(int(lower_cell[1]), int(upper_cell[1]) + 1)
                for z in range(int(lower_cell[2]), int(upper_cell[2]) + 1)
                if (cell_key := (x, y, z)) in self._buckets
            ]
        else:
            bucket_indices = [
                indices
                for cell_key, indices in self._buckets.items()
                if np.all(np.asarray(cell_key) >= lower_cell)
                and np.all(np.asarray(cell_key) <= upper_cell)
            ]
        if not bucket_indices:
            return np.empty(0, dtype=np.int64)
        candidate_indices = np.sort(np.concatenate(bucket_indices))
        candidate_points = self._points[candidate_indices]
        return candidate_indices[
            np.all(
                (candidate_points >= lower) & (candidate_points <= upper), axis=1
            )
        ]


def _apply_polyline_semantic(
    labels: np.ndarray,
    points: np.ndarray,
    bottom: np.ndarray,
    top: np.ndarray,
    half_thickness: float,
    semantic_id: int,
) -> None:
    selected = _points_near_polyline(points, bottom, top, half_thickness)
    labels[selected] = semantic_id


def _apply_indexed_polyline_semantic(
    labels: np.ndarray,
    points: np.ndarray,
    point_grid: _PointAabbGrid,
    bottom: np.ndarray,
    top: np.ndarray,
    half_thickness: float,
    semantic_id: int,
) -> None:
    selected = _points_near_polyline(
        points, bottom, top, half_thickness, point_grid
    )
    labels[selected] = semantic_id


def _polyline_candidate_indices(
    points: np.ndarray,
    bottom: np.ndarray,
    top: np.ndarray,
    half_thickness: float,
) -> np.ndarray:
    lower, upper = _polyline_aabb(bottom, top, half_thickness)
    return np.flatnonzero(
        np.all((points >= lower) & (points <= upper), axis=1)
    )


def _polyline_aabb(
    bottom: np.ndarray,
    top: np.ndarray,
    half_thickness: float,
) -> Tuple[np.ndarray, np.ndarray]:
    vertices = np.vstack((bottom, top))
    lower = np.min(vertices, axis=0) - half_thickness
    upper = np.max(vertices, axis=0) + half_thickness
    return lower, upper


def _points_near_polyline(
    points: np.ndarray,
    bottom: np.ndarray,
    top: np.ndarray,
    half_thickness: float,
    point_grid: _PointAabbGrid | None = None,
) -> np.ndarray:
    if point_grid is None:
        point_grid = _PointAabbGrid(points, cell_size=POINT_AABB_GRID_CELL_SIZE)
    selected = np.zeros(points.shape[0], dtype=bool)
    for start, end, top_start, top_end in zip(
        bottom[:-1], bottom[1:], top[:-1], top[1:]
    ):
        direction = end[:2] - start[:2]
        length_squared = float(direction @ direction)
        if length_squared == 0.0:
            continue
        lower_aabb, upper_aabb = _polyline_aabb(
            np.vstack((start, end)),
            np.vstack((top_start, top_end)),
            half_thickness,
        )
        candidate_indices = point_grid.candidate_indices(lower_aabb, upper_aabb)
        if candidate_indices.size == 0:
            continue
        candidate_points = points[candidate_indices]
        along = np.clip(
            ((candidate_points[:, :2] - start[:2]) @ direction) / length_squared,
            0.0,
            1.0,
        )
        closest = start[:2] + along[:, None] * direction
        lower = start[2] + along * (end[2] - start[2])
        upper = top_start[2] + along * (top_end[2] - top_start[2])
        selected[candidate_indices] |= (
            (
                np.linalg.norm(candidate_points[:, :2] - closest, axis=1)
                <= half_thickness
            )
            & (
                candidate_points[:, 2]
                >= np.minimum(lower, upper) - half_thickness
            )
            & (
                candidate_points[:, 2]
                <= np.maximum(lower, upper) + half_thickness
            )
        )
    return selected


def _apply_annotation_semantics(
    occ_labels: OccLabels,
    annotations: Sequence[Mapping[str, Any]],
    frame: Mapping[str, Any],
    class_map: Mapping[str, int],
    box_paint_margin: float,
) -> Tuple[OccLabels, np.ndarray]:
    centers: List[np.ndarray] = []
    sizes: List[np.ndarray] = []
    yaws: List[float] = []
    semantic_ids: List[int] = []
    source_class_id_values: List[int] = []
    for annotation in annotations:
        if str(annotation.get("dataId")) != str(frame.get("dataId")):
            continue
        attributes = annotation.get("classAttributes")
        semantic_id = class_map.get(str(annotation.get("classId")))
        if not isinstance(attributes, dict) or semantic_id is None:
            continue
        if attributes.get("type") != "3D_BOX":
            continue
        source_class_id = _integer_value(
            annotation.get("classId"), "annotation.classId"
        )
        contour = _mapping_value(attributes.get("contour"), "annotation contour")
        centers.append(_vector3(contour.get("center3D"), "contour.center3D"))
        sizes.append(_vector3(contour.get("size3D"), "contour.size3D"))
        yaws.append(float(_vector3(contour.get("rotation3D"), "contour.rotation3D")[2]))
        semantic_ids.append(semantic_id)
        source_class_id_values.append(source_class_id)
    if not centers:
        return occ_labels, np.zeros_like(occ_labels.semantics, dtype=np.int64)
    semantics = overlay_box_semantics(
        semantics=occ_labels.semantics,
        occupied=occ_labels.occupied,
        pc_range=np.concatenate(
            (
                occ_labels.origin,
                occ_labels.origin
                + np.asarray(occ_labels.occupied.shape) * occ_labels.voxel_size,
            )
        ),
        voxel_size=occ_labels.voxel_size,
        centers=np.stack(centers),
        sizes=np.stack(sizes),
        yaws=np.asarray(yaws),
        semantic_ids=np.asarray(semantic_ids),
        margin=box_paint_margin,
    )
    source_class_ids = overlay_box_semantics(
        semantics=np.zeros_like(occ_labels.semantics, dtype=np.int64),
        occupied=occ_labels.occupied,
        pc_range=np.concatenate(
            (
                occ_labels.origin,
                occ_labels.origin
                + np.asarray(occ_labels.occupied.shape) * occ_labels.voxel_size,
            )
        ),
        voxel_size=occ_labels.voxel_size,
        centers=np.stack(centers),
        sizes=np.stack(sizes),
        yaws=np.asarray(yaws),
        semantic_ids=np.asarray(source_class_id_values, dtype=np.int64),
        margin=box_paint_margin,
    )
    return OccLabels(
        semantics=semantics,
        mask_lidar=occ_labels.mask_lidar,
        mask_camera=occ_labels.mask_camera,
        occupied=occ_labels.occupied,
        origin=occ_labels.origin,
        voxel_size=occ_labels.voxel_size,
        class_map=occ_labels.class_map,
        prepared_points=occ_labels.prepared_points,
    ), source_class_ids


def _frame_box_visibility(
    annotations: Sequence[Mapping[str, Any]],
    frame: Mapping[str, Any],
    current_frame_points: np.ndarray,
    cameras: Sequence[Mapping[str, object]],
    occupied: np.ndarray,
    occluders: np.ndarray,
    semantics: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    visible_threshold: float,
    free_id: int,
    ground_semantic_ids: set[int],
    timings_ms: MutableMapping[str, float],
) -> Dict[str, Dict[str, Any]]:
    frame_data_id = frame.get("dataId")
    boxes: Dict[str, Dict[str, Any]] = {}
    subject_candidates: np.ndarray | None = None
    for index, annotation in enumerate(annotations):
        if str(annotation.get("dataId")) != str(frame_data_id):
            continue
        attributes = annotation.get("classAttributes")
        if not isinstance(attributes, dict) or attributes.get("type") != "3D_BOX":
            continue
        contour = _mapping_value(attributes.get("contour"), "annotation contour")
        center = _vector3(contour.get("center3D"), "contour.center3D")
        size = _vector3(contour.get("size3D"), "contour.size3D")
        rotation = _vector3(contour.get("rotation3D"), "contour.rotation3D")
        if np.any(size <= 0.0):
            raise ValueError(f"contour.size3D must be positive, got {size.tolist()}")
        object_id = _annotation_object_id(annotation, attributes, index)
        if object_id in boxes:
            raise ValueError(f"duplicate annotation object id: {object_id}")
        if subject_candidates is None:
            subjects_started_at = time.perf_counter()
            subject_candidates = _subject_voxel_centers(
                current_frame_points=current_frame_points,
                occupied=occupied,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=voxel_size,
                free_id=free_id,
                ground_semantic_ids=ground_semantic_ids,
            )
            timings_ms["boxSubjectsBuild"] += _elapsed_ms(subjects_started_at)
        evaluation_started_at = time.perf_counter()
        subjects = subject_candidates[
            _points_inside_box(
                subject_candidates,
                center,
                size + 2.0 * SUBJECT_QUERY_MARGIN,
                rotation,
            )
        ]
        try:
            ratios, maximum = box_visible_ratio(
                cameras=cameras,
                occupied=occluders,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=voxel_size,
                subject_xyz=subjects,
                box_vertices=_box_vertices(center, size, rotation),
            )
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"invalid camera calibration for frame {frame.get('token')!r}, "
                f"box {object_id!r}: {error}"
            ) from error
        boxes[object_id] = {
            "visibleRatio": maximum,
            "visibleRatioByView": {
                str(view_index): float(ratio)
                for view_index, ratio in enumerate(ratios)
            },
            "occluded": maximum <= visible_threshold,
            "autoVisibleRatio": maximum,
            "autoVisibleRatioByView": {
                str(view_index): float(ratio)
                for view_index, ratio in enumerate(ratios)
            },
            "autoOccluded": maximum <= visible_threshold,
        }
        timings_ms["boxEvaluation"] += _elapsed_ms(evaluation_started_at)
    return boxes


def _points_inside_box(
    points: np.ndarray,
    center: np.ndarray,
    size: np.ndarray,
    rotation: np.ndarray,
) -> np.ndarray:
    rx, ry, rz = rotation
    cosine_x, sine_x = np.cos(rx), np.sin(rx)
    cosine_y, sine_y = np.cos(ry), np.sin(ry)
    cosine_z, sine_z = np.cos(rz), np.sin(rz)
    rotation_matrix = np.array(
        [
            [
                cosine_z * cosine_y,
                cosine_z * sine_y * sine_x - sine_z * cosine_x,
                cosine_z * sine_y * cosine_x + sine_z * sine_x,
            ],
            [
                sine_z * cosine_y,
                sine_z * sine_y * sine_x + cosine_z * cosine_x,
                sine_z * sine_y * cosine_x - cosine_z * sine_x,
            ],
            [-sine_y, cosine_y * sine_x, cosine_y * cosine_x],
        ],
        dtype=np.float64,
    )
    local_points = (points - center) @ rotation_matrix
    return np.all(np.abs(local_points) <= size / 2.0, axis=1)


def _box_vertices(
    center: np.ndarray, size: np.ndarray, rotation: np.ndarray
) -> np.ndarray:
    half_size = size / 2.0
    local_vertices = np.asarray(
        [
            [x, y, z]
            for x in (-half_size[0], half_size[0])
            for y in (-half_size[1], half_size[1])
            for z in (-half_size[2], half_size[2])
        ],
        dtype=np.float64,
    )
    rx, ry, rz = rotation
    cosine_x, sine_x = np.cos(rx), np.sin(rx)
    cosine_y, sine_y = np.cos(ry), np.sin(ry)
    cosine_z, sine_z = np.cos(rz), np.sin(rz)
    rotation_matrix = np.array(
        [
            [
                cosine_z * cosine_y,
                cosine_z * sine_y * sine_x - sine_z * cosine_x,
                cosine_z * sine_y * cosine_x + sine_z * sine_x,
            ],
            [
                sine_z * cosine_y,
                sine_z * sine_y * sine_x + cosine_z * cosine_x,
                sine_z * sine_y * sine_x - cosine_z * sine_x,
            ],
            [-sine_y, cosine_y * sine_x, cosine_y * cosine_x],
        ],
        dtype=np.float64,
    )
    return local_vertices @ rotation_matrix.T + center


def _subject_voxel_centers(
    current_frame_points: np.ndarray,
    occupied: np.ndarray,
    semantics: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    free_id: int,
    ground_semantic_ids: set[int],
) -> np.ndarray:
    origin = np.asarray(pc_range[:3], dtype=np.float64)
    shape = np.asarray(occupied.shape, dtype=np.int64)
    point_indices = np.floor(
        (np.asarray(current_frame_points, dtype=np.float64) - origin) / voxel_size
    ).astype(np.int64)
    point_indices = point_indices[
        np.all((point_indices >= 0) & (point_indices < shape), axis=1)
    ]
    semantic_subjects = np.asarray(occupied, dtype=bool) & ~np.isin(
        semantics, np.asarray([free_id, *sorted(ground_semantic_ids)])
    )
    occupied_indices = np.argwhere(semantic_subjects)
    indices = (
        np.unique(np.vstack((point_indices, occupied_indices)), axis=0)
        if point_indices.size or occupied_indices.size
        else np.empty((0, 3), dtype=np.int64)
    )
    return origin + (indices.astype(np.float64) + 0.5) * voxel_size


def _subject_voxels_in_box(
    current_frame_points: np.ndarray,
    occupied: np.ndarray,
    semantics: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    center: np.ndarray,
    size: np.ndarray,
    rotation: np.ndarray,
    free_id: int,
    ground_semantic_ids: set[int],
) -> np.ndarray:
    candidates = _subject_voxel_centers(
        current_frame_points,
        occupied,
        semantics,
        pc_range,
        voxel_size,
        free_id,
        ground_semantic_ids,
    )
    return candidates[
        _points_inside_box(
            candidates,
            center,
            size + 2.0 * SUBJECT_QUERY_MARGIN,
            rotation,
        )
    ]


def _frame_polyline_visibility(
    annotations: Sequence[Mapping[str, Any]],
    frame: Mapping[str, Any],
    current_frame_points: np.ndarray,
    cameras: Sequence[Mapping[str, object]],
    occupied: np.ndarray,
    occluders: np.ndarray,
    semantics: np.ndarray,
    pc_range: Sequence[float],
    voxel_size: float,
    segment_length: float,
    half_width: float,
    slab_height: float,
    slab_visible_ratio: float,
    segment_visible_ratio: float,
    free_id: int,
    ground_semantic_ids: set[int],
) -> Dict[str, Dict[str, Any]]:
    frame_data_id = frame.get("dataId")
    polylines: Dict[str, Dict[str, Any]] = {}
    subjects = _subject_voxel_centers(
        current_frame_points,
        occupied,
        semantics,
        pc_range,
        voxel_size,
        free_id,
        ground_semantic_ids,
    )
    for index, annotation in enumerate(annotations):
        if str(annotation.get("dataId")) != str(frame_data_id):
            continue
        attributes = annotation.get("classAttributes")
        if not isinstance(attributes, dict):
            continue
        annotation_type = attributes.get("type")
        if annotation_type not in {"GROUND_POLYLINE", "IRREGULAR_WALL"}:
            continue
        if _is_parking_annotation(annotation, attributes):
            continue
        contour = _mapping_value(attributes.get("contour"), "annotation contour")
        bottom = _vectors3(contour.get("points"), "contour.points")
        bottom[:, 2] = np.clip(bottom[:, 2], float(pc_range[2]), float(pc_range[5]))
        try:
            top = _polyline_top_points(
                attributes,
                bottom,
                float(pc_range[2]),
                float(pc_range[5]),
            )
        except (TypeError, ValueError):
            continue
        object_id = _annotation_object_id(annotation, attributes, index)
        if object_id in polylines:
            raise ValueError(f"duplicate annotation object id: {object_id}")
        try:
            segments, per_camera, bev = polyline_segment_visibility(
                cameras=cameras,
                occupied=occluders,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=voxel_size,
                points=bottom,
                top_points=top,
                subject_xyz=subjects,
                segment_length=segment_length,
                half_width=half_width,
                slab_height=slab_height,
                slab_visible_ratio=slab_visible_ratio,
                segment_visible_ratio=segment_visible_ratio,
            )
        except (TypeError, ValueError) as error:
            raise ValueError(
                f"invalid camera calibration for frame {frame.get('token')!r}, "
                f"polyline {object_id!r}: {error}"
            ) from error
        by_view = {
            str(view_index): _segment_visibility_entries(visibility)
            for view_index, visibility in enumerate(per_camera)
        }
        by_view["bev"] = _segment_visibility_entries(bev)
        polylines[object_id] = {
            "segmentVisibilityByView": by_view,
            "autoSegmentVisibilityByView": by_view,
            "segmentMeta": {
                "numSegments": len(segments),
                "segmentLength": segment_length,
                "halfWidth": half_width,
                "slabHeight": slab_height,
                "slabVisibleRatio": slab_visible_ratio,
                "segmentVisibleRatio": segment_visible_ratio,
            },
        }
        polylines[object_id]["autoSegmentMeta"] = polylines[object_id][
            "segmentMeta"
        ]
    return polylines


def _is_parking_annotation(
    annotation: Mapping[str, Any], attributes: Mapping[str, Any]
) -> bool:
    names = (
        annotation.get("name"),
        annotation.get("className"),
        attributes.get("name"),
        attributes.get("className"),
    )
    return any(
        isinstance(name, str)
        and name.strip().lower().startswith(("parking", "停车位"))
        for name in names
    )


def _polyline_top_points(
    attributes: Mapping[str, Any],
    bottom: np.ndarray,
    z_min: float,
    z_max: float,
) -> np.ndarray:
    contour = _mapping_value(attributes.get("contour"), "annotation contour")
    raw_top = contour.get("topPoints")
    if raw_top is not None:
        try:
            top = _vectors3(raw_top, "contour.topPoints")
        except (TypeError, ValueError):
            top = np.empty((0, 3), dtype=np.float64)
        if (
            top.shape[0] >= 2
            and np.allclose(top[0, :2], bottom[0, :2], rtol=0.0, atol=1e-6)
            and np.allclose(top[-1, :2], bottom[-1, :2], rtol=0.0, atol=1e-6)
        ):
            top[:, 2] = np.clip(top[:, 2], z_min, z_max)
            return top
    raw_wall_height = attributes.get("wallHeight")
    if raw_wall_height is None:
        raise ValueError("positive wallHeight is required")
    wall_height = _positive_float(raw_wall_height, "annotation wallHeight")
    if wall_height < MIN_POLYLINE_HEIGHT:
        raise ValueError(
            f"annotation wallHeight must meet minimum {MIN_POLYLINE_HEIGHT}, "
            f"got {wall_height}"
        )
    top = bottom + np.array([0.0, 0.0, wall_height])
    top[:, 2] = np.clip(top[:, 2], z_min, z_max)
    if np.any(top[:, 2] - bottom[:, 2] < MIN_POLYLINE_HEIGHT):
        raise ValueError("clipped polyline height is below the minimum")
    return top


def _segment_visibility_entries(
    visibility: np.ndarray,
) -> List[Dict[str, Any]]:
    return [
        {"index": index, "visible": bool(visible)}
        for index, visible in enumerate(visibility)
    ]


def _vector3(value: Any, name: str) -> np.ndarray:
    mapping = _mapping_value(value, name)
    result = np.asarray(
        [mapping.get("x"), mapping.get("y"), mapping.get("z")],
        dtype=np.float64,
    )
    if not np.all(np.isfinite(result)):
        raise ValueError(f"{name} must contain finite x, y, z values")
    return result


def _numeric_vector3(value: Any, name: str) -> np.ndarray:
    if isinstance(value, dict):
        return _vector3(value, name)
    result = np.asarray(value, dtype=np.float64)
    if result.shape != (3,) or not np.all(np.isfinite(result)):
        raise ValueError(f"{name} must contain 3 finite values, got {value}")
    return result


def _vectors3(value: Any, name: str) -> np.ndarray:
    if not isinstance(value, list) or len(value) < 2:
        raise ValueError(f"{name} must contain at least 2 points")
    return np.stack(
        [_vector3(point, f"{name}[{index}]") for index, point in enumerate(value)]
    )


def _annotation_object_id(
    annotation: Mapping[str, Any],
    attributes: Mapping[str, Any],
    index: int,
) -> str:
    del attributes, index
    data_id = annotation.get("dataId")
    object_id = annotation.get("objectId")
    if (
        not isinstance(data_id, (str, int))
        or isinstance(data_id, bool)
        or not str(data_id)
        or not isinstance(object_id, (str, int))
        or isinstance(object_id, bool)
        or not str(object_id)
    ):
        raise ValueError(
            "annotation dataId and objectId must be non-empty strings or integers"
        )
    return f"{data_id}:{object_id}"


def _source_hash(manifest: Mapping[str, Any]) -> str:
    source = manifest.get("source")
    if not isinstance(source, dict):
        return "unknown"
    value = source.get("hash")
    return value if isinstance(value, str) and value else "unknown"


def create_app(object_store: ObjectStore) -> Flask:
    app = Flask(__name__)
    worker_secret = _worker_secret_from_environment()

    def authorized() -> bool:
        provided_secret = request.headers.get(WORKER_SECRET_HEADER, "")
        return compare_digest(provided_secret, worker_secret)

    @app.get("/health")
    def health() -> Any:
        return jsonify({"status": "ok"})

    @app.post("/runs")
    def runs() -> Any:
        if not authorized():
            return jsonify({"error": "worker authentication failed"}), 401
        manifest = request.get_json(silent=True)
        if not isinstance(manifest, dict):
            return jsonify({"error": "request body must be a JSON object"}), 400
        try:
            _validate_manifest(manifest)
            result = run_manifest(manifest, object_store)
        except (TypeError, ValueError) as error:
            return jsonify({"error": str(error)}), 400
        return jsonify(result)

    @app.get("/occ-visualization")
    def occ_visualization() -> Any:
        if not authorized():
            return jsonify({"error": "worker authentication failed"}), 401
        object_key = request.args.get("objectKey", "")
        if not object_key:
            return jsonify({"error": "objectKey must be a non-empty string"}), 400
        try:
            max_voxels = _query_max_voxels(request.args.get("maxVoxels"))
            selection = request.args.get("layer", "semantic")
            (
                labels,
                mask_lidar,
                mask_camera,
                source_class_ids,
                pc_range,
                voxel_size,
            ) = _read_labels_npz(
                object_store.get_bytes(object_key)
            )
            result = build_occ_visualization(
                labels=labels,
                pc_range=pc_range,
                voxel_size=voxel_size,
                max_voxels=max_voxels,
                selection=selection,
                mask_lidar=mask_lidar,
                mask_camera=mask_camera,
                source_class_ids=source_class_ids,
            )
        except KeyError:
            return jsonify({"error": f"object not found: {object_key}"}), 404
        except (TypeError, ValueError) as error:
            return jsonify({"error": str(error)}), 400
        return jsonify(result)

    return app


def _worker_secret_from_environment() -> str:
    worker_secret = os.environ.get("OCC_WORKER_SHARED_SECRET", "")
    if not worker_secret.strip():
        raise RuntimeError("OCC_WORKER_SHARED_SECRET must be non-blank")
    return worker_secret


def _validate_manifest(manifest: Mapping[str, Any]) -> None:
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(f"schemaVersion must be {SCHEMA_VERSION}")
    task_type = _manifest_task_type(manifest)
    algorithm = _required_mapping(manifest, "algorithm")
    if "pcRange" in algorithm:
        pc_range = algorithm["pcRange"]
        if not isinstance(pc_range, (list, tuple)) or len(pc_range) != 6:
            raise ValueError("algorithm.pcRange must contain 6 values")
    if "voxelSize" in algorithm and not isinstance(
        algorithm["voxelSize"], (int, float)
    ):
        raise TypeError("algorithm.voxelSize must be numeric")
    frames = manifest.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError("frames must be a non-empty array")
    selected_data_ids = manifest.get("selectedDataIds")
    if selected_data_ids is not None:
        if not isinstance(selected_data_ids, list) or not selected_data_ids:
            raise ValueError("selectedDataIds must be a non-empty array when provided")
        normalized_selected_ids = {str(data_id) for data_id in selected_data_ids}
        frame_data_ids = {
            _required_string(_mapping_value(frame, "frame"), "dataId")
            for frame in frames
        }
        if not normalized_selected_ids.issubset(frame_data_ids):
            raise ValueError(
                "selectedDataIds must be contained in manifest frame dataId values"
            )
    _required_string(manifest, "outputPrefix")
    if task_type == "VISIBILITY":
        _required_string(manifest, "occOutputPrefix")
        _required_string(manifest, "cameraConfigObjectKey")


def _read_pcd_bytes(content: bytes) -> np.ndarray:
    descriptor, path = tempfile.mkstemp(suffix=".pcd")
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
        return read_pcd_xyz(path)
    finally:
        if os.path.exists(path):
            os.unlink(path)


def _read_labels_npz(
    content: bytes,
) -> Tuple[
    np.ndarray,
    np.ndarray,
    np.ndarray,
    Optional[np.ndarray],
    Sequence[float],
    float,
]:
    with np.load(io.BytesIO(content), allow_pickle=False) as archive:
        if "labels" not in archive:
            raise ValueError("labels.npz must contain a labels array")
        if "mask_lidar" not in archive or "mask_camera" not in archive:
            raise ValueError("labels.npz must contain mask_lidar and mask_camera arrays")
        labels = np.asarray(archive["labels"])
        mask_lidar = np.asarray(archive["mask_lidar"], dtype=bool)
        mask_camera = np.asarray(archive["mask_camera"], dtype=bool)
        source_class_ids = (
            np.asarray(archive["source_class_ids"])
            if "source_class_ids" in archive
            else None
        )
        pc_range = (
            np.asarray(archive["pc_range"], dtype=np.float64).tolist()
            if "pc_range" in archive
            else list(DEFAULT_PC_RANGE)
        )
        voxel_size = (
            float(np.asarray(archive["voxel_size"]).item())
            if "voxel_size" in archive
            else DEFAULT_VOXEL_SIZE
        )
    return labels, mask_lidar, mask_camera, source_class_ids, pc_range, voxel_size


def _query_max_voxels(value: Any) -> int:
    if value is None:
        return DEFAULT_MAX_VOXELS
    try:
        max_voxels = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(
            f"maxVoxels must be a positive integer, got {value}"
        ) from error
    if max_voxels <= 0:
        raise ValueError(f"maxVoxels must be a positive integer, got {value}")
    return max_voxels


def _required_mapping(
    value: Mapping[str, Any], key: str
) -> Mapping[str, Any]:
    return _mapping_value(value.get(key), key)


def _mapping_value(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{name} must be an object")
    return value


def _required_string(value: Mapping[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise ValueError(f"{key} must be a non-empty string")
    return result


def _integer_value(value: Any, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    return value


def _nonnegative_integer(value: Any, name: str) -> int:
    result = _integer_value(value, name)
    if result < 0:
        raise ValueError(f"{name} must be non-negative, got {value}")
    return result


def _boolean_value(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise TypeError(f"{name} must be a boolean")
    return value


def _ratio_value(value: Any, name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise TypeError(f"{name} must be numeric")
    result = float(value)
    if not np.isfinite(result) or result < 0.0 or result > 1.0:
        raise ValueError(f"{name} must be between 0 and 1, got {value}")
    return result


def _positive_float(value: Any, name: str) -> float:
    result = _nonnegative_float(value, name)
    if result <= 0.0:
        raise ValueError(f"{name} must be positive, got {value}")
    return result


def _nonnegative_float(value: Any, name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise TypeError(f"{name} must be numeric")
    result = float(value)
    if not np.isfinite(result) or result < 0.0:
        raise ValueError(f"{name} must be non-negative and finite, got {value}")
    return result


def _object_store_from_environment() -> MinioObjectStore:
    endpoint = os.environ.get("MINIO_ENDPOINT")
    access_key = os.environ.get("MINIO_ACCESS_KEY")
    secret_key = os.environ.get("MINIO_SECRET_KEY")
    bucket = os.environ.get("MINIO_BUCKET")
    missing = [
        name
        for name, value in (
            ("MINIO_ENDPOINT", endpoint),
            ("MINIO_ACCESS_KEY", access_key),
            ("MINIO_SECRET_KEY", secret_key),
            ("MINIO_BUCKET", bucket),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            "missing required environment variables: {}".format(", ".join(missing))
        )
    client = Minio(
        endpoint,
        access_key=access_key,
        secret_key=secret_key,
        secure=os.environ.get("MINIO_SECURE", "false").lower() == "true",
    )
    return MinioObjectStore(client, bucket)


def main() -> None:
    _worker_secret_from_environment()
    app = create_app(_object_store_from_environment())
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8080")),
    )


if __name__ == "__main__":
    main()
