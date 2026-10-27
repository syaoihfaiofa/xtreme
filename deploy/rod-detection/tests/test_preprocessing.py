import math
import sys
import unittest
from pathlib import Path

import numpy as np


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))


class PreprocessingTest(unittest.TestCase):
    def test_configured_crop_windows_per_camera(self) -> None:
        from rod_detection.preprocessing import (
            CropWindow,
            crop_window_from_fractions,
            load_crop_windows,
        )

        windows = load_crop_windows(SERVICE_ROOT / "config" / "crop_windows.yaml")

        self.assertEqual(sorted(windows), [0, 1, 2, 3])
        for front_or_side in (0, 1, 3):
            self.assertEqual(
                crop_window_from_fractions(1280, 720, windows[front_or_side]),
                CropWindow(320, 90, 640, 360),
            )
        self.assertEqual(
            crop_window_from_fractions(1280, 720, windows[2]),
            CropWindow(320, 180, 640, 360),
        )

    def test_input_to_image_points_inverts_offset_crop_and_letterbox(self) -> None:
        from rod_detection.preprocessing import (
            CropFractions,
            input_to_image_points,
            preprocess_bgr,
        )

        image = np.zeros((720, 1280, 3), dtype=np.uint8)
        tensor, metadata = preprocess_bgr(
            image, CropFractions(0.25, 0.75, 0.125, 0.625), input_size=512
        )

        self.assertEqual(tensor.shape, (1, 3, 512, 512))
        self.assertEqual((metadata.crop.x0, metadata.crop.y0), (320, 90))
        self.assertEqual(metadata.pad, (0, 112))
        self.assertAlmostEqual(metadata.gain, 0.8)
        image_points = np.asarray(((320.0, 90.0), (960.0, 450.0), (700.0, 400.0)))
        input_points = (
            image_points - np.asarray((metadata.crop.x0, metadata.crop.y0))
        ) * metadata.gain + np.asarray(metadata.pad)
        np.testing.assert_allclose(
            input_to_image_points(input_points, metadata), image_points, atol=1e-9
        )


class GeometryTest(unittest.TestCase):
    def test_fit_rectangle_recovers_rotated_rectangle(self) -> None:
        from rod_detection.geometry import fit_rectangle

        yaw = 0.4
        axis_u = np.asarray((math.cos(yaw), math.sin(yaw)))
        axis_v = np.asarray((-axis_u[1], axis_u[0]))
        center = np.asarray((3.0, -1.0))
        corners = [center + sx * 0.5 * axis_u + sy * 0.2 * axis_v
                   for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
        points = np.asarray(corners[1:] + corners[:1])

        fit_center, length, width, fit_yaw = fit_rectangle(points)

        np.testing.assert_allclose(fit_center, center, atol=1e-9)
        self.assertAlmostEqual(length, 1.0)
        self.assertAlmostEqual(width, 0.4)
        self.assertAlmostEqual(math.sin(2 * (fit_yaw - yaw)), 0.0)

    def test_fit_rectangle_uses_midlines_for_skewed_quad(self) -> None:
        from rod_detection.geometry import fit_rectangle

        points = np.asarray(((0.0, 0.0), (2.0, 0.0), (3.0, 1.0), (1.0, 1.0)))
        center, length, width, yaw = fit_rectangle(points)

        np.testing.assert_allclose(center, (1.5, 0.5), atol=1e-9)
        self.assertAlmostEqual(length, 2.0)
        self.assertAlmostEqual(width, math.sqrt(2.0))
        self.assertAlmostEqual(yaw, 0.0)


if __name__ == "__main__":
    unittest.main()
