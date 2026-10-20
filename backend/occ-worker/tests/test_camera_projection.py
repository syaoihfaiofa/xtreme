import json
import tempfile
import unittest
from pathlib import Path
from typing import List

import numpy as np

from xtreme_occ.camera_projection import (
    SURROUND_CAMERA_NAMES,
    camera_fov_mask,
    load_surround_cameras,
    project_points,
)


def _camera(camera_type: str) -> dict:
    return {
        "name": "surround_front",
        "type": camera_type,
        "width": 100,
        "height": 80,
        "fx": 20.0,
        "fy": 20.0,
        "cx": 50.0,
        "cy": 40.0,
        "k1": 0.0,
        "k2": 0.0,
        "k3": 0.0,
        "k4": 0.0,
        "R": np.eye(3),
        "t": np.zeros(3),
    }


class ProjectPointsTest(unittest.TestCase):
    def test_projects_pinhole_points_and_checks_image_bounds(self) -> None:
        points = np.array(
            [
                [0.0, 0.0, 2.0],
                [5.0, 0.0, 2.0],
                [0.0, 4.0, 2.0],
                [0.0, 0.0, -2.0],
            ]
        )

        pixels, in_image = project_points(_camera("pinhole"), points)

        np.testing.assert_allclose(
            pixels[:3], [[50.0, 40.0], [100.0, 40.0], [50.0, 80.0]]
        )
        self.assertTrue(np.isnan(pixels[3]).all())
        np.testing.assert_array_equal(in_image, [True, False, False, False])

    def test_projects_fisheye_points_and_checks_image_bounds(self) -> None:
        camera = _camera("fisheye")
        camera["fx"] = 50.0
        camera["fy"] = 50.0
        camera["k1"] = 0.1
        points = np.array(
            [
                [0.0, 0.0, 2.0],
                [2.0, 0.0, 2.0],
                [0.0, 2.0, 0.0],
            ]
        )

        pixels, in_image = project_points(camera, points)

        diagonal_theta = np.pi / 4.0
        diagonal_offset = (
            50.0 * diagonal_theta * (1.0 + 0.1 * diagonal_theta**2)
        )
        side_theta = np.pi / 2.0
        side_offset = 50.0 * side_theta * (1.0 + 0.1 * side_theta**2)
        np.testing.assert_allclose(
            pixels,
            [
                [50.0, 40.0],
                [50.0 + diagonal_offset, 40.0],
                [50.0, 40.0 + side_offset],
            ],
        )
        np.testing.assert_array_equal(in_image, [True, True, False])

    def test_camera_fov_mask_uses_four_distinct_extrinsics(self) -> None:
        cameras = [
            {
                **_camera("pinhole"),
                "name": name,
                "width": 3,
                "height": 3,
                "fx": 1.0,
                "fy": 1.0,
                "cx": 1.0,
                "cy": 1.0,
                "R": rotation,
                "t": translation,
            }
            for name, rotation, translation in (
                ("surround_front", np.eye(3), np.zeros(3)),
                (
                    "surround_left",
                    np.array([[0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]]),
                    np.array([0.0, 0.0, 0.0]),
                ),
                (
                    "surround_back",
                    np.diag([-1.0, 1.0, -1.0]),
                    np.array([0.0, 0.0, 4.0]),
                ),
                (
                    "surround_right",
                    np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]]),
                    np.array([0.0, 0.0, 4.0]),
                ),
            )
        ]

        mask = camera_fov_mask(
            pc_range=[0.0, 0.0, 0.0, 3.0, 1.0, 1.0],
            voxel_size=1.0,
            cameras=cameras,
        )

        np.testing.assert_array_equal(mask[:, 0, 0], [True, True, True])

    def test_camera_fov_mask_limits_result_to_candidate_voxels(self) -> None:
        cameras = [
            {
                **_camera("pinhole"),
                "name": name,
                "width": 3,
                "height": 3,
                "fx": 1.0,
                "fy": 1.0,
                "cx": 1.0,
                "cy": 1.0,
                "R": rotation,
                "t": translation,
            }
            for name, rotation, translation in (
                ("surround_front", np.eye(3), np.zeros(3)),
                ("surround_left", np.eye(3), np.zeros(3)),
                ("surround_back", np.eye(3), np.zeros(3)),
                ("surround_right", np.eye(3), np.zeros(3)),
            )
        ]
        pc_range = [0.0, 0.0, 0.0, 3.0, 3.0, 3.0]
        candidates = np.zeros((3, 3, 3), dtype=bool)
        candidates[0, 0, 0] = True
        candidates[1, 1, 1] = True

        full_mask = camera_fov_mask(pc_range, 1.0, cameras)
        candidate_mask = camera_fov_mask(
            pc_range, 1.0, cameras, candidate_mask=candidates
        )

        np.testing.assert_array_equal(candidate_mask, full_mask & candidates)


