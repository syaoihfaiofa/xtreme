import io
import hashlib
import json
import unittest
from pathlib import Path

import numpy as np

from xtreme_occ.worker import run_manifest


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "occ_visibility_golden.json"
PROVENANCE_PATH = (
    Path(__file__).parent / "fixtures" / "occ-visibility-golden-provenance.json"
)
HORIZON_REPOSITORY = "/home/PnP/lxzhu/perceptionoffline"
HORIZON_COMMIT = "445ff833ea145495cd9dd593441b85f1b3ea091a"
HORIZON_REFERENCE_PATHS = (
    "Horizon/v3_8/scripts/docs/prompts_visibility.md",
    "Horizon/v3_8/scripts/configs/bev/xtreme_v1_occ.py",
)
FIXTURE_SHA256 = "c9576f49f5a7c5e429ed0fcba80b8346b60e695863d38ded34a46ef21602e882"


class FakeObjectStore:
    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = dict(objects)

    def get_bytes(self, object_key: str) -> bytes:
        return self.objects[object_key]

    def put_bytes(
        self, object_key: str, content: bytes, immutable: bool = False
    ) -> None:
        if immutable and object_key in self.objects:
            raise FileExistsError(object_key)
        self.objects[object_key] = content


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


class OccVisibilityGoldenTest(unittest.TestCase):
    def test_provenance_matches_fixture_and_reference_constants(self) -> None:
        provenance = json.loads(PROVENANCE_PATH.read_text(encoding="utf-8"))
        reference = provenance["reference"]
        fixture = provenance["fixture"]

        self.assertEqual(HORIZON_REPOSITORY, reference["repository"])
        self.assertEqual(HORIZON_COMMIT, reference["git_commit"])
        self.assertEqual(
            HORIZON_REFERENCE_PATHS,
            tuple(item["path"] for item in reference["files"]),
        )
        self.assertEqual(FIXTURE_SHA256, fixture["sha256"])
        self.assertEqual(
            FIXTURE_SHA256,
            hashlib.sha256(FIXTURE_PATH.read_bytes()).hexdigest(),
        )
        self.assertFalse(provenance["runtime_dependency"])

    def test_pinhole_manifest_matches_future_horizon_contract(self) -> None:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        expected = fixture["future_horizon_contract"]["expected"]
        store = self._store(fixture, "pinhole")

        run_manifest(self._manifest(fixture), store)
        cameras = json.loads(store.objects["input/cameras.json"])["cameras"]
        extrinsics = {
            (
                tuple(np.asarray(camera["R"]).ravel()),
                tuple(camera["t"]),
            )
            for camera in cameras.values()
        }
        self.assertEqual(4, len(extrinsics))

        with np.load(
            io.BytesIO(store.objects["golden/occ/frame-001/labels.npz"]),
            allow_pickle=False,
        ) as archive:
            self.assertEqual(
                {
                    "labels",
                    "semantics",
                    "occupied",
                    "mask_lidar",
                    "mask_camera",
                    "source_class_ids",
                    "pc_range",
                    "voxel_size",
                    "origin",
                    "class_map",
                },
                set(archive.files),
            )
            np.testing.assert_array_equal(
                archive["semantics"], np.asarray(expected["semantics"])
            )
            np.testing.assert_array_equal(
                archive["labels"], np.asarray(expected["semantics"])
            )
            np.testing.assert_array_equal(
                archive["mask_lidar"],
                np.asarray(expected["mask_lidar"], dtype=bool),
            )
            np.testing.assert_array_equal(
                archive["mask_camera"],
                np.asarray(expected["mask_camera"], dtype=bool),
            )

        sidecar = json.loads(store.objects["golden/visibility/frame-001.json"])
        box = sidecar["objects"]["golden-data:101"]
        self.assertEqual(expected["auto"]["box-occupied"]["auto_visible_ratio"], box["visibleRatio"])
        self.assertEqual(
            expected["auto"]["box-occupied"]["auto_visible_ratio"],
            box["autoVisibleRatio"],
        )
        self.assertFalse(box["occluded"])
        self.assertFalse(box["autoOccluded"])
        self.assertEqual(
            expected["auto"]["ground-line"]["auto_visible_segments"],
            [
                item["visible"]
                for item in sidecar["polylines"]["golden-data:202"][
                    "segmentVisibilityByView"
                ]["bev"]
            ],
        )

    def test_fisheye_manifest_matches_future_horizon_contract(self) -> None:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        expected = fixture["future_horizon_contract"]["expected"]

        store = self._store(fixture, "fisheye")
        run_manifest(self._manifest(fixture), store)

        with np.load(
            io.BytesIO(store.objects["golden/occ/frame-001/labels.npz"]),
            allow_pickle=False,
        ) as archive:
            np.testing.assert_array_equal(
                archive["mask_camera"],
                np.asarray(expected["mask_camera"], dtype=bool),
            )

    def test_threshold_equal_to_auto_ratio_is_occluded(self) -> None:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        manifest = self._manifest(fixture)
        manifest["algorithm"]["boxVisibleRatio"] = 1.0
        store = self._store(fixture, "fisheye")

        run_manifest(manifest, store)

        sidecar = json.loads(store.objects["golden/visibility/frame-001.json"])
        visibility = sidecar["objects"]["golden-data:101"]
        self.assertEqual(1.0, visibility["visibleRatio"])
        self.assertEqual(1.0, visibility["autoVisibleRatio"])
        self.assertTrue(visibility["occluded"])
        self.assertTrue(visibility["autoOccluded"])

    def test_four_camera_mask_equals_or_of_camera_ablations(self) -> None:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        all_views_store = self._store(fixture, "pinhole")
        run_manifest(self._manifest(fixture), all_views_store)
        all_views_mask = self._mask_camera(all_views_store)

        ablation_masks = []
        full_camera_config = json.loads(
            all_views_store.objects["input/cameras.json"]
        )["cameras"]
        for selected_name in full_camera_config:
            cameras = {
                name: camera
                if name == selected_name
                else self._disabled_camera(name)
                for name, camera in full_camera_config.items()
            }
            store = self._store(
                fixture,
                "pinhole",
                camera_config=json.dumps({"cameras": cameras}).encode("utf-8"),
            )
            run_manifest(self._manifest(fixture), store)
            ablation_masks.append(self._mask_camera(store))

        np.testing.assert_array_equal(
            all_views_mask,
            np.logical_or.reduce(ablation_masks),
        )

    def test_future_contract_fixture_derives_expected_values(self) -> None:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        contract = fixture["future_horizon_contract"]
        source = contract["input"]
        derivation = contract["derivation"]
        expected = contract["expected"]
        semantics = np.asarray(expected["semantics"])
        mask_lidar = np.asarray(expected["mask_lidar"], dtype=bool)
        mask_camera = np.asarray(expected["mask_camera"], dtype=bool)
        manifest_input = fixture["manifest_input"]
        grid_origin = np.asarray(manifest_input["pc_range"][:3], dtype=np.float64)
        grid_maximum = np.asarray(manifest_input["pc_range"][3:], dtype=np.float64)
        voxel_size = float(manifest_input["voxel_size"])
        lidar_origin = np.asarray(source["lidar_origin"], dtype=np.float64)

        self.assertEqual((3,), lidar_origin.shape)
        self.assertFalse(np.all((lidar_origin >= grid_origin) & (lidar_origin < grid_maximum)))
        self.assertIn("calculate_LiDAR_visibility", contract["reference"]["algorithm"])
        self.assertIn("mask_camera", contract["reference"]["dataset_fields"])
        self.assertTrue(contract["reference"]["url"].startswith("https://"))
        self.assertEqual(
            len(source["labeled_points"]), len(derivation["occupied_voxels"])
        )
        ray_observed_indices: set[tuple[int, int, int]] = set()
        for point, occupied in zip(
            source["labeled_points"], derivation["occupied_voxels"]
        ):
            point_xyz = np.asarray(point["xyz"], dtype=np.float64)
            self.assertTrue(np.all(point_xyz >= grid_origin))
            self.assertTrue(np.all(point_xyz < grid_maximum))
            self.assertGreater(float((point_xyz - lidar_origin) @ (point_xyz - lidar_origin)), 0.0)
            index = tuple(
                np.floor((point_xyz - grid_origin) / voxel_size).astype(np.int64)
            )
            self.assertEqual(occupied["index"], list(index))
            self.assertEqual(point["semantic"], occupied["semantic"])
            self.assertEqual(point["semantic"], semantics[index])
            ray_indices = self._sample_ray_voxel_indices(
                lidar_origin,
                point_xyz,
                grid_origin,
                grid_maximum,
                voxel_size,
            )
            self.assertIn(index, ray_indices)
            ray_observed_indices.update(ray_indices)
        for index in derivation["free_voxels"]:
            self.assertEqual(0, semantics[tuple(index)])
        expected_observed_indices = {
            tuple(index) for index in derivation["mask_lidar_observed_voxels"]
        }
        self.assertEqual(expected_observed_indices, ray_observed_indices)
        self._assert_mask_matches_indices(
            mask_lidar, derivation["mask_lidar_observed_voxels"]
        )
        for index in np.argwhere(~mask_lidar):
            self.assertFalse(mask_lidar[tuple(index)])
        self._assert_mask_matches_indices(
            mask_camera, derivation["mask_camera_observed_voxels"]
        )
        self.assertTrue(
            np.all(semantics[~mask_lidar] == int(source["unknown_id"]))
        )
        threshold = float(derivation["auto_visibility_threshold"])
        for value in expected["auto"].values():
            self.assertEqual(
                value["auto_visible_ratio"] < threshold, value["auto_occluded"]
            )
            self.assertEqual(not value["auto_occluded"], value["auto_visible"])
        self.assertEqual(
            derivation["visible_box_ids"],
            [
                object_id
                for object_id, value in expected["auto"].items()
                if (
                    value.get("auto_visible_ratio") == 1.0
                    and "auto_visible_segments" not in value
                )
            ],
        )
        self.assertEqual(
            derivation["visible_polyline_segments"],
            {
                object_id: value["auto_visible_segments"]
                for object_id, value in expected["auto"].items()
                if "auto_visible_segments" in value
            },
        )

    def _manifest(self, fixture: dict) -> dict:
        box = fixture["annotations"]["box"]
        polyline = fixture["annotations"]["polyline"]
        manifest_input = fixture["manifest_input"]
        return {
            "schemaVersion": "xtreme-occ-run/v1",
            "sceneId": "golden-scene",
            "source": {"hash": "golden-source"},
            "cameraConfigObjectKey": "input/cameras.json",
            "algorithm": {
                "version": "horizon-occ-visibility-golden",
                "pcRange": manifest_input["pc_range"],
                "voxelSize": manifest_input["voxel_size"],
                "freeId": manifest_input["free_id"],
                "generalObjectId": manifest_input["general_object_id"],
                "unknownId": fixture["future_horizon_contract"]["input"]["unknown_id"],
                "lidarOrigin": fixture["future_horizon_contract"]["input"]["lidar_origin"],
                "occVisibility": True,
                "classMap": {"301": 7, "302": 2},
                "groundClassIds": [302],
                "boxPaintMargin": 0.0,
                "polylineSurfaceThickness": 0.0,
                "singleFrame": True,
                "segmentLength": 1.0,
                "halfWidth": 0.25,
                "slabHeight": 0.5,
                "slabVisibleRatio": 1.0,
                "segmentVisibleRatio": 1.0,
            },
            "frames": [
                {
                    "token": "frame-001",
                    "dataId": "golden-data",
                    "pointCloudObjectKey": "input/frame-001.pcd",
                }
            ],
            "annotations": [
                {
                    "dataId": "golden-data",
                    "objectId": 101,
                    "classId": 301,
                    "classAttributes": {
                        "type": "3D_BOX",
                        "trackId": box["id"],
                        "contour": {
                            "center3D": self._vector(box["center"]),
                            "size3D": self._vector(box["size"]),
                            "rotation3D": self._vector(box["rotation"]),
                        },
                    },
                },
                {
                    "dataId": "golden-data",
                    "objectId": 202,
                    "classId": 302,
                    "classAttributes": {
                        "type": "GROUND_POLYLINE",
                        "trackId": polyline["id"],
                        "wallHeight": polyline["wall_height"],
                        "contour": {
                            "points": [
                                self._vector(point) for point in polyline["points"]
                            ]
                        },
                    },
                },
            ],
            "outputPrefix": "golden",
        }

    def _store(
        self,
        fixture: dict,
        camera_type: str,
        camera_config: bytes | None = None,
    ) -> FakeObjectStore:
        points = fixture["manifest_input"]["points"]
        return FakeObjectStore(
            {
                "input/frame-001.pcd": _ascii_pcd([tuple(point) for point in points]),
                "input/cameras.json": camera_config
                or self._camera_config(fixture, camera_type),
            }
        )

    def _camera_config(self, fixture: dict, camera_type: str) -> bytes:
        camera = fixture["cameras"][camera_type]
        return json.dumps(
            {
                "cameras": {
                    name: {
                        **camera,
                        "R": extrinsic["R"],
                        "t": extrinsic["t"],
                    }
                    for name, extrinsic in fixture["camera_extrinsics"].items()
                }
            }
        ).encode("utf-8")

    def _disabled_camera(self, name: str) -> dict:
        return {
            "name": name,
            "type": "pinhole",
            "width": 16,
            "height": 16,
            "fx": 4.0,
            "fy": 4.0,
            "cx": 8.0,
            "cy": 8.0,
            "R": np.eye(3).tolist(),
            "t": [0.0, 0.0, -100.0],
        }

    def _mask_camera(self, store: FakeObjectStore) -> np.ndarray:
        with np.load(
            io.BytesIO(store.objects["golden/occ/frame-001/labels.npz"]),
            allow_pickle=False,
        ) as archive:
            return np.asarray(archive["mask_camera"], dtype=bool)

    def _assert_mask_matches_indices(
        self, mask: np.ndarray, indices: list[list[int]]
    ) -> None:
        expected = np.zeros(mask.shape, dtype=bool)
        expected[tuple(np.asarray(indices).T)] = True
        np.testing.assert_array_equal(expected, mask)

    def _sample_ray_voxel_indices(
        self,
        origin: np.ndarray,
        target: np.ndarray,
        grid_origin: np.ndarray,
        grid_maximum: np.ndarray,
        voxel_size: float,
    ) -> set[tuple[int, int, int]]:
        direction = target - origin
        sample_count = int(np.ceil(np.linalg.norm(direction) / (voxel_size / 4.0)))
        samples = origin + np.linspace(0.0, 1.0, sample_count + 1)[:, None] * direction
        in_bounds = np.all(
            (samples >= grid_origin) & (samples < grid_maximum), axis=1
        )
        indices = np.floor(
            (samples[in_bounds] - grid_origin) / voxel_size
        ).astype(np.int64)
        return {tuple(index) for index in indices}

    def _vector(self, values: list[float]) -> dict[str, float]:
        return {"x": values[0], "y": values[1], "z": values[2]}


if __name__ == "__main__":
    unittest.main()
