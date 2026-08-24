import unittest

from calibration import build_lidar_to_camera


class BuildLidarToCameraTest(unittest.TestCase):
    def test_returns_xtreme_lidar_to_camera_matrix(self) -> None:
        camera_external = [
            [1.0, 0.0, 0.0, 2.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ]

        result = build_lidar_to_camera(camera_external)

        self.assertEqual(result, camera_external)

    def test_rejects_non_matrix_external(self) -> None:
        with self.assertRaisesRegex(ValueError, "16"):
            build_lidar_to_camera([1.0, 2.0])


if __name__ == "__main__":
    unittest.main()
