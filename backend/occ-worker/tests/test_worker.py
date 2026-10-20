import io
import json
import os
import threading
import time
import unittest
from unittest import mock

import numpy as np

from xtreme_occ.worker import (
    _PointAabbGrid,
    _apply_indexed_polyline_semantic,
    _apply_polyline_semantic,
    _box_vertices,
    _frame_box_visibility,
    _occluder_grid,
    _polyline_top_points,
    _subject_voxel_centers,
    _subject_voxels_in_box,
    _points_near_polyline,
    _transform_points_to_target,
    _validate_manifest,
    box_visible_ratio,
    create_app,
    run_manifest,
)


class FakeObjectStore:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)
        self.writes: list[tuple[str, bytes, bool]] = []

    def get_bytes(self, object_key: str) -> bytes:
        return self.objects[object_key]

    def put_bytes(
        self, object_key: str, content: bytes, immutable: bool = False
    ) -> None:
        if immutable and object_key in self.objects:
            raise FileExistsError(object_key)
        self.objects[object_key] = content
        self.writes.append((object_key, content, immutable))


def _ascii_pcd(points: list[tuple[float, float, float]]) -> bytes:
    rows = "\n".join("{} {} {}".format(*point) for point in points)
    return (
        "# .PCD v0.7\n"
        "VERSION 0.7\n"
        "FIELDS x y z\n"
        "SIZE 4 4 4\n"
        "TYPE F F F\n"
        "COUNT 1 1 1\n"
        f"WIDTH {len(points)}\n"
        "HEIGHT 1\n"
        f"POINTS {len(points)}\n"
        "DATA ascii\n"
        f"{rows}\n"
    ).encode("ascii")


class PolylineSemanticTest(unittest.TestCase):
    def test_candidate_filter_matches_full_polyline_evaluation(self) -> None:
        points = np.array(
            [
                [0.1, 0.0, 0.1],
                [0.9, 0.0, 0.5],
                [1.9, 0.0, 1.1],
                [1.0, 0.4, 0.5],
                [4.0, 4.0, 4.0],
            ]
        )
        bottom = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.2], [2.0, 0.0, 0.4]])
        top = bottom + np.array([0.0, 0.0, 1.0])
        expected = np.zeros(points.shape[0], dtype=np.int64)
        expected[_points_near_polyline(points, bottom, top, 0.15)] = 7
        actual = np.zeros(points.shape[0], dtype=np.int64)

        _apply_polyline_semantic(actual, points, bottom, top, 0.15, 7)

        np.testing.assert_array_equal(actual, expected)

    def test_indexed_polyline_uses_segment_local_grid_candidates(self) -> None:
        segment_count = 64
        bottom = np.column_stack(
            (
                np.arange(segment_count + 1, dtype=np.float64),
                np.zeros(segment_count + 1, dtype=np.float64),
                np.zeros(segment_count + 1, dtype=np.float64),
            )
        )
        top = bottom + np.array([0.0, 0.0, 1.0])
        points = np.vstack(
            (
                np.column_stack(
                    (
                        np.arange(segment_count + 1, dtype=np.float64),
                        np.zeros(segment_count + 1, dtype=np.float64),
                        np.full(segment_count + 1, 0.5),
                    )
                ),
                np.column_stack(
                    (
                        np.arange(segment_count + 1, dtype=np.float64),
                        np.full(segment_count + 1, 0.9),
                        np.full(segment_count + 1, 0.5),
                    )
                ),
            )
        )
        expected = np.zeros(points.shape[0], dtype=np.int64)
        _apply_polyline_semantic(expected, points, bottom, top, 0.1, 7)
        actual = np.zeros(points.shape[0], dtype=np.int64)
        grid = _PointAabbGrid(points, cell_size=1.0)
        candidate_sizes: list[int] = []
        candidate_indices = grid.candidate_indices

        def record_candidate_size(lower: np.ndarray, upper: np.ndarray) -> np.ndarray:
            indices = candidate_indices(lower, upper)
            candidate_sizes.append(indices.size)
            return indices

        with mock.patch.object(
            grid, "candidate_indices", side_effect=record_candidate_size
        ):
            _apply_indexed_polyline_semantic(
                actual, points, grid, bottom, top, 0.1, 7
            )

        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(segment_count, len(candidate_sizes))
        self.assertLess(max(candidate_sizes), points.shape[0])


class PointAabbGridTest(unittest.TestCase):
    def test_returns_all_and_only_points_within_inclusive_aabb(self) -> None:
        points = np.array(
            [
                [-1.0, 0.0, 0.0],
                [0.0, -1.0, 0.0],
                [0.0, 0.0, -1.0],
                [0.0, 0.0, 0.0],
                [1.0, 1.0, 1.0],
                [1.01, 1.0, 1.0],
                [0.5, 1.01, 0.5],
                [0.5, 0.5, 1.01],
            ]
        )
        grid = _PointAabbGrid(points, cell_size=1.0)

        actual = grid.candidate_indices(
            lower=np.array([0.0, 0.0, 0.0]),
            upper=np.array([1.0, 1.0, 1.0]),
        )

        np.testing.assert_array_equal(actual, np.array([3, 4]))


