import unittest

import numpy as np

from xtreme_occ.visibility import (
    bev_visibility_or,
    build_voxel_grid,
    prepare_voxelized_points,
    ray_occluded,
    raycast_visibility,
    raycast_visibility_profiled,
    split_polyline,
    unique_points_by_voxel,
)


class BuildVoxelGridTest(unittest.TestCase):
    def test_builds_grid_with_point_count_threshold(self) -> None:
        points = np.array(
            [
                [0.1, 0.1, 0.1],
                [0.9, 0.8, 0.7],
                [1.2, 0.1, 0.1],
                [4.0, 0.0, 0.0],
                [np.nan, 0.0, 0.0],
            ],
            dtype=np.float64,
        )

        grid = build_voxel_grid(
            points,
            grid_origin=np.array([0.0, 0.0, 0.0]),
            voxel_size=1.0,
            grid_shape=(4, 2, 2),
            min_points_per_voxel=2,
        )

        expected = np.zeros((4, 2, 2), dtype=bool)
        expected[0, 0, 0] = True
        np.testing.assert_array_equal(grid, expected)


class RayOccludedTest(unittest.TestCase):
    def test_detects_occupied_voxel_between_origin_and_target(self) -> None:
        occupied = np.zeros((5, 3, 3), dtype=bool)
        occupied[2, 1, 1] = True
        targets = np.array([[4.5, 1.5, 1.5], [1.5, 1.5, 1.5]])

        result = ray_occluded(
            occupied,
            grid_origin=np.zeros(3),
            voxel_size=1.0,
            camera_origin=np.array([-1.0, 1.5, 1.5]),
            target_points=targets,
        )

        np.testing.assert_array_equal(result, np.array([True, False]))

    def test_does_not_treat_target_voxel_as_occluder(self) -> None:
        occupied = np.zeros((3, 1, 1), dtype=bool)
        occupied[2, 0, 0] = True

        result = ray_occluded(
            occupied,
            grid_origin=np.zeros(3),
            voxel_size=1.0,
            camera_origin=np.array([-1.0, 0.5, 0.5]),
            target_points=np.array([[2.5, 0.5, 0.5]]),
        )

        self.assertFalse(result[0])


