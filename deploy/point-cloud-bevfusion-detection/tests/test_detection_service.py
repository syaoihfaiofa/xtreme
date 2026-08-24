import unittest
import struct
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict

import numpy as np

from detection_service import (
    DetectionInputError,
    _load_pcd_points,
    _to_xtreme_objects,
    parse_camera_configuration,
    validate_detection_request,
)


def camera_config() -> Dict[str, Any]:
    return {
        f"3d_img{index}": {
            "cameraInternal": {
                "fx": 900.0 + index,
                "fy": 901.0 + index,
                "cx": 500.0,
                "cy": 300.0,
            },
            "cameraExternal": [
                1.0, 0.0, 0.0, 0.0,
                0.0, 1.0, 0.0, 0.0,
                0.0, 0.0, 1.0, 0.0,
                float(index), 0.0, 0.0, 1.0,
            ],
            "rowMajor": False,
        }
        for index in range(4)
    }


class DetectionServiceInputTest(unittest.TestCase):
    def test_requires_exactly_four_camera_images(self) -> None:
        with self.assertRaisesRegex(DetectionInputError, "exactly four"):
            validate_detection_request(
                {
                    "id": 1,
                    "pointCloudUrl": "point-cloud.bin",
                    "imageUrls": ["0.jpg", "1.jpg", "2.jpg"],
                    "cameraConfigUrl": "calibration.json",
                }
            )

    def test_parses_column_major_xtreme_camera_configuration(self) -> None:
        cameras = parse_camera_configuration(camera_config())

        self.assertEqual(len(cameras), 4)
        self.assertEqual(cameras[0].lidar_to_camera[0][3], 0.0)
        self.assertEqual(cameras[3].lidar_to_camera[0][3], 3.0)
        self.assertEqual(cameras[0].camera_to_image[0][0], 900.0)

    def test_rejects_camera_configuration_without_all_calibrations(self) -> None:
        config = camera_config()
        config.pop("3d_img3")

        with self.assertRaisesRegex(DetectionInputError, "four camera"):
            parse_camera_configuration(config)

    def test_loads_binary_pcd_with_xyzi_fields(self) -> None:
        header = (
            b"# .PCD v0.7 - Point Cloud Data file format\n"
            b"VERSION 0.7\n"
            b"FIELDS x y z intensity\n"
            b"SIZE 4 4 4 4\n"
            b"TYPE F F F F\n"
            b"COUNT 1 1 1 1\n"
            b"WIDTH 2\n"
            b"HEIGHT 1\n"
            b"POINTS 2\n"
            b"DATA binary\n"
        )
        payload = struct.pack("<8f", 1.0, 2.0, 3.0, 0.5, -1.0, -2.0, -3.0, 0.75)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "points.pcd"
            path.write_bytes(header + payload)

            points = _load_pcd_points(path)

        self.assertEqual(points.shape, (2, 4))
        self.assertAlmostEqual(float(points[0, 0]), 1.0)
        self.assertAlmostEqual(float(points[1, 3]), 0.75)

    def test_drops_single_incomplete_binary_pcd_record(self) -> None:
        header = (
            b"# .PCD v0.7 - Point Cloud Data file format\n"
            b"VERSION 0.7\n"
            b"FIELDS x y z intensity\n"
            b"SIZE 4 4 4 4\n"
            b"TYPE F F F F\n"
            b"COUNT 1 1 1 1\n"
            b"WIDTH 2\n"
            b"HEIGHT 1\n"
            b"POINTS 2\n"
            b"DATA binary\n"
        )
        payload = struct.pack("<8f", 1.0, 2.0, 3.0, 0.5, -1.0, -2.0, -3.0, 0.75)[:-1]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "points.pcd"
            path.write_bytes(header + payload)

            points = _load_pcd_points(path)

        self.assertEqual(points.shape, (1, 4))
        self.assertAlmostEqual(float(points[0, 0]), 1.0)

    def test_formats_labels_and_converts_bottom_z_to_center(self) -> None:
        prediction = SimpleNamespace(
            pred_instances_3d=SimpleNamespace(
                bboxes_3d=SimpleNamespace(
                    tensor=np.asarray([[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 0.5]])
                ),
                scores_3d=np.asarray([0.9]),
                labels_3d=np.asarray([2]),
            )
        )

        objects = _to_xtreme_objects(prediction, 0.5)

        self.assertEqual(objects[0]["label"], "pillar")
        self.assertAlmostEqual(objects[0]["z"], 6.0)


if __name__ == "__main__":
    unittest.main()