def _manifest() -> dict[str, object]:
    return {
        "schemaVersion": "xtreme-occ-run/v1",
        "algorithm": {
            "version": "test-v1",
            "pcRange": [0.0, 0.0, 0.0, 2.0, 1.0, 1.0],
            "voxelSize": 1.0,
        },
        "frames": [
            {
                "token": "frame-001",
                "pointCloudObjectKey": "input/frame-001.pcd",
            }
        ],
        "outputPrefix": "runs/7",
    }


def _camera_config() -> bytes:
    rotation = [
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
    ]
    camera_origin = np.array([-1.0, 1.5, 1.5])
    translation = (-np.asarray(rotation) @ camera_origin).tolist()
    cameras = {
        name: {
            "type": "pinhole",
            "width": 100,
            "height": 100,
            "fx": 100.0,
            "fy": 100.0,
            "cx": 50.0,
            "cy": 50.0,
            "R": rotation,
            "t": translation,
        }
        for name in (
            "surround_front",
            "surround_left",
            "surround_back",
            "surround_right",
        )
    }
    return json.dumps({"cameras": cameras}).encode("utf-8")


def _polyline_camera_config() -> bytes:
    rotation = [
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
    ]

    def camera(camera_origin: list[float]) -> dict[str, object]:
        translation = (-np.asarray(rotation) @ np.asarray(camera_origin)).tolist()
        return {
            "type": "pinhole",
            "width": 8,
            "height": 8,
            "fx": 100.0,
            "fy": 20.0,
            "cx": 4.0,
            "cy": 4.0,
            "R": rotation,
            "t": translation,
        }

    cameras = {
        "surround_front": camera([-1.0, 0.1, 0.15]),
        "surround_left": camera([-1.0, 0.3, 0.15]),
        "surround_back": camera([-1.0, 5.0, 0.15]),
        "surround_right": camera([-1.0, -5.0, 0.15]),
    }
    return json.dumps({"cameras": cameras}).encode("utf-8")


def _labels_npz(
    labels: np.ndarray,
    pc_range: list[float],
    voxel_size: float,
) -> bytes:
    output = io.BytesIO()
    np.savez_compressed(
        output,
        labels=labels,
        mask_lidar=np.ones_like(labels, dtype=bool),
        mask_camera=np.zeros_like(labels, dtype=bool),
        pc_range=np.asarray(pc_range, dtype=np.float64),
        voxel_size=np.asarray(voxel_size, dtype=np.float64),
    )
    return output.getvalue()


