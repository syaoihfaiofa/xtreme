import unittest

import numpy as np

from xtreme_occ.visualization import build_occ_visualization


class BuildOccVisualizationTest(unittest.TestCase):
    def test_returns_only_nonzero_voxels(self) -> None:
        labels = np.array(
            [
                [[0, 2], [3, 0]],
                [[4, 0], [0, 5]],
            ],
            dtype=np.int16,
        )

        result = build_occ_visualization(
            labels=labels,
            pc_range=[0.0, 0.0, 0.0, 2.0, 2.0, 2.0],
            voxel_size=1.0,
            max_voxels=10,
        )

        self.assertEqual("xtreme-occ-visualization/v1", result["schemaVersion"])
        self.assertEqual(1.0, result["voxelSize"])
        self.assertEqual([0.0, 0.0, 0.0, 2.0, 2.0, 2.0], result["pcRange"])
        self.assertEqual(
            [
                {"x": 0, "y": 0, "z": 1, "semanticId": 2},
                {"x": 0, "y": 1, "z": 0, "semanticId": 3},
                {"x": 1, "y": 0, "z": 0, "semanticId": 4},
                {"x": 1, "y": 1, "z": 1, "semanticId": 5},
            ],
            result["voxels"],
        )

    def test_excludes_unknown_voxels_from_default_visualization(self) -> None:
        labels = np.array([[[0, 255, 1]]], dtype=np.int16)

        result = build_occ_visualization(
            labels=labels,
            pc_range=[0.0, 0.0, 0.0, 1.0, 1.0, 3.0],
            voxel_size=1.0,
            max_voxels=10,
        )

        self.assertEqual(
            [{"x": 0, "y": 0, "z": 2, "semanticId": 1}],
            result["voxels"],
        )

    def test_returns_ray_traversed_voxels_for_lidar_mask(self) -> None:
        labels = np.array([[[0, 255, 2, 0]]], dtype=np.int16)

        result = build_occ_visualization(
            labels=labels,
            pc_range=[0.0, 0.0, 0.0, 1.0, 1.0, 4.0],
            voxel_size=1.0,
            mask_lidar=np.array([[[True, True, True, False]]]),
            selection="lidar-mask",
            max_voxels=10,
        )

        self.assertEqual(
            [
                {"x": 0, "y": 0, "z": 0, "semanticId": 0, "lidarObserved": True},
                {"x": 0, "y": 0, "z": 1, "semanticId": 255, "lidarObserved": True},
                {"x": 0, "y": 0, "z": 2, "semanticId": 2, "lidarObserved": True},
            ],
            result["voxels"],
        )

    def test_filters_requested_semantic_ids_including_zero(self) -> None:
        labels = np.array([[[0, 2, 3, 2]]], dtype=np.int16)

        result = build_occ_visualization(
            labels=labels,
            pc_range=[0.0, 0.0, 0.0, 1.0, 1.0, 4.0],
            voxel_size=1.0,
            semantic_ids=[0, 3],
            max_voxels=10,
        )

        self.assertEqual(
            [
                {"x": 0, "y": 0, "z": 0, "semanticId": 0},
                {"x": 0, "y": 0, "z": 2, "semanticId": 3},
            ],
            result["voxels"],
        )

    def test_includes_lidar_and_camera_mask_for_each_voxel(self) -> None:
        labels = np.array([[[2, 3]]], dtype=np.int16)
        result = build_occ_visualization(
            labels=labels,
            pc_range=[0.0, 0.0, 0.0, 1.0, 1.0, 2.0],
            voxel_size=1.0,
            mask_lidar=np.array([[[True, False]]]),
            mask_camera=np.array([[[False, True]]]),
            max_voxels=10,
        )

        self.assertEqual(
            [
                {
                    "x": 0,
                    "y": 0,
                    "z": 0,
                    "semanticId": 2,
                    "lidarObserved": True,
                    "cameraObserved": False,
                },
                {
                    "x": 0,
                    "y": 0,
                    "z": 1,
                    "semanticId": 3,
                    "lidarObserved": False,
                    "cameraObserved": True,
                },
            ],
            result["voxels"],
        )

    def test_includes_source_class_id_when_available(self) -> None:
        labels = np.array([[[2, 3]]], dtype=np.int16)
        source_class_ids = np.array([[[52, 0]]], dtype=np.int64)

        result = build_occ_visualization(
            labels=labels,
            source_class_ids=source_class_ids,
            pc_range=[0.0, 0.0, 0.0, 1.0, 1.0, 2.0],
            voxel_size=1.0,
            max_voxels=10,
        )

        self.assertEqual(
            [
                {"x": 0, "y": 0, "z": 0, "semanticId": 2, "sourceClassId": 52},
                {"x": 0, "y": 0, "z": 1, "semanticId": 3},
            ],
            result["voxels"],
        )

    def test_downsamples_deterministically_across_selected_voxels(self) -> None:
        labels = np.arange(1, 11, dtype=np.int16).reshape(10, 1, 1)
        arguments = {
            "labels": labels,
            "pc_range": [0.0, 0.0, 0.0, 10.0, 1.0, 1.0],
            "voxel_size": 1.0,
            "max_voxels": 4,
        }

        first = build_occ_visualization(**arguments)
        second = build_occ_visualization(**arguments)

        self.assertEqual(first, second)
        self.assertEqual([0, 3, 6, 9], [voxel["x"] for voxel in first["voxels"]])


if __name__ == "__main__":
    unittest.main()
