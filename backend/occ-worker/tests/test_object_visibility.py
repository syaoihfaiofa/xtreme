import unittest
from unittest.mock import patch

import numpy as np

from xtreme_occ.object_visibility import (
    _polyline_slab_vertices,
    _slab_fractions,
    box_visible_ratio,
    polyline_bev_visibility,
    polyline_segment_visibility,
    project_subjects,
)
from xtreme_occ.visibility import split_polyline


def _camera() -> dict:
    rotation = np.array(
        [
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
        ]
    )
    camera_origin = np.array([-1.0, 1.5, 1.5])
    return {
        "type": "pinhole",
        "R": rotation,
        "t": -rotation @ camera_origin,
        "fx": 100.0,
        "fy": 100.0,
        "cx": 50.0,
        "cy": 50.0,
        "width": 100,
        "height": 100,
    }


def _fisheye_camera() -> dict:
    return {
        **_camera(),
        "type": "fisheye",
        "k1": 0.0,
        "k2": 0.0,
        "k3": 0.0,
        "k4": 0.0,
    }


class ProjectSubjectsTest(unittest.TestCase):
    def test_projects_subject_inside_image(self) -> None:
        pixels, in_fov = project_subjects(
            _camera(), np.array([[4.5, 1.5, 1.5]])
        )

        np.testing.assert_allclose(pixels, [[50.0, 50.0]])
        np.testing.assert_array_equal(in_fov, [True])

    def test_marks_subject_outside_image_as_not_in_fov(self) -> None:
        _, in_fov = project_subjects(
            _camera(), np.array([[4.5, 5.0, 1.5]])
        )

        np.testing.assert_array_equal(in_fov, [False])

    def test_projects_fisheye_subject_inside_image(self) -> None:
        pixels, in_fov = project_subjects(
            _fisheye_camera(), np.array([[4.5, 1.5, 1.5]])
        )

        np.testing.assert_allclose(pixels, [[50.0, 50.0]])
        np.testing.assert_array_equal(in_fov, [True])

    def test_names_camera_when_projection_calibration_is_invalid(self) -> None:
        camera = _camera()
        camera["name"] = "front"
        camera["R"] = np.eye(2)

        with self.assertRaisesRegex(ValueError, r"camera 'front'.*R"):
            project_subjects(camera, np.array([[4.5, 1.5, 1.5]]))