class RunManifestTest(unittest.TestCase):
    def test_validate_manifest_allows_selected_output_frame_with_context_frames(
        self,
    ) -> None:
        manifest = _manifest()
        manifest["frames"] = [
            {
                "dataId": "frame-001",
                "token": "frame-001",
                "pointCloudObjectKey": "input/frame-001.pcd",
            },
            {
                "dataId": "frame-002",
                "token": "frame-002",
                "pointCloudObjectKey": "input/frame-002.pcd",
            },
        ]
        manifest["selectedDataIds"] = ["frame-001"]

        _validate_manifest(manifest)

    def test_polyline_top_points_prioritize_matching_contour_top_points(self) -> None:
        bottom = np.array([[1.0, 2.0, 0.0], [2.0, 2.0, 0.1]])
        attributes = {
            "wallHeight": 0.3,
            "contour": {
                "topPoints": [
                    {"x": 1.0, "y": 2.0, "z": 0.6},
                    {"x": 2.0, "y": 2.0, "z": 0.8},
                ]
            },
        }

        top = _polyline_top_points(attributes, bottom, 0.0, 1.0)

        np.testing.assert_allclose(top[:, 2], [0.6, 0.8])

    def test_polyline_top_points_fall_back_to_positive_wall_height(self) -> None:
        bottom = np.array([[1.0, 2.0, 0.0], [2.0, 2.0, 0.1]])
        attributes = {
            "wallHeight": 0.3,
            "contour": {
                "topPoints": [
                    {"x": 1.0, "y": 2.0, "z": 0.6},
                    {"x": 3.0, "y": 2.0, "z": 0.8},
                ]
            },
        }

        top = _polyline_top_points(attributes, bottom, 0.0, 1.0)

        np.testing.assert_allclose(top[:, 2], [0.3, 0.4])

    def test_polyline_top_points_accepts_unequal_count_without_wall_height(self) -> None:
        bottom = np.array([[1.0, 2.0, 0.0], [3.0, 2.0, 0.0]])
        attributes = {
            "contour": {
                "topPoints": [
                    {"x": 1.0, "y": 2.0, "z": 0.3},
                    {"x": 2.0, "y": 2.5, "z": 0.4},
                    {"x": 3.0, "y": 2.0, "z": 0.5},
                ]
            },
        }

        top = _polyline_top_points(attributes, bottom, 0.0, 1.0)

        self.assertEqual((3, 3), top.shape)
        np.testing.assert_allclose(top[:, 2], [0.3, 0.4, 0.5])

    def test_polyline_top_points_reject_missing_or_too_short_height(self) -> None:
        bottom = np.array([[1.0, 2.0, 0.0], [2.0, 2.0, 0.0]])

        with self.assertRaisesRegex(ValueError, "positive wallHeight"):
            _polyline_top_points({"contour": {}}, bottom, 0.0, 1.0)
        with self.assertRaisesRegex(ValueError, "minimum"):
            _polyline_top_points(
                {"wallHeight": 0.05, "contour": {}}, bottom, 0.0, 1.0
            )

    def test_polyline_top_points_clips_to_occ_z_range(self) -> None:
        bottom = np.array([[1.0, 2.0, -0.2], [2.0, 2.0, -0.1]])

        top = _polyline_top_points(
            {"wallHeight": 1.5, "contour": {}},
            bottom,
            0.0,
            1.0,
        )

        np.testing.assert_allclose(top[:, 2], [1.0, 1.0])

    def test_worker_skips_wall_when_bottom_z_clip_leaves_too_little_height(self) -> None:
        manifest = _manifest()
        manifest["frames"][0]["dataId"] = "10"
        manifest["cameraConfigObjectKey"] = "input/polyline-cameras.json"
        manifest["algorithm"] = {
            "version": "test-v1",
            "pcRange": [0.0, -1.0, 0.0, 4.0, 1.0, 1.0],
            "voxelSize": 0.1,
            "segmentLength": 0.2,
        }
        manifest["annotations"] = [
            {
                "dataId": 10,
                "objectId": 101,
                "classId": 401,
                "classAttributes": {
                    "type": "GROUND_POLYLINE",
                    "trackId": "clipped-wall",
                    "wallHeight": 0.3,
                    "contour": {
                        "points": [
                            {"x": 2.0, "y": 0.0, "z": 0.95},
                            {"x": 2.0, "y": 0.4, "z": 0.95},
                        ]
                    },
                },
            }
        ]
        store = FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd([(2.0, 0.1, 0.95)]),
                "input/polyline-cameras.json": _polyline_camera_config(),
            }
        )

        run_manifest(manifest, store)

        sidecar = json.loads(store.objects["runs/7/visibility/frame-001.json"])
        self.assertNotIn("clipped-wall", sidecar["polylines"])

    def test_aligns_static_points_from_different_ego_poses(self) -> None:
        target_pose = {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0}
        source_pose = {
            "x": 1.0,
            "y": 0.0,
            "z": 0.5,
            "yaw": np.pi / 2.0,
        }

        target_points = _transform_points_to_target(
            np.array([[2.0, 0.0, 1.0]]),
            source_pose=target_pose,
            target_pose=target_pose,
        )
        source_points = _transform_points_to_target(
            np.array([[0.0, -1.0, 0.5]]),
            source_pose=source_pose,
            target_pose=target_pose,
        )

        np.testing.assert_allclose(source_points, target_points, atol=1e-12)

    def test_run_manifest_fuses_neighboring_frames_for_each_target(self) -> None:
        manifest = _manifest()
        manifest["algorithm"]["window"] = 1
        manifest["frames"] = [
            {
                "token": "frame-001",
                "pointCloudObjectKey": "input/frame-001.pcd",
                "pose": {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
            },
            {
                "token": "frame-002",
                "pointCloudObjectKey": "input/frame-002.pcd",
                "pose": {"x": 1.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
            },
        ]
        store = FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)]),
                "input/frame-002.pcd": _ascii_pcd([(0.1, 0.1, 0.1)]),
            }
        )

        run_manifest(manifest, store)

        with np.load(
            io.BytesIO(store.objects["runs/7/occ/frame-001/labels.npz"])
        ) as archive:
            np.testing.assert_array_equal(
                archive["labels"], np.array([[[1]], [[1]]], dtype=np.int64)
            )

    def test_runs_occ_frames_with_two_workers(self) -> None:
        manifest = _manifest()
        manifest["taskType"] = "OCC"
        manifest["algorithm"]["frameWorkers"] = 2
        manifest["algorithm"]["singleFrame"] = True
        manifest["frames"] = [
            {
                "dataId": "frame-001",
                "token": "frame-001",
                "pointCloudObjectKey": "input/frame-001.pcd",
            },
            {
                "dataId": "frame-002",
                "token": "frame-002",
                "pointCloudObjectKey": "input/frame-002.pcd",
            },
        ]
        manifest["selectedDataIds"] = ["frame-001", "frame-002"]
        store = FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)]),
                "input/frame-002.pcd": _ascii_pcd([(0.1, 0.1, 0.1)]),
            }
        )
        active_workers = 0
        maximum_active_workers = 0
        lock = threading.Lock()

        def fused_points(*args: object, **kwargs: object) -> np.ndarray:
            del args, kwargs
            nonlocal active_workers, maximum_active_workers
            with lock:
                active_workers += 1
                maximum_active_workers = max(
                    maximum_active_workers, active_workers
                )
            time.sleep(0.05)
            with lock:
                active_workers -= 1
            return np.array([[0.1, 0.1, 0.1]])

        with mock.patch(
            "xtreme_occ.worker._fused_frame_points", side_effect=fused_points
        ):
            run_manifest(manifest, store)

        self.assertEqual(2, maximum_active_workers)

    def test_single_frame_disables_neighbor_fusion(self) -> None:
        manifest = _manifest()
        manifest["algorithm"]["window"] = 1
        manifest["algorithm"]["singleFrame"] = True
        manifest["frames"] = [
            {
                "token": "frame-001",
                "pointCloudObjectKey": "input/frame-001.pcd",
                "pose": {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
            },
            {
                "token": "frame-002",
                "pointCloudObjectKey": "input/frame-002.pcd",
                "pose": {"x": 1.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
            },
        ]
        store = FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)]),
                "input/frame-002.pcd": _ascii_pcd([(0.1, 0.1, 0.1)]),
            }
        )

        run_manifest(manifest, store)

        with np.load(
            io.BytesIO(store.objects["runs/7/occ/frame-001/labels.npz"])
        ) as archive:
            np.testing.assert_array_equal(
                archive["labels"], np.array([[[1]], [[0]]], dtype=np.int64)
            )

    def test_writes_default_semantics_and_immutable_manifest(self) -> None:
        manifest = _manifest()
        store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )

        result = run_manifest(manifest, store)

        self.assertEqual("runs/7/manifest.json", result["manifestObjectKey"])
        self.assertEqual(1, result["frameCount"])
        self.assertTrue(
            {
                "pointCloudFusionRead",
                "voxelization",
                "pointSemantics",
                "occLabelGeneration",
                "boxSemanticOverlay",
                "lidarMask",
                "cameraFovMask",
                "write",
            }.issubset(result["timingsMs"])
        )
        self.assertTrue(
            all(
                value >= 0
                for value in result["timingsMs"].values()
                if isinstance(value, float)
            )
        )
        with np.load(io.BytesIO(store.objects["runs/7/occ/frame-001/labels.npz"])) as labels:
            np.testing.assert_array_equal(
                labels["labels"], np.array([[[1]], [[0]]], dtype=np.int64)
            )
        written_manifest = json.loads(store.objects["runs/7/manifest.json"])
        self.assertEqual(manifest, written_manifest)
        self.assertTrue(store.writes[-1][2])

    def test_lidar_mask_timings_include_raycast_profile(self) -> None:
        manifest = _manifest()
        store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )

        result = run_manifest(manifest, store)

        timings = result["timingsMs"]
        self.assertEqual(
            {
                "lidarMaskInputRayCount",
                "lidarMaskUniqueRayCount",
                "lidarMaskTracedRayCount",
                "lidarMaskEndpointDeduplicateMs",
                "lidarMaskDeduplicateMs",
                "lidarMaskSampleMs",
                "lidarMaskSetupMs",
                "lidarMaskKernelMs",
            },
            {
                name
                for name in timings
                if name.startswith("lidarMask") and name != "lidarMask"
            },
        )
        self.assertEqual(1.0, timings["lidarMaskInputRayCount"])
        self.assertEqual(1.0, timings["lidarMaskUniqueRayCount"])
        self.assertEqual(1.0, timings["lidarMaskTracedRayCount"])
        self.assertGreaterEqual(timings["lidarMaskEndpointDeduplicateMs"], 0.0)
        self.assertEqual(0.0, timings["lidarMaskDeduplicateMs"])
        self.assertGreaterEqual(timings["lidarMaskSampleMs"], 0.0)
        self.assertGreaterEqual(timings["lidarMaskSetupMs"], 0.0)
        self.assertGreater(timings["lidarMaskKernelMs"], 0.0)

    def test_occ_task_writes_reusable_labels_without_visibility_sidecar(self) -> None:
        manifest = _manifest()
        manifest["taskType"] = "OCC"
        store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )

        run_manifest(manifest, store)

        with np.load(io.BytesIO(store.objects["runs/7/occ/frame-001/labels.npz"])) as labels:
            self.assertIn("occupied", labels)
            np.testing.assert_array_equal(
                labels["occupied"], np.array([[[True]], [[False]]])
            )
        self.assertNotIn("runs/7/visibility/frame-001.json", store.objects)

    def test_visibility_task_reads_occ_labels_and_writes_only_sidecars(self) -> None:
        occ_manifest = _manifest()
        occ_manifest["taskType"] = "OCC"
        store = FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)]),
                "input/cameras.json": _camera_config(),
            }
        )
        run_manifest(occ_manifest, store)
        visibility_manifest = _manifest()
        visibility_manifest.update(
            {
                "taskType": "VISIBILITY",
                "occOutputPrefix": "runs/7",
                "outputPrefix": "runs/8",
                "cameraConfigObjectKey": "input/cameras.json",
            }
        )

        result = run_manifest(visibility_manifest, store)

        self.assertIsNone(result["manifestObjectKey"])
        self.assertEqual(1, result["frameCount"])
        self.assertEqual(
            {
                "occRead",
                "pointCloudRead",
                "box",
                "boxSubjectsBuild",
                "boxEvaluation",
                "polyline",
                "sidecarWrite",
            },
            set(result["timingsMs"]),
        )
        self.assertTrue(
            all(value >= 0 for value in result["timingsMs"].values())
        )
        self.assertIn("runs/8/visibility/frame-001.json", store.objects)
        self.assertNotIn("runs/8/occ/frame-001/labels.npz", store.objects)
        self.assertNotIn("runs/8/manifest.json", store.objects)

    def test_reuses_identical_immutable_manifest_on_retry(self) -> None:
        manifest = _manifest()
        store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )

        run_manifest(manifest, store)
        result = run_manifest(manifest, store)

        self.assertEqual("runs/7/manifest.json", result["manifestObjectKey"])
        self.assertEqual(1, result["frameCount"])
        self.assertIn("timingsMs", result)

    def test_uses_algorithm_semantic_id_overrides(self) -> None:
        manifest = _manifest()
        manifest["algorithm"]["freeId"] = 8
        manifest["algorithm"]["generalObjectId"] = 9
        store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )

        run_manifest(manifest, store)

        with np.load(io.BytesIO(store.objects["runs/7/occ/frame-001/labels.npz"])) as labels:
            np.testing.assert_array_equal(
                labels["labels"], np.array([[[9]], [[8]]], dtype=np.int64)
            )

    def test_occ_visibility_requires_four_surround_camera_calibrations(self) -> None:
        manifest = _manifest()
        manifest["algorithm"]["occVisibility"] = True
        store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )

        with self.assertRaisesRegex(
            ValueError,
            r"occVisibility requires a non-empty cameraConfigObjectKey.*frame 'frame-001'",
        ):
            run_manifest(manifest, store)

    def test_occ_visibility_reports_missing_camera_config_object(self) -> None:
        manifest = _manifest()
        manifest["algorithm"]["occVisibility"] = True
        manifest["cameraConfigObjectKey"] = "input/missing-cameras.json"
        store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )

        with self.assertRaisesRegex(
            ValueError,
            "cameraConfigObjectKey 'input/missing-cameras.json' .* frame 'frame-001'",
        ):
            run_manifest(manifest, store)

    def test_occluder_grid_excludes_free_and_ground_semantics(self) -> None:
        occupied = np.array([[[True]], [[True]], [[True]]])
        semantics = np.array([[[0]], [[2]], [[7]]])

        np.testing.assert_array_equal(
            _occluder_grid(
                occupied=occupied,
                semantics=semantics,
                free_id=0,
                ground_semantic_ids={2},
            )[:, 0, 0],
            np.array([False, False, True]),
        )

    def test_box_visibility_builds_subjects_once_and_matches_legacy_per_box_results(
        self,
    ) -> None:
        pc_range = [0.0, 0.0, 0.0, 6.0, 3.0, 3.0]
        occupied = np.zeros((6, 3, 3), dtype=bool)
        semantics = np.zeros((6, 3, 3), dtype=np.int16)
        occupied[4, 1, 1] = True
        semantics[4, 1, 1] = 7
        occupied[2, 1, 1] = True
        semantics[2, 1, 1] = 2
        occupied[3, 1, 1] = True
        occluders = _occluder_grid(
            occupied=occupied,
            semantics=semantics,
            free_id=0,
            ground_semantic_ids={2},
        )
        frame = {"dataId": "frame-1", "token": "frame-1"}
        contours = [
            (
                "rotated",
                np.array([4.5, 1.5, 1.5]),
                np.array([1.5, 1.0, 1.0]),
                np.array([0.0, 0.0, np.pi / 4.0]),
            ),
            (
                "ground-and-free",
                np.array([2.5, 1.5, 1.5]),
                np.array([2.0, 1.0, 1.0]),
                np.zeros(3),
            ),
            (
                "empty",
                np.array([0.5, 0.5, 0.5]),
                np.array([0.2, 0.2, 0.2]),
                np.zeros(3),
            ),
        ]
        annotations = [
            {
                "dataId": "frame-1",
                "objectId": object_id,
                "classAttributes": {
                    "type": "3D_BOX",
                    "contour": {
                        "center3D": dict(zip(("x", "y", "z"), center)),
                        "size3D": dict(zip(("x", "y", "z"), size)),
                        "rotation3D": dict(zip(("x", "y", "z"), rotation)),
                    },
                },
            }
            for object_id, center, size, rotation in contours
        ]
        camera = json.loads(_camera_config())["cameras"]["surround_front"]
        points = np.array([[4.5, 1.5, 1.5]])

        legacy = {}
        for object_id, center, size, rotation in contours:
            subjects = _subject_voxels_in_box(
                current_frame_points=points,
                occupied=occupied,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=1.0,
                center=center,
                size=size,
                rotation=rotation,
                free_id=0,
                ground_semantic_ids={2},
            )
            ratios, maximum = box_visible_ratio(
                cameras=[camera],
                occupied=occluders,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=1.0,
                subject_xyz=subjects,
                box_vertices=_box_vertices(center, size, rotation),
            )
            legacy[f"frame-1:{object_id}"] = {
                "visibleRatio": maximum,
                "visibleRatioByView": {"0": float(ratios[0])},
                "occluded": maximum <= 0.2,
                "autoVisibleRatio": maximum,
                "autoVisibleRatioByView": {"0": float(ratios[0])},
                "autoOccluded": maximum <= 0.2,
            }

        with mock.patch(
            "xtreme_occ.worker._subject_voxel_centers",
            wraps=_subject_voxel_centers,
        ) as subject_voxel_centers:
            timings_ms = {"boxSubjectsBuild": 0.0, "boxEvaluation": 0.0}
            actual = _frame_box_visibility(
                annotations=annotations,
                frame=frame,
                current_frame_points=points,
                cameras=[camera],
                occupied=occupied,
                occluders=occluders,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=1.0,
                visible_threshold=0.2,
                free_id=0,
                ground_semantic_ids={2},
                timings_ms=timings_ms,
            )

        self.assertEqual(1, subject_voxel_centers.call_count)
        self.assertEqual(legacy, actual)
        self.assertGreaterEqual(timings_ms["boxSubjectsBuild"], 0.0)
        self.assertGreaterEqual(timings_ms["boxEvaluation"], 0.0)

    def test_writes_box_visibility_from_manifest_annotation_table(self) -> None:
        manifest = _manifest()
        manifest.update(
            {
                "sceneId": 9,
                "source": {"hash": "source-hash"},
                "cameraConfigObjectKey": "input/cameras.json",
                "annotations": [
                    {
                        "dataId": 10,
                        "objectId": 101,
                        "classId": 301,
                        "classAttributes": {
                            "type": "3D_BOX",
                            "trackId": "box-1",
                            "contour": {
                                "center3D": {"x": 4.5, "y": 1.5, "z": 1.5},
                                "size3D": {"x": 1.0, "y": 1.0, "z": 1.0},
                                "rotation3D": {"x": 0.0, "y": 0.0, "z": 0.0},
                            },
                        },
                    },
                    {
                        "dataId": 11,
                        "objectId": 102,
                        "classId": 302,
                        "classAttributes": {
                            "type": "3D_BOX",
                            "trackId": "other-frame-box",
                            "contour": {
                                "center3D": {"x": 4.5, "y": 1.5, "z": 1.5},
                                "size3D": {"x": 1.0, "y": 1.0, "z": 1.0},
                                "rotation3D": {"x": 0.0, "y": 0.0, "z": 0.0},
                            },
                        },
                    },
                ],
            }
        )
        manifest["frames"][0]["dataId"] = "10"
        manifest["algorithm"] = {
            "version": "test-v1",
            "pcRange": [0.0, 0.0, 0.0, 6.0, 3.0, 3.0],
            "voxelSize": 1.0,
            "boxVisibleRatio": 0.2,
        }
        store = FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd([(4.5, 1.5, 1.5)]),
                "input/cameras.json": _camera_config(),
            }
        )

        run_manifest(manifest, store)

        sidecar = json.loads(store.objects["runs/7/visibility/frame-001.json"])
        self.assertEqual("xtreme-visibility/v1", sidecar["schemaVersion"])
        self.assertEqual({"10:101"}, set(sidecar["objects"]))
        self.assertEqual(1.0, sidecar["objects"]["10:101"]["visibleRatio"])
        self.assertEqual(
            {"0": 1.0, "1": 1.0, "2": 1.0, "3": 1.0},
            sidecar["objects"]["10:101"]["visibleRatioByView"],
        )
        self.assertFalse(sidecar["objects"]["10:101"]["occluded"])

    def test_writes_zero_ratio_when_box_has_no_subject_points(self) -> None:
        manifest = _manifest()
        manifest["frames"][0]["dataId"] = "10"
        manifest["cameraConfigObjectKey"] = "input/cameras.json"
        manifest["annotations"] = [
            {
                "dataId": 10,
                "objectId": 103,
                "classId": 301,
                "classAttributes": {
                    "type": "3D_BOX",
                    "trackId": "empty-box",
                    "contour": {
                        "center3D": {"x": 1.5, "y": 0.5, "z": 0.5},
                        "size3D": {"x": 0.2, "y": 0.2, "z": 0.2},
                        "rotation3D": {"x": 0.0, "y": 0.0, "z": 0.0},
                    },
                },
            }
        ]
        store = FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)]),
                "input/cameras.json": _camera_config(),
            }
        )

        run_manifest(manifest, store)

        sidecar = json.loads(store.objects["runs/7/visibility/frame-001.json"])
        self.assertEqual(0.0, sidecar["objects"]["10:103"]["visibleRatio"])
        self.assertEqual(
            {"0": 0.0, "1": 0.0, "2": 0.0, "3": 0.0},
            sidecar["objects"]["10:103"]["visibleRatioByView"],
        )
        self.assertTrue(sidecar["objects"]["10:103"]["occluded"])

    def test_writes_zero_ratio_when_no_cameras_are_configured(self) -> None:
        manifest = _manifest()
        manifest["frames"][0]["dataId"] = "10"
        manifest["annotations"] = [
            {
                "dataId": 10,
                "objectId": 104,
                "classId": 301,
                "classAttributes": {
                    "type": "3D_BOX",
                    "trackId": "box-without-cameras",
                    "contour": {
                        "center3D": {"x": 0.1, "y": 0.1, "z": 0.1},
                        "size3D": {"x": 1.0, "y": 1.0, "z": 1.0},
                        "rotation3D": {"x": 0.0, "y": 0.0, "z": 0.0},
                    },
                },
            }
        ]
        store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )

        run_manifest(manifest, store)

        sidecar = json.loads(store.objects["runs/7/visibility/frame-001.json"])
        visibility = sidecar["objects"]["10:104"]
        self.assertEqual(0.0, visibility["visibleRatio"])
        self.assertEqual({}, visibility["visibleRatioByView"])
        self.assertTrue(visibility["occluded"])

    def test_occ_visibility_rejects_empty_camera_config_with_frame_context(self) -> None:
        manifest = _manifest()
        manifest["algorithm"]["occVisibility"] = True
        manifest["cameraConfigObjectKey"] = ""
        store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )

        with self.assertRaisesRegex(
            ValueError,
            r"occVisibility.*non-empty cameraConfigObjectKey.*frame 'frame-001'",
        ):
            run_manifest(manifest, store)

    def test_occ_visibility_rejects_empty_camera_calibration_object(self) -> None:
        manifest = _manifest()
        manifest["algorithm"]["occVisibility"] = True
        manifest["cameraConfigObjectKey"] = "input/empty-cameras.json"
        store = FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)]),
                "input/empty-cameras.json": b'{"cameras":{}}',
            }
        )

        with self.assertRaisesRegex(
            ValueError,
            r"input/empty-cameras.json.*frame 'frame-001'.*no camera",
        ):
            run_manifest(manifest, store)

    def test_writes_multicamera_polyline_visibility_with_bev_or(self) -> None:
        manifest = _manifest()
        manifest["frames"][0]["dataId"] = "10"
        manifest["cameraConfigObjectKey"] = "input/polyline-cameras.json"
        manifest["algorithm"] = {
            "version": "test-v1",
            "pcRange": [0.0, -1.0, 0.0, 4.0, 1.0, 1.0],
            "voxelSize": 0.1,
            "segmentLength": 0.2,
            "halfWidth": 0.15,
            "slabHeight": 0.3,
            "slabVisibleRatio": 0.1,
            "segmentVisibleRatio": 0.8,
        }
        manifest["annotations"] = [
            {
                "dataId": 10,
                "objectId": 201,
                "classId": 401,
                "classAttributes": {
                    "type": "GROUND_POLYLINE",
                    "trackId": "wall-1",
                    "wallHeight": 0.3,
                    "contour": {
                        "points": [
                            {"x": 2.0, "y": 0.0, "z": 0.0},
                            {"x": 2.0, "y": 0.4, "z": 0.0},
                        ]
                    },
                },
            },
            {
                "dataId": 10,
                "objectId": 202,
                "classId": 402,
                "classAttributes": {
                    "type": "GROUND_POLYLINE",
                    "trackId": "empty-wall",
                    "wallHeight": 0.3,
                    "contour": {
                        "points": [
                            {"x": 2.0, "y": 0.6, "z": 0.0},
                            {"x": 2.0, "y": 0.8, "z": 0.0},
                        ]
                    },
                },
            },
            {
                "dataId": 10,
                "objectId": 203,
                "classId": 403,
                "classAttributes": {
                    "type": "IRREGULAR_WALL",
                    "trackId": "irregular-wall",
                    "contour": {
                        "points": [
                            {"x": 2.0, "y": 0.0, "z": 0.0},
                            {"x": 2.0, "y": 0.4, "z": 0.0},
                        ],
                        "topPoints": [
                            {"x": 2.0, "y": 0.0, "z": 0.3},
                            {"x": 2.0, "y": 0.4, "z": 0.3},
                        ],
                    },
                },
            },
            {
                "dataId": 10,
                "objectId": 204,
                "classId": 404,
                "className": "ParkingSlotBoundary",
                "classAttributes": {
                    "type": "GROUND_POLYLINE",
                    "trackId": "parking-slot",
                    "wallHeight": 0.3,
                    "contour": {
                        "points": [
                            {"x": 2.0, "y": 0.0, "z": 0.0},
                            {"x": 2.0, "y": 0.4, "z": 0.0},
                        ]
                    },
                },
            },
            {
                "dataId": 10,
                "objectId": 205,
                "classId": 405,
                "classAttributes": {
                    "type": "IRREGULAR_WALL",
                    "trackId": "unequal-top",
                    "contour": {
                        "points": [
                            {"x": 2.0, "y": 0.0, "z": 0.0},
                            {"x": 2.0, "y": 0.4, "z": 0.0},
                        ],
                        "topPoints": [
                            {"x": 2.0, "y": 0.0, "z": 0.3},
                            {"x": 2.0, "y": 0.2, "z": 0.4},
                            {"x": 2.0, "y": 0.4, "z": 0.3},
                        ],
                    },
                },
            },
        ]
        annotations_before = json.loads(json.dumps(manifest["annotations"]))
        store = FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd(
                    [(2.0, 0.1, 0.15), (2.0, 0.3, 0.15)]
                ),
                "input/polyline-cameras.json": _polyline_camera_config(),
            }
        )

        run_manifest(manifest, store)

        sidecar = json.loads(store.objects["runs/7/visibility/frame-001.json"])
        wall = sidecar["polylines"]["10:201"]
        self.assertEqual(
            [{"index": 0, "visible": True}, {"index": 1, "visible": True}],
            wall["segmentVisibilityByView"]["0"],
        )
        self.assertEqual(
            [{"index": 0, "visible": False}, {"index": 1, "visible": True}],
            wall["segmentVisibilityByView"]["1"],
        )
        self.assertEqual(
            [{"index": 0, "visible": True}, {"index": 1, "visible": True}],
            wall["segmentVisibilityByView"]["bev"],
        )
        self.assertEqual(2, wall["segmentMeta"]["numSegments"])
        self.assertEqual(2, wall["autoSegmentMeta"]["numSegments"])
        self.assertEqual(
            wall["segmentVisibilityByView"],
            wall["autoSegmentVisibilityByView"],
        )
        self.assertNotIn("10:204", sidecar["polylines"])
        self.assertIn("10:205", sidecar["polylines"])
        self.assertEqual(
            [{"index": 0, "visible": True}, {"index": 1, "visible": True}],
            sidecar["polylines"]["10:203"][
                "segmentVisibilityByView"
            ]["bev"],
        )
        self.assertTrue(
            all(
                not item["visible"]
                for items in sidecar["polylines"]["10:202"][
                    "segmentVisibilityByView"
                ].values()
                for item in items
            )
        )
        self.assertEqual(annotations_before, manifest["annotations"])


class WorkerHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = FakeObjectStore(
            {"input/frame-001.pcd": _ascii_pcd([(0.1, 0.1, 0.1)])}
        )
        self.environment = mock.patch.dict(
            os.environ,
            {"OCC_WORKER_SHARED_SECRET": "test-worker-secret"},
        )
        self.environment.start()
        self.client = create_app(self.store).test_client()
        self.client.environ_base["HTTP_X_XTREME_OCC_WORKER_SECRET"] = (
            "test-worker-secret"
        )

    def tearDown(self) -> None:
        self.environment.stop()

    def test_create_app_rejects_missing_or_blank_worker_secret(self) -> None:
        for secret in (None, "", "   "):
            environment = {} if secret is None else {
                "OCC_WORKER_SHARED_SECRET": secret
            }
            with mock.patch.dict(
                os.environ, environment, clear=secret is None
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "OCC_WORKER_SHARED_SECRET must be non-blank"
                ):
                    create_app(self.store)

    def test_health_returns_json(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(200, response.status_code)
        self.assertEqual({"status": "ok"}, response.get_json())

    def test_runs_rejects_missing_or_wrong_worker_secret(self) -> None:
        for secret in (None, "wrong-secret"):
            response = self.client.post(
                "/runs",
                json=_manifest(),
                headers={} if secret is None else {"X-Xtreme-Occ-Worker-Secret": secret},
                environ_overrides={} if secret is not None else {
                    "HTTP_X_XTREME_OCC_WORKER_SECRET": ""
                },
            )

            self.assertEqual(401, response.status_code)

    def test_occ_visualization_rejects_missing_or_wrong_worker_secret(self) -> None:
        for secret in (None, "wrong-secret"):
            response = self.client.get(
                "/occ-visualization",
                query_string={"objectKey": "labels.npz"},
                headers={} if secret is None else {"X-Xtreme-Occ-Worker-Secret": secret},
                environ_overrides={} if secret is not None else {
                    "HTTP_X_XTREME_OCC_WORKER_SECRET": ""
                },
            )

            self.assertEqual(401, response.status_code)

    def test_runs_rejects_wrong_schema_version(self) -> None:
        manifest = _manifest()
        manifest["schemaVersion"] = "wrong"

        response = self.client.post("/runs", json=manifest)

        self.assertEqual(400, response.status_code)
        self.assertIn("schemaVersion", response.get_json()["error"])
        self.assertEqual([], self.store.writes)

    def test_runs_reports_missing_camera_config_object(self) -> None:
        manifest = _manifest()
        manifest["algorithm"]["occVisibility"] = True
        manifest["cameraConfigObjectKey"] = "input/missing-cameras.json"

        response = self.client.post("/runs", json=manifest)

        self.assertEqual(400, response.status_code)
        self.assertIn("input/missing-cameras.json", response.get_json()["error"])
        self.assertIn("frame-001", response.get_json()["error"])

    def test_runs_executes_valid_manifest(self) -> None:
        response = self.client.post("/runs", json=_manifest())

        self.assertEqual(200, response.status_code)
        self.assertEqual(1, response.get_json()["frameCount"])
        self.assertIn("runs/7/occ/frame-001/labels.npz", self.store.objects)

    def test_occ_visualization_reads_labels_from_object_store(self) -> None:
        object_key = "runs/7/occ/frame-001/labels.npz"
        self.store.objects[object_key] = _labels_npz(
            labels=np.array([[[0]], [[2]], [[3]]], dtype=np.int16),
            pc_range=[0.0, 0.0, 0.0, 3.0, 1.0, 1.0],
            voxel_size=1.0,
        )

        response = self.client.get(
            "/occ-visualization",
            query_string={"objectKey": object_key, "maxVoxels": "1"},
        )

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [{
                "x": 1,
                "y": 0,
                "z": 0,
                "semanticId": 2,
                "lidarObserved": True,
                "cameraObserved": False,
            }],
            response.get_json()["voxels"],
        )
        self.assertEqual(
            [0.0, 0.0, 0.0, 3.0, 1.0, 1.0],
            response.get_json()["pcRange"],
        )

    def test_occ_visualization_returns_free_space_for_lidar_mask(self) -> None:
        object_key = "runs/7/occ/frame-001/labels.npz"
        self.store.objects[object_key] = _labels_npz(
            labels=np.array([[[0]], [[255]], [[2]]], dtype=np.int16),
            pc_range=[0.0, 0.0, 0.0, 3.0, 1.0, 1.0],
            voxel_size=1.0,
        )

        response = self.client.get(
            "/occ-visualization",
            query_string={"objectKey": object_key, "layer": "lidar-mask"},
        )

        self.assertEqual(200, response.status_code)
        self.assertEqual(
            [
                {"x": 0, "y": 0, "z": 0, "semanticId": 0, "lidarObserved": True, "cameraObserved": False},
                {"x": 1, "y": 0, "z": 0, "semanticId": 255, "lidarObserved": True, "cameraObserved": False},
                {"x": 2, "y": 0, "z": 0, "semanticId": 2, "lidarObserved": True, "cameraObserved": False},
            ],
            response.get_json()["voxels"],
        )

    def test_occ_visualization_rejects_invalid_max_voxels(self) -> None:
        response = self.client.get(
            "/occ-visualization",
            query_string={"objectKey": "labels.npz", "maxVoxels": "0"},
        )

        self.assertEqual(400, response.status_code)
        self.assertIn("maxVoxels", response.get_json()["error"])
        self.assertEqual([], self.store.writes)


if __name__ == "__main__":
    unittest.main()
