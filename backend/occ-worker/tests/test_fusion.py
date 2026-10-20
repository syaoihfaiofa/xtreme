import unittest
from unittest.mock import patch

import numpy as np

import xtreme_occ.fusion as fusion
from xtreme_occ.fusion import (
    Box3D,
    drop_ego_body_points,
    EgoPose,
    fuse_frame_points,
    fuse_prepared_frame_points,
    prepare_fusion_frames,
)


def _pose() -> EgoPose:
    return EgoPose(translation=np.zeros(3), yaw=0.0)


def _box(identity: str, center_x: float) -> Box3D:
    return Box3D(
        identity=identity,
        center=np.array([center_x, 0.0, 0.0]),
        size=np.array([2.0, 2.0, 2.0]),
        rotation=np.zeros(3),
    )


class Box3DRotationCacheTest(unittest.TestCase):
    def test_calculates_rotation_matrix_once_per_box(self) -> None:
        rotation = np.array([0.1, -0.2, 0.3])
        points = np.array([[0.25, 0.5, -0.75]])

        with patch(
            "xtreme_occ.fusion._rotation_matrix",
            wraps=fusion._rotation_matrix,
        ) as rotation_matrix:
            box = Box3D(
                identity="vehicle-1",
                center=np.zeros(3),
                size=np.array([2.0, 2.0, 2.0]),
                rotation=rotation,
            )
            local_points = fusion._points_to_box_local(points, box)
            restored_points = fusion._box_local_to_points(local_points, box)
            fusion._points_inside_box(restored_points, box)

        self.assertEqual(rotation_matrix.call_count, 1)
        np.testing.assert_allclose(restored_points, points)


class EgoBodyFilterTest(unittest.TestCase):
    def test_drops_points_inside_horizon_ego_range(self) -> None:
        points = np.array(
            [
                [-1.17, -1.2, -0.3],
                [3.8, 1.2, 1.4],
                [-1.18, 0.0, 0.0],
                [0.0, 1.21, 0.0],
                [0.0, 0.0, 1.41],
            ]
        )

        filtered = drop_ego_body_points(points)

        np.testing.assert_array_equal(
            filtered,
            np.array(
                [
                    [-1.18, 0.0, 0.0],
                    [0.0, 1.21, 0.0],
                    [0.0, 0.0, 1.41],
                ]
            ),
        )


class FuseFramePointsTest(unittest.TestCase):
    def test_aligns_moving_object_to_target_box(self) -> None:
        points = [
            np.array([[0.25, 0.0, 0.0]]),
            np.array([[10.25, 0.0, 0.0]]),
        ]
        boxes = [
            {"vehicle-1": _box("vehicle-1", 0.0)},
            {"vehicle-1": _box("vehicle-1", 10.0)},
        ]

        fused = fuse_frame_points(
            point_clouds=points,
            poses=[_pose(), _pose()],
            dynamic_boxes=boxes,
            target_index=1,
            window=1,
            single_frame=False,
        )

        np.testing.assert_allclose(
            fused,
            np.array([[10.25, 0.0, 0.0], [10.25, 0.0, 0.0]]),
        )

    def test_excludes_dynamic_points_without_target_track(self) -> None:
        fused = fuse_frame_points(
            point_clouds=[
                np.array([[0.25, 0.0, 0.0]]),
                np.array([[10.25, 0.0, 0.0]]),
            ],
            poses=[_pose(), _pose()],
            dynamic_boxes=[
                {"vehicle-1": _box("vehicle-1", 0.0)},
                {"vehicle-2": _box("vehicle-2", 10.0)},
            ],
            target_index=1,
            window=1,
            single_frame=False,
        )

        np.testing.assert_allclose(fused, np.array([[10.25, 0.0, 0.0]]))

    def test_keeps_static_points_aligned_by_ego_pose(self) -> None:
        fused = fuse_frame_points(
            point_clouds=[
                np.array([[1.0, 0.0, 0.0]]),
                np.array([[2.0, 0.0, 0.0]]),
            ],
            poses=[
                EgoPose(translation=np.array([1.0, 0.0, 0.0]), yaw=0.0),
                _pose(),
            ],
            dynamic_boxes=[{}, {}],
            target_index=1,
            window=1,
            single_frame=False,
        )

        np.testing.assert_allclose(
            fused,
            np.array([[2.0, 0.0, 0.0], [2.0, 0.0, 0.0]]),
        )

    def test_single_frame_returns_only_target_points(self) -> None:
        target_points = np.array([[10.25, 0.0, 0.0]])

        fused = fuse_frame_points(
            point_clouds=[np.array([[0.25, 0.0, 0.0]]), target_points],
            poses=[],
            dynamic_boxes=[],
            target_index=1,
            window=1,
            single_frame=True,
        )

        np.testing.assert_array_equal(fused, target_points)

    def test_prepared_frames_match_direct_fusion(self) -> None:
        points = [
            np.array([[0.25, 0.0, 0.0], [2.0, 0.0, 0.0]]),
            np.array([[10.25, 0.0, 0.0], [12.0, 0.0, 0.0]]),
        ]
        poses = [_pose(), _pose()]
        boxes = [
            {"vehicle-1": _box("vehicle-1", 0.0)},
            {"vehicle-1": _box("vehicle-1", 10.0)},
        ]

        direct = fuse_frame_points(
            points, poses, boxes, target_index=1, window=1, single_frame=False
        )
        prepared = fuse_prepared_frame_points(
            prepare_fusion_frames(points, poses, boxes),
            poses,
            boxes,
            target_index=1,
            window=1,
            single_frame=False,
        )

        np.testing.assert_array_equal(prepared, direct)


if __name__ == "__main__":
    unittest.main()