class BoxVisibleRatioTest(unittest.TestCase):
    def setUp(self) -> None:
        self.pc_range = np.array([0.0, 0.0, 0.0, 6.0, 3.0, 3.0])
        self.occupied = np.zeros((6, 3, 3), dtype=bool)
        self.semantics = np.zeros((6, 3, 3), dtype=np.int16)
        self.subject = np.array([[4.5, 1.5, 1.5]])

    def test_visible_subject_has_full_ratio(self) -> None:
        ratios, maximum = box_visible_ratio(
            [_camera()],
            self.occupied,
            self.semantics,
            self.pc_range,
            1.0,
            self.subject,
        )

        np.testing.assert_allclose(ratios, [1.0])
        self.assertEqual(maximum, 1.0)

    def test_occupied_voxel_in_front_hides_subject(self) -> None:
        self.occupied[2, 1, 1] = True

        ratios, maximum = box_visible_ratio(
            [_camera()],
            self.occupied,
            self.semantics,
            self.pc_range,
            1.0,
            self.subject,
        )

        np.testing.assert_allclose(ratios, [0.0])
        self.assertEqual(maximum, 0.0)

    def test_subject_voxel_does_not_hide_subject(self) -> None:
        self.occupied[4, 1, 1] = True

        ratios, maximum = box_visible_ratio(
            [_camera()],
            self.occupied,
            self.semantics,
            self.pc_range,
            1.0,
            self.subject,
        )

        np.testing.assert_allclose(ratios, [1.0])
        self.assertEqual(maximum, 1.0)

    def test_subject_outside_image_has_zero_ratio(self) -> None:
        outside_subject = np.array([[4.5, 5.0, 1.5]])

        ratios, maximum = box_visible_ratio(
            [_camera()],
            self.occupied,
            self.semantics,
            self.pc_range,
            1.0,
            outside_subject,
        )

        np.testing.assert_allclose(ratios, [0.0])
        self.assertEqual(maximum, 0.0)

    def test_uses_projected_subject_disk_area_over_box_hull(self) -> None:
        subject = np.array([[4.5, 1.5, 1.5]])
        box_vertices = np.array(
            [
                [4.0, 1.0, 1.0],
                [4.0, 1.0, 2.0],
                [4.0, 2.0, 1.0],
                [4.0, 2.0, 2.0],
                [5.0, 1.0, 1.0],
                [5.0, 1.0, 2.0],
                [5.0, 2.0, 1.0],
                [5.0, 2.0, 2.0],
            ]
        )

        ratios, maximum = box_visible_ratio(
            [_camera()],
            self.occupied,
            self.semantics,
            self.pc_range,
            1.0,
            subject,
            box_vertices,
        )

        self.assertGreater(ratios[0], 0.0)
        self.assertLessEqual(ratios[0], 1.0)
        self.assertEqual(ratios[0], maximum)

    def test_sampled_ray_occluder_hides_subject(self) -> None:
        self.occupied[2, 1, 1] = True

        ratios, maximum = box_visible_ratio(
            [_camera()],
            self.occupied,
            self.semantics,
            self.pc_range,
            1.0,
            self.subject,
            np.array(
                [
                    [4.0, 1.0, 1.0],
                    [4.0, 1.0, 2.0],
                    [4.0, 2.0, 1.0],
                    [4.0, 2.0, 2.0],
                    [5.0, 1.0, 1.0],
                    [5.0, 1.0, 2.0],
                    [5.0, 2.0, 1.0],
                    [5.0, 2.0, 2.0],
                ]
            ),
        )

        np.testing.assert_allclose(ratios, [0.0])
        self.assertEqual(maximum, 0.0)

    def test_fisheye_subject_voxel_is_carved_out_before_occlusion(self) -> None:
        self.occupied[4, 1, 1] = True

        ratios, maximum = box_visible_ratio(
            [_fisheye_camera()],
            self.occupied,
            self.semantics,
            self.pc_range,
            1.0,
            self.subject,
            np.array(
                [
                    [4.0, 1.0, 1.0],
                    [4.0, 1.0, 2.0],
                    [4.0, 2.0, 1.0],
                    [4.0, 2.0, 2.0],
                    [5.0, 1.0, 1.0],
                    [5.0, 1.0, 2.0],
                    [5.0, 2.0, 1.0],
                    [5.0, 2.0, 2.0],
                ]
            ),
        )

        self.assertGreater(ratios[0], 0.0)
        self.assertEqual(ratios[0], maximum)

    def test_fisheye_ray_uses_horizon_48_sample_fractions(self) -> None:
        with patch(
            "xtreme_occ.object_visibility.np.linspace", wraps=np.linspace
        ) as linspace:
            box_visible_ratio(
                [_fisheye_camera()],
                self.occupied,
                self.semantics,
                self.pc_range,
                1.0,
                self.subject,
            )

        self.assertIn(
            ((0.02, 0.92, 48), {"dtype": np.float64}),
            [(call.args, call.kwargs) for call in linspace.call_args_list],
        )


