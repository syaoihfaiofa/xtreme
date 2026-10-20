import unittest
from unittest import mock

import numpy as np

from xtreme_occ.semantics import (
    generate_occ_labels,
    generate_semantics,
    overlay_box_semantics,
)
from xtreme_occ.visibility import prepare_voxelized_points


class GenerateSemanticsTest(unittest.TestCase):
    def test_prepared_voxels_retain_only_in_bounds_points_and_linear_indices(
        self,
    ) -> None:
        prepared = prepare_voxelized_points(
            points_xyz=np.array(
                [
                    [0.0, 0.0, 0.0],
                    [0.999, 0.999, 0.999],
                    [1.0, 0.0, 0.0],
                    [-0.001, 0.0, 0.0],
                    [np.nan, 0.0, 0.0],
                ]
            ),
            grid_origin=np.array([0.0, 0.0, 0.0]),
            voxel_size=1.0,
            grid_shape=(1, 1, 1),
        )

        np.testing.assert_array_equal(
            prepared.valid_point_mask, np.array([True, True, False, False, False])
        )
        np.testing.assert_array_equal(
            prepared.voxel_indices, np.array([[0, 0, 0], [0, 0, 0]])
        )
        np.testing.assert_array_equal(prepared.linear_indices, np.array([0, 0]))

    def test_occ_labels_reuse_prepared_voxels_for_threshold_and_tie_vote(self) -> None:
        labels = generate_occ_labels(
            points_xyz=np.array(
                [
                    [0.1, 0.1, 0.1],
                    [0.2, 0.2, 0.2],
                    [0.3, 0.3, 0.3],
                    [0.4, 0.4, 0.4],
                    [1.1, 0.1, 0.1],
                    [np.inf, 0.0, 0.0],
                    [2.0, 0.0, 0.0],
                ]
            ),
            semantic_ids=np.array([7, 4, 7, 4, 9, 3, 2], dtype=np.int16),
            pc_range=[0.0, 0.0, 0.0, 2.0, 1.0, 1.0],
            voxel_size=1.0,
            unknown_id=255,
            min_points_per_voxel=2,
            min_neighbors=0,
            class_map={"object": 7},
        )

        np.testing.assert_array_equal(
            labels.occupied[:, 0, 0], np.array([True, False])
        )
        np.testing.assert_array_equal(
            labels.semantics[:, 0, 0], np.array([4, 255], dtype=np.int16)
        )

    def test_empty_points_produce_free_unoccupied_grid(self) -> None:
        semantics, occupied = generate_semantics(
            points_xyz=np.zeros((0, 3), dtype=np.float64),
            semantic_ids=np.zeros((0,), dtype=np.int16),
            pc_range=np.array([0.0, 0.0, 0.0, 2.0, 2.0, 2.0]),
            voxel_size=1.0,
            free_id=9,
        )

        np.testing.assert_array_equal(
            semantics, np.full((2, 2, 2), 9, dtype=np.int16)
        )
        np.testing.assert_array_equal(occupied, np.zeros((2, 2, 2), dtype=bool))

    def test_occupied_voxel_uses_majority_semantic(self) -> None:
        semantics, occupied = generate_semantics(
            points_xyz=np.array(
                [
                    [0.1, 0.1, 0.1],
                    [0.2, 0.2, 0.2],
                    [0.3, 0.3, 0.3],
                    [1.1, 0.1, 0.1],
                    [1.2, 0.2, 0.2],
                ]
            ),
            semantic_ids=np.array([4, 2, 4, 7, 3], dtype=np.int16),
            pc_range=np.array([0.0, 0.0, 0.0, 2.0, 1.0, 1.0]),
            voxel_size=1.0,
            free_id=9,
        )

        self.assertEqual(4, semantics[0, 0, 0])
        self.assertEqual(3, semantics[1, 0, 0])
        np.testing.assert_array_equal(occupied[:, 0, 0], [True, True])

    def test_occ_labels_apply_minimum_points_and_neighbor_cleanup(self) -> None:
        labels = generate_occ_labels(
            points_xyz=np.array(
                [
                    [0.1, 0.1, 0.1],
                    [0.2, 0.2, 0.2],
                    [1.1, 0.1, 0.1],
                    [1.2, 0.2, 0.2],
                    [1.3, 0.3, 0.3],
                ]
            ),
            semantic_ids=np.array([7, 7, 2, 2, 2], dtype=np.int16),
            pc_range=[0.0, 0.0, 0.0, 3.0, 1.0, 1.0],
            voxel_size=1.0,
            unknown_id=255,
            min_points_per_voxel=2,
            min_neighbors=1,
            class_map={"object": 7},
        )

        np.testing.assert_array_equal(
            labels.occupied[:, 0, 0], np.array([True, True, False])
        )
        np.testing.assert_array_equal(
            labels.semantics[:, 0, 0], np.array([7, 2, 255])
        )

    def test_occ_labels_vote_only_final_occupied_voxels_without_rowwise_unique(
        self,
    ) -> None:
        large_semantic_id = np.iinfo(np.int64).max - 7
        points = np.array(
            [
                [0.1, 0.1, 0.1],
                [1.1, 0.1, 0.1],
                [1.2, 0.2, 0.2],
                [2.1, 0.1, 0.1],
                [2.2, 0.2, 0.2],
                [4.1, 0.1, 0.1],
                [4.2, 0.2, 0.2],
            ]
        )
        semantic_ids = np.array(
            [31, large_semantic_id, -9, -9, large_semantic_id, 47, 47],
            dtype=np.int64,
        )

        original_unique = np.unique

        def reject_semantic_pair_unique(
            values: np.ndarray, *args: object, **kwargs: object
        ) -> np.ndarray:
            if (
                kwargs.get("axis") == 0
                and values.ndim == 2
                and values.shape[1] == 2
            ):
                raise AssertionError("row-wise semantic pair unique must not be used")
            return original_unique(values, *args, **kwargs)

        with mock.patch(
            "xtreme_occ.semantics.np.unique",
            side_effect=reject_semantic_pair_unique,
        ):
            labels = generate_occ_labels(
                points_xyz=points,
                semantic_ids=semantic_ids,
                pc_range=[0.0, 0.0, 0.0, 5.0, 1.0, 1.0],
                voxel_size=1.0,
                unknown_id=255,
                min_points_per_voxel=2,
                min_neighbors=1,
                class_map={"object": -9},
            )

        np.testing.assert_array_equal(
            labels.occupied[:, 0, 0],
            np.array([False, True, True, False, False]),
        )
        np.testing.assert_array_equal(
            labels.semantics[:, 0, 0],
            np.array([255, -9, -9, 255, 255], dtype=np.int64),
        )