class LoadSurroundCamerasTest(unittest.TestCase):
    def test_loads_four_cameras_from_cameras_object(self) -> None:
        cameras = {}
        for index, name in enumerate(SURROUND_CAMERA_NAMES):
            cameras[name] = {
                "type": "pinhole" if index == 0 else "fisheye",
                "width": 100,
                "height": 80,
                "fx": 20.0,
                "fy": 21.0,
                "cx": 50.0,
                "cy": 40.0,
                "k1": 0.1,
                "k2": 0.01,
                "k3": 0.001,
                "k4": 0.0001,
                "rvec": [0.0, 0.0, np.pi / 2.0 if index == 0 else 0.0],
                "tvec": [1.0, 2.0, 3.0],
            }

        loaded = self._load_json({"cameras": cameras})

        self.assertEqual(
            [camera["name"] for camera in loaded],
            list(SURROUND_CAMERA_NAMES),
        )
        self.assertEqual(loaded[0]["type"], "pinhole")
        np.testing.assert_allclose(
            loaded[0]["R"],
            [[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
            atol=1e-12,
        )
        np.testing.assert_allclose(loaded[0]["t"], [1.0, 2.0, 3.0])

    def test_loads_four_cameras_from_flat_list(self) -> None:
        entries = []
        matrix = np.eye(4)
        matrix[:3, 3] = [1.0, 2.0, 3.0]
        for index, name in enumerate(reversed(SURROUND_CAMERA_NAMES)):
            entries.append(
                {
                    "camera_name": name,
                    "type": "pinhole" if index == 0 else "fisheye",
                    "width": 100,
                    "height": 80,
                    "camera_internal": {
                        "fx": 20.0,
                        "fy": 21.0,
                        "cx": 50.0,
                        "cy": 40.0,
                    },
                    "distortion": {"k1": 0.1, "k2": 0.01},
                    "camera_external": matrix.T.reshape(-1).tolist(),
                    "rowMajor": False,
                }
            )

        loaded = self._load_json(entries)

        self.assertEqual(
            [camera["name"] for camera in loaded],
            list(SURROUND_CAMERA_NAMES),
        )
        np.testing.assert_allclose(loaded[0]["R"], np.eye(3))
        np.testing.assert_allclose(loaded[0]["t"], [1.0, 2.0, 3.0])
        self.assertEqual(loaded[-1]["type"], "pinhole")
        self.assertEqual(loaded[0]["k3"], 0.0)

    def test_rejects_config_missing_a_surround_camera(self) -> None:
        cameras = {
            name: {
                "type": "fisheye",
                "width": 100,
                "height": 80,
                "fx": 20.0,
                "fy": 20.0,
                "cx": 50.0,
                "cy": 40.0,
                "rvec": [0.0, 0.0, 0.0],
                "tvec": [0.0, 0.0, 0.0],
            }
            for name in SURROUND_CAMERA_NAMES[:-1]
        }

        with self.assertRaisesRegex(ValueError, "surround_right"):
            self._load_json({"cameras": cameras})

    def _load_json(self, value: object) -> List[dict]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "camera_config.json"
            path.write_text(json.dumps(value), encoding="utf-8")
            return load_surround_cameras(path)


if __name__ == "__main__":
    unittest.main()