class PolylineSegmentVisibilityTest(unittest.TestCase):
    def test_merges_short_bev_tail_into_preceding_segment(self) -> None:
        segments = split_polyline(
            np.array([[0.0, 0.0, 0.0], [0.45, 0.0, 0.0]]),
            0.2,
        )

        lengths = [
            float(np.linalg.norm(end[:2] - start[:2]))
            for start, end in segments
        ]

        np.testing.assert_allclose(lengths, [0.2, 0.25])

    def test_merges_short_vertical_tail_into_preceding_slab(self) -> None:
        np.testing.assert_allclose(
            _slab_fractions(0.65, 0.3),
            [0.0, 0.3 / 0.65, 1.0],
        )

    def test_interpolates_unequal_top_points_at_non_uniform_arc_length_cut(self) -> None:
        voxel_size = 0.1
        pc_range = np.array([0.0, 0.0, 0.0, 4.0, 4.0, 2.0])
        occupied = np.zeros((40, 40, 20), dtype=bool)
        semantics = np.zeros_like(occupied, dtype=np.int16)
        bottom_points = np.array(
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 3.0, 0.0]]
        )
        top_points = np.array(
            [
                [0.0, 0.0, 0.2],
                [0.25, 0.0, 0.3],
                [1.0, 0.0, 0.5],
                [1.0, 3.0, 1.1],
            ]
        )
        subjects = np.array([[0.2, 0.0, 0.1], [1.0, 2.0, 0.1]])

        with (
            patch(
                "xtreme_occ.object_visibility.box_visible_ratio",
                return_value=(np.array([1.0]), 1.0),
            ),
            patch(
                "xtreme_occ.object_visibility._polyline_slab_vertices",
                wraps=_polyline_slab_vertices,
            ) as slab_vertices,
        ):
            polyline_segment_visibility(
                cameras=[_camera()],
                occupied=occupied,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=voxel_size,
                points=bottom_points,
                top_points=top_points,
                subject_xyz=subjects,
                segment_length=2.0,
                half_width=0.15,
                slab_height=2.0,
                slab_visible_ratio=0.1,
                segment_visible_ratio=0.8,
            )

        interpolated_cut = slab_vertices.call_args_list[0].args[3]
        np.testing.assert_allclose(interpolated_cut, [1.0, 1.0, 0.7])
        self.assertFalse(np.allclose(interpolated_cut, top_points[1]))
        self.assertFalse(np.allclose(interpolated_cut, top_points[2]))

    def test_uses_strict_slab_and_segment_visibility_thresholds(self) -> None:
        voxel_size = 0.1
        pc_range = np.array([0.0, 0.0, 0.0, 6.0, 3.0, 3.0])
        occupied = np.zeros((60, 30, 30), dtype=bool)
        semantics = np.zeros_like(occupied, dtype=np.int16)
        subjects = np.array(
            [[4.5, 1.5, 0.05], [4.5, 1.5, 0.15], [4.5, 1.5, 0.25]]
        )

        with patch(
            "xtreme_occ.object_visibility.box_visible_ratio",
            return_value=(np.array([0.1]), 0.1),
        ):
            _, per_camera, _ = polyline_segment_visibility(
                cameras=[_fisheye_camera()],
                occupied=occupied,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=voxel_size,
                points=np.array([[4.5, 1.5, 0.0], [4.7, 1.5, 0.0]]),
                top_points=np.array([[4.5, 1.5, 0.3], [4.7, 1.5, 0.3]]),
                subject_xyz=subjects,
                segment_length=0.2,
                half_width=0.15,
                slab_height=0.3,
                slab_visible_ratio=0.1,
                segment_visible_ratio=0.8,
            )

        np.testing.assert_array_equal(per_camera, [[False]])

    def test_rejects_segment_at_exact_visible_slab_threshold(self) -> None:
        voxel_size = 0.1
        pc_range = np.array([0.0, 0.0, 0.0, 6.0, 3.0, 3.0])
        occupied = np.zeros((60, 30, 30), dtype=bool)
        semantics = np.zeros_like(occupied, dtype=np.int16)
        subjects = np.array(
            [[4.5, 1.5, z] for z in (0.15, 0.45, 0.75, 1.05, 1.35)]
        )

        with patch(
            "xtreme_occ.object_visibility.box_visible_ratio",
            side_effect=[
                (np.array([1.0]), 1.0),
                (np.array([1.0]), 1.0),
                (np.array([1.0]), 1.0),
                (np.array([1.0]), 1.0),
                (np.array([0.0]), 0.0),
            ],
        ):
            _, per_camera, _ = polyline_segment_visibility(
                cameras=[_fisheye_camera()],
                occupied=occupied,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=voxel_size,
                points=np.array([[4.5, 1.5, 0.0], [4.7, 1.5, 0.0]]),
                top_points=np.array([[4.5, 1.5, 1.5], [4.7, 1.5, 1.5]]),
                subject_xyz=subjects,
                segment_length=0.2,
                half_width=0.15,
                slab_height=0.3,
                slab_visible_ratio=0.1,
                segment_visible_ratio=0.8,
            )

        np.testing.assert_array_equal(per_camera, [[False]])

    def test_carves_all_segment_subjects_before_each_slab_raycast(self) -> None:
        voxel_size = 0.1
        pc_range = np.array([0.0, 0.0, 0.0, 6.0, 3.0, 3.0])
        occupied = np.zeros((60, 30, 30), dtype=bool)
        semantics = np.zeros_like(occupied, dtype=np.int16)
        subjects = np.array([[4.5, 1.5, 0.15], [4.5, 1.5, 0.45]])

        with patch(
            "xtreme_occ.object_visibility.box_visible_ratio",
            return_value=(np.array([1.0]), 1.0),
        ) as visible_ratio:
            polyline_segment_visibility(
                cameras=[_fisheye_camera()],
                occupied=occupied,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=voxel_size,
                points=np.array([[4.5, 1.5, 0.0], [4.7, 1.5, 0.0]]),
                top_points=np.array([[4.5, 1.5, 0.6], [4.7, 1.5, 0.6]]),
                subject_xyz=subjects,
                segment_length=0.2,
                half_width=0.15,
                slab_height=0.3,
                slab_visible_ratio=0.1,
                segment_visible_ratio=0.8,
            )

        self.assertEqual(2, visible_ratio.call_count)
        for call in visible_ratio.call_args_list:
            np.testing.assert_allclose(call.args[7], subjects)

    def test_full_segment_self_carve_prevents_real_cross_slab_occlusion(self) -> None:
        voxel_size = 0.1
        pc_range = np.array([0.0, 0.0, -1.0, 6.0, 3.0, 1.0])
        occupied = np.zeros((60, 30, 20), dtype=bool)
        semantics = np.zeros_like(occupied, dtype=np.int16)
        occupied[25, 15, 12] = True
        occupied[45, 15, 14] = True
        camera = _camera()
        camera_origin = np.array([-1.0, 1.5, -0.1])
        camera["t"] = -camera["R"] @ camera_origin
        upper_slab_subject = np.array([[4.55, 1.5, 0.45]])
        segment_subjects = np.array(
            [[2.55, 1.5, 0.25], [4.55, 1.5, 0.45]]
        )
        upper_slab_vertices = np.array(
            [
                [4.45, 1.35, 0.3],
                [4.45, 1.65, 0.3],
                [4.65, 1.35, 0.3],
                [4.65, 1.65, 0.3],
                [4.45, 1.35, 0.6],
                [4.45, 1.65, 0.6],
                [4.65, 1.35, 0.6],
                [4.65, 1.65, 0.6],
            ]
        )

        without_full_carve, _ = box_visible_ratio(
            [camera],
            occupied,
            semantics,
            pc_range,
            voxel_size,
            upper_slab_subject,
            upper_slab_vertices,
        )
        with_full_carve, _ = box_visible_ratio(
            [camera],
            occupied,
            semantics,
            pc_range,
            voxel_size,
            upper_slab_subject,
            upper_slab_vertices,
            segment_subjects,
        )

        np.testing.assert_allclose(without_full_carve, [0.0])
        self.assertGreater(with_full_carve[0], 0.1)

    def test_fisheye_segment_uses_horizon_ray_sampling(self) -> None:
        voxel_size = 0.1
        pc_range = np.array([0.0, 0.0, 0.0, 6.0, 3.0, 3.0])
        occupied = np.zeros((60, 30, 30), dtype=bool)
        semantics = np.zeros_like(occupied, dtype=np.int16)
        subjects = np.array([[4.5, 1.5, 0.15]])

        with patch(
            "xtreme_occ.object_visibility.np.linspace", wraps=np.linspace
        ) as linspace:
            polyline_segment_visibility(
                cameras=[_fisheye_camera()],
                occupied=occupied,
                semantics=semantics,
                pc_range=pc_range,
                voxel_size=voxel_size,
                points=np.array([[4.4, 1.5, 0.0], [4.6, 1.5, 0.0]]),
                top_points=np.array([[4.4, 1.5, 0.3], [4.6, 1.5, 0.3]]),
                subject_xyz=subjects,
                segment_length=0.2,
                half_width=0.15,
                slab_height=0.3,
                slab_visible_ratio=0.1,
                segment_visible_ratio=0.8,
            )

        self.assertIn(
            ((0.02, 0.92, 48), {"dtype": np.float64}),
            [(call.args, call.kwargs) for call in linspace.call_args_list],
        )

    def test_fisheye_slab_uses_disk_area_over_oriented_hull(self) -> None:
        voxel_size = 0.1
        pc_range = np.array([0.0, 0.0, 0.0, 6.0, 3.0, 3.0])
        occupied = np.zeros((60, 30, 30), dtype=bool)
        semantics = np.zeros_like(occupied, dtype=np.int16)
        occupied[20, 14, 15] = True
        subjects = np.array([[4.5, 1.45, 1.5], [4.5, 1.55, 1.5]])
        slab_vertices = np.array(
            [
                [4.45, 1.44, 1.45],
                [4.45, 1.56, 1.45],
                [4.55, 1.44, 1.45],
                [4.55, 1.56, 1.45],
                [4.45, 1.44, 1.55],
                [4.45, 1.56, 1.55],
                [4.55, 1.44, 1.55],
                [4.55, 1.56, 1.55],
            ]
        )
        count_ratios, _ = box_visible_ratio(
            [_fisheye_camera()],
            occupied,
            semantics,
            pc_range,
            voxel_size,
            subjects,
        )
        area_ratios, _ = box_visible_ratio(
            [_fisheye_camera()],
            occupied,
            semantics,
            pc_range,
            voxel_size,
            subjects,
            slab_vertices,
        )

        _, per_camera, _ = polyline_segment_visibility(
            cameras=[_fisheye_camera()],
            occupied=occupied,
            semantics=semantics,
            pc_range=pc_range,
            voxel_size=voxel_size,
            points=np.array([[4.45, 1.5, 1.45], [4.55, 1.5, 1.45]]),
            top_points=np.array([[4.45, 1.5, 1.55], [4.55, 1.5, 1.55]]),
            subject_xyz=subjects,
            segment_length=0.1,
            half_width=0.06,
            slab_height=0.1,
            slab_visible_ratio=0.75,
            segment_visible_ratio=0.75,
        )

        np.testing.assert_allclose(count_ratios, [0.5])
        np.testing.assert_allclose(area_ratios, [1.0])
        np.testing.assert_array_equal(per_camera, [[True]])


class PolylineBevVisibilityTest(unittest.TestCase):
    def test_splits_polyline_and_combines_camera_visibility(self) -> None:
        segments, bev_visibility = polyline_bev_visibility(
            np.array([[0.0, 0.0, 0.0], [2.0, 0.0, 0.0]]),
            1.0,
            np.array([[False, True], [True, False]]),
        )

        self.assertEqual(len(segments), 2)
        np.testing.assert_array_equal(bev_visibility, [True, True])


if __name__ == "__main__":
    unittest.main()