class OverlayBoxSemanticsTest(unittest.TestCase):
    def test_box_overrides_only_occupied_voxel_centers(self) -> None:
        semantics = np.full((3, 3, 1), 9, dtype=np.int16)
        semantics[1, 0, 0] = 2
        semantics[1, 1, 0] = 2
        occupied = semantics != 9

        result = overlay_box_semantics(
            semantics=semantics,
            occupied=occupied,
            pc_range=np.array([0.0, 0.0, 0.0, 3.0, 3.0, 1.0]),
            voxel_size=1.0,
            centers=np.array([[1.5, 0.5, 0.5]]),
            sizes=np.array([[1.0, 2.0, 1.0]]),
            yaws=np.array([np.pi / 2.0]),
            semantic_ids=np.array([6], dtype=np.int16),
        )

        self.assertEqual(6, result[1, 0, 0])
        self.assertEqual(2, result[1, 1, 0])
        self.assertEqual(9, result[0, 0, 0])
        self.assertEqual(2, semantics[1, 0, 0])

    def test_box_overlay_matches_full_grid_for_rotated_boxes(self) -> None:
        semantics = np.arange(7 * 6 * 5, dtype=np.int16).reshape(7, 6, 5)
        occupied = (semantics % 3) != 0
        pc_range = np.array([-3.5, -3.0, -2.5, 3.5, 3.0, 2.5])
        centers = np.array([[0.4, -0.3, 0.1], [-2.8, 2.4, -2.0]])
        sizes = np.array([[2.2, 1.4, 2.6], [1.1, 1.8, 1.2]])
        yaws = np.array([0.73, -1.11])
        semantic_ids = np.array([41, 42], dtype=np.int16)

        result = overlay_box_semantics(
            semantics,
            occupied,
            pc_range,
            1.0,
            centers,
            sizes,
            yaws,
            semantic_ids,
            margin=0.05,
        )

        expected = semantics.copy()
        x, y, z = [
            pc_range[axis]
            + (np.arange(semantics.shape[axis], dtype=np.float64) + 0.5)
            for axis in range(3)
        ]
        for center, size, yaw, semantic_id in zip(
            centers, sizes, yaws, semantic_ids
        ):
            delta_x = x[:, np.newaxis] - center[0]
            delta_y = y[np.newaxis, :] - center[1]
            cosine = np.cos(yaw)
            sine = np.sin(yaw)
            local_x = cosine * delta_x + sine * delta_y
            local_y = -sine * delta_x + cosine * delta_y
            inside_xy = (
                np.abs(local_x) <= size[0] / 2.0 + 0.05
            ) & (np.abs(local_y) <= size[1] / 2.0 + 0.05)
            inside_z = np.abs(z - center[2]) <= size[2] / 2.0 + 0.05
            inside = (
                inside_xy[:, :, np.newaxis]
                & inside_z[np.newaxis, np.newaxis, :]
            )
            expected[inside & occupied] = semantic_id

        np.testing.assert_array_equal(result, expected)


if __name__ == "__main__":
    unittest.main()
