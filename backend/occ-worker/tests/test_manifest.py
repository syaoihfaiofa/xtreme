import unittest

from xtreme_occ.manifest import build_run_manifest


class BuildRunManifestTest(unittest.TestCase):
    def test_builds_immutable_scene_input_manifest(self) -> None:
        manifest = build_run_manifest(
            run_id=7,
            dataset_id=8,
            scene_id=9,
            source_hash="a" * 64,
            algorithm_version="xtreme-occ-v1",
            frames=[
                {
                    "dataId": "10",
                    "token": "frame-001",
                    "pointCloudObjectKey": "raw/scene-1/frame-001.pcd",
                    "pose": {"x": 1.0, "y": 2.0, "z": 0.0, "yaw": 0.1},
                }
            ],
            selected_data_ids=[10],
            camera_config_object_key="raw/scene-1/camera_config.json",
            output_prefix="visibility/8/9/7",
        )

        self.assertEqual("xtreme-occ-run/v1", manifest["schemaVersion"])
        self.assertEqual(7, manifest["runId"])
        self.assertEqual(8, manifest["datasetId"])
        self.assertEqual("raw/scene-1/frame-001.pcd", manifest["frames"][0]["pointCloudObjectKey"])
        self.assertEqual([10], manifest["selectedDataIds"])
        self.assertEqual("visibility/8/9/7", manifest["outputPrefix"])


if __name__ == "__main__":
    unittest.main()