class RaycastVisibilityTest(unittest.TestCase):
    def test_marks_hit_voxel_observed_but_not_free(self) -> None:
        occupied = np.zeros((4, 1, 1), dtype=bool)
        occupied[2, 0, 0] = True

        observed, free = raycast_visibility(
            occupied=occupied,
            grid_origin=np.zeros(3),
            voxel_size=1.0,
            lidar_origin=np.array([-1.0, 0.5, 0.5]),
            target_points=np.array([[3.5, 0.5, 0.5]]),
        )

        np.testing.assert_array_equal(observed[:, 0, 0], [True, True, True, False])
        np.testing.assert_array_equal(free[:, 0, 0], [True, True, False, False])

    def test_deduplicates_points_by_endpoint_voxel_and_keeps_out_of_bounds_points(
        self,
    ) -> None:
        points = np.array(
            [
                [0.1, 0.1, 0.1],
                [0.9, 0.8, 0.7],
                [4.2, 0.1, 0.1],
                [4.8, 0.8, 0.7],
            ],
            dtype=np.float64,
        )

        result = unique_points_by_voxel(
            points,
            pc_range=[0.0, 0.0, 0.0, 4.0, 1.0, 1.0],
            voxel_size=1.0,
        )

        np.testing.assert_array_equal(result, points[[0, 2]])

    def test_prepare_keeps_first_ordered_endpoints_across_int64_voxel_ranges(
        self,
    ) -> None:
        points = np.array(
            [
                [-1.2, 0.2, 0.2],
                [-1.1, 0.9, 0.9],
                [float(1 << 62), 0.1, 0.1],
                [5.2, 0.2, 0.2],
                [5.8, 0.9, 0.9],
                [0.2, 0.2, 0.2],
                [0.9, 0.9, 0.9],
            ],
            dtype=np.float64,
        )

        prepared = prepare_voxelized_points(
            points_xyz=points,
            grid_origin=np.zeros(3),
            voxel_size=1.0,
            grid_shape=(4, 2, 2),
        )

        np.testing.assert_array_equal(
            prepared.raycast_points,
            points[[0, 2, 3, 5]],
        )
        np.testing.assert_array_equal(
            prepared.voxel_indices,
            np.array([[0, 0, 0], [0, 0, 0]], dtype=np.int64),
        )
        self.assertGreaterEqual(prepared.endpoint_deduplicate_ns, 0)

    def test_profiled_raycast_preserves_masks_and_reports_stages(self) -> None:
        occupied = np.zeros((5, 4, 3), dtype=bool)
        occupied[3, 2, 1] = True
        targets = np.array(
            [
                [4.5, 2.5, 1.5],
                [4.5, 0.5, 0.5],
                [4.5, 2.5, 1.5],
            ],
            dtype=np.float64,
        )

        expected_observed, expected_free = raycast_visibility(
            occupied=occupied,
            grid_origin=np.zeros(3),
            voxel_size=1.0,
            lidar_origin=np.array([-1.0, 1.5, 1.5]),
            target_points=targets,
        )
        observed, free, profile = raycast_visibility_profiled(
            occupied=occupied,
            grid_origin=np.zeros(3),
            voxel_size=1.0,
            lidar_origin=np.array([-1.0, 1.5, 1.5]),
            target_points=targets,
        )

        np.testing.assert_array_equal(observed, expected_observed)
        np.testing.assert_array_equal(free, expected_free)
        self.assertEqual(profile.input_ray_count, len(targets))
        self.assertEqual(profile.unique_ray_count, 2)
        self.assertEqual(profile.traced_ray_count, 2)
        self.assertGreaterEqual(profile.deduplicate_ns, 0)
        self.assertGreaterEqual(profile.sample_ns, 0)
        self.assertGreater(profile.kernel_ns, 0)

    def test_profiled_raycast_reports_pre_sampling_unique_ray_count(self) -> None:
        occupied = np.zeros((5, 1, 1), dtype=bool)
        targets = np.array(
            [[0.5, 0.5, 0.5], [1.5, 0.5, 0.5], [2.5, 0.5, 0.5]],
            dtype=np.float64,
        )

        _, _, profile = raycast_visibility_profiled(
            occupied=occupied,
            grid_origin=np.zeros(3),
            voxel_size=1.0,
            lidar_origin=np.array([-1.0, 0.5, 0.5]),
            target_points=targets,
            max_rays=2,
            seed=7,
        )

        self.assertEqual(profile.input_ray_count, 3)
        self.assertEqual(profile.unique_ray_count, 3)
        self.assertEqual(profile.traced_ray_count, 2)

    def test_prepared_raycast_matches_legacy_with_out_of_bounds_duplicates(self) -> None:
        occupied = np.zeros((4, 2, 2), dtype=bool)
        occupied[2, 1, 1] = True
        targets = np.array(
            [
                [0.1, 0.1, 0.1],
                [0.9, 0.9, 0.9],
                [3.5, 1.5, 1.5],
                [4.5, 1.5, 1.5],
                [4.8, 1.8, 1.8],
            ],
            dtype=np.float64,
        )
        origin = np.zeros(3)
        legacy_observed, legacy_free, legacy_profile = raycast_visibility_profiled(
            occupied=occupied,
            grid_origin=origin,
            voxel_size=1.0,
            lidar_origin=np.array([-1.0, 0.5, 0.5]),
            target_points=targets,
            max_rays=3,
            seed=19,
        )
        prepared = prepare_voxelized_points(
            points_xyz=targets,
            grid_origin=origin,
            voxel_size=1.0,
            grid_shape=occupied.shape,
        )

        observed, free, profile = raycast_visibility_profiled(
            occupied=occupied,
            grid_origin=origin,
            voxel_size=1.0,
            lidar_origin=np.array([-1.0, 0.5, 0.5]),
            target_points=targets,
            max_rays=3,
            seed=19,
            prepared_points=prepared,
        )

        np.testing.assert_array_equal(observed, legacy_observed)
        np.testing.assert_array_equal(free, legacy_free)
        self.assertEqual(profile.input_ray_count, legacy_profile.input_ray_count)
        self.assertEqual(profile.unique_ray_count, legacy_profile.unique_ray_count)
        self.assertEqual(profile.traced_ray_count, legacy_profile.traced_ray_count)
        self.assertEqual(0, profile.deduplicate_ns)


class PolylineHelpersTest(unittest.TestCase):
    def test_splits_polyline_by_bev_arc_length(self) -> None:
        points = np.array(
            [[0.0, 0.0, 0.0], [2.0, 0.0, 2.0], [2.0, 2.0, 4.0]]
        )

        segments = split_polyline(points, segment_length=1.0)

        self.assertEqual(len(segments), 4)
        np.testing.assert_allclose(segments[1][1], [2.0, 0.0, 2.0])
        np.testing.assert_allclose(segments[2][1], [2.0, 1.0, 3.0])

    def test_merges_short_trailing_polyline_segment(self) -> None:
        points = np.array([[0.0, 0.0], [2.4, 0.0]])

        segments = split_polyline(points, segment_length=1.0)

        self.assertEqual(len(segments), 2)
        np.testing.assert_allclose(segments[-1][1], points[-1])

    def test_combines_camera_visibility_for_bev(self) -> None:
        per_camera = np.array(
            [[False, True, False], [True, False, False]], dtype=bool
        )

        result = bev_visibility_or(per_camera)

        np.testing.assert_array_equal(result, np.array([True, True, False]))


if __name__ == "__main__":
    unittest.main()
