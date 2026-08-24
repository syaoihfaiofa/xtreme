import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))


def _calibration_payload(camera_model: str = "pinhole") -> dict:
    camera_to_lidar = np.eye(4, dtype=np.float64)
    camera_to_lidar[:3, :3] = np.array(
        ((1.0, 0.0, 0.0), (0.0, -1.0, 0.0), (0.0, 0.0, -1.0))
    )
    camera_to_lidar[:3, 3] = (0.0, 0.0, 2.0)
    lidar_to_camera = np.linalg.inv(camera_to_lidar)
    payload = {
        "cameraModel": camera_model,
        "cameraInternal": {"fx": 500.0, "fy": 500.0, "cx": 320.0, "cy": 240.0},
        "cameraExternal": lidar_to_camera.reshape(-1).tolist(),
        "rowMajor": True,
        "width": 640,
        "height": 480,
    }
    if camera_model == "fisheye":
        payload["distortion"] = {"k1": 0.01, "k2": -0.005, "k3": 0.001, "k4": 0.0}
    return payload


def _project_fisheye(camera_point: np.ndarray, calibration: object) -> np.ndarray:
    x = float(camera_point[0] / camera_point[2])
    y = float(camera_point[1] / camera_point[2])
    radius = math.hypot(x, y)
    theta = math.atan(radius)
    coefficients = calibration.distortion_vector
    theta2 = theta * theta
    theta_distorted = theta * (
        1.0
        + coefficients[0] * theta2
        + coefficients[1] * theta2**2
        + coefficients[2] * theta2**3
        + coefficients[3] * theta2**4
    )
    scale = theta_distorted / radius if radius > 0.0 else 1.0
    return np.array(
        (
            calibration.intrinsics.fx * x * scale + calibration.intrinsics.cx,
            calibration.intrinsics.fy * y * scale + calibration.intrinsics.cy,
        )
    )


def _ground_keypoints(points: tuple) -> tuple:
    values = []
    for x, y in points:
        values.extend((320.0 + 250.0 * x, 240.0 - 250.0 * y))
    return tuple(values)


class GeometryTests(unittest.TestCase):
    def test_lift_polyline_projects_all_pixels_to_vehicle_ground(self) -> None:
        from keypoint_lifted.geometry import lift_polyline
        from keypoint_lifted.schemas import CameraCalibration

        calibration = CameraCalibration.from_xtreme(_calibration_payload())

        polyline = lift_polyline(
            model_class="curb",
            confidence=0.8,
            view_index=1,
            pixel_points=((320.0, 240.0), (570.0, 365.0)),
            calibration=calibration,
            ground_z=-0.332284,
        )

        self.assertEqual(polyline.objType, "GROUND_POLYLINE")
        self.assertEqual(polyline.source_view_indexes, (1,))
        self.assertEqual(polyline.source_keypoints, ((320.0, 240.0, 570.0, 365.0),))
        self.assertTrue(all(point.z == -0.332284 for point in polyline.points))
        np.testing.assert_allclose(
            (polyline.points[1].x, polyline.points[1].y),
            (1.166142, -0.583071),
            atol=1e-8,
        )

    def test_pinhole_rays_intersect_expected_ground_points(self) -> None:
        from keypoint_lifted.geometry import intersect_pixel_with_ground
        from keypoint_lifted.schemas import CameraCalibration

        calibration = CameraCalibration.from_xtreme(_calibration_payload())

        point = intersect_pixel_with_ground((570.0, 365.0), calibration, ground_z=-0.332284)

        np.testing.assert_allclose(point, (1.166142, -0.583071, -0.332284), atol=1e-8)

    def test_fisheye_undistortion_round_trip_has_low_reprojection_error(self) -> None:
        from keypoint_lifted.geometry import camera_ray_from_pixel
        from keypoint_lifted.schemas import CameraCalibration

        calibration = CameraCalibration.from_xtreme(_calibration_payload("fisheye"))
        camera_point = np.array((0.4, -0.2, 1.0), dtype=np.float64)
        pixel = tuple(_project_fisheye(camera_point, calibration))

        ray = camera_ray_from_pixel(pixel, calibration)
        reprojected = _project_fisheye(ray, calibration)

        np.testing.assert_allclose(reprojected, pixel, atol=1e-6)

    def test_fisheye_undistortion_rejects_nonconvergent_solution(self) -> None:
        from keypoint_lifted.geometry import GeometryError, camera_ray_from_pixel
        from keypoint_lifted.schemas import CameraCalibration

        payload = _calibration_payload("fisheye")
        payload["distortion"] = {"k1": -1.0, "k2": 0.0, "k3": 0.0, "k4": 0.0}
        calibration = CameraCalibration.from_xtreme(payload)

        with self.assertRaisesRegex(GeometryError, "converge"):
            camera_ray_from_pixel((570.0, 240.0), calibration)

    def test_invalid_ground_geometry_is_rejected(self) -> None:
        from keypoint_lifted.geometry import GeometryError, intersect_ray_with_ground, lift_quad
        from keypoint_lifted.schemas import CameraCalibration, KeypointDetection

        calibration = CameraCalibration.from_xtreme(_calibration_payload())
        invalid_keypoint_sets = (
            (math.nan, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0),
            (320.0, 240.0) * 4,
        )
        for keypoints in invalid_keypoint_sets:
            with self.subTest(keypoints=keypoints):
                detection = KeypointDetection("car", 0.8, 0, keypoints)
                with self.assertRaises(GeometryError):
                    lift_quad(detection, calibration, height=1.5, ground_z=0.0)

        with self.assertRaisesRegex(GeometryError, "parallel"):
            intersect_ray_with_ground(
                np.array((0.0, 0.0, 1.0)),
                np.array((1.0, 0.0, 0.0)),
                ground_z=0.0,
            )
        with self.assertRaisesRegex(GeometryError, "behind"):
            intersect_ray_with_ground(
                np.array((0.0, 0.0, 1.0)),
                np.array((0.0, 0.0, 1.0)),
                ground_z=0.0,
            )

    def test_lift_quad_orders_points_and_constructs_3d_box(self) -> None:
        from keypoint_lifted.geometry import lift_detection
        from keypoint_lifted.schemas import CameraCalibration, KeypointDetection

        calibration = CameraCalibration.from_xtreme(_calibration_payload())
        keypoints = (820.0, 490.0, 820.0, -10.0, -180.0, -10.0, -180.0, 490.0)
        detection = KeypointDetection("car", 0.91, 3, keypoints)

        box = lift_detection(
            detection,
            calibration,
            {"car": 1.5},
            ground_z=-0.332284,
        )

        self.assertEqual(box.objType, "3D_BOX")
        np.testing.assert_allclose(
            (box.center3D.x, box.center3D.y, box.center3D.z),
            (0.0, 0.0, 0.417716),
            atol=1e-8,
        )
        np.testing.assert_allclose(
            sorted((box.size3D.x, box.size3D.y)),
            (2.332284, 4.664568),
            atol=1e-8,
        )
        self.assertEqual(box.size3D.z, 1.5)
        self.assertEqual(box.source_view_indexes, (3,))
        self.assertEqual(box.source_keypoints, (keypoints,))

    def test_lift_quad_rejects_nonconvex_and_collinear_points(self) -> None:
        from keypoint_lifted.geometry import GeometryError, lift_quad
        from keypoint_lifted.schemas import CameraCalibration, KeypointDetection

        calibration = CameraCalibration.from_xtreme(_calibration_payload())
        invalid_points = (
            ((-2.0, -1.0), (2.0, -1.0), (0.0, 0.0), (0.0, 1.0)),
            ((-2.0, 0.0), (-1.0, 0.0), (1.0, 0.0), (2.0, 0.0)),
        )

        for points in invalid_points:
            with self.subTest(points=points):
                detection = KeypointDetection(
                    "car", 0.8, 0, _ground_keypoints(points)
                )
                with self.assertRaises(GeometryError):
                    lift_quad(detection, calibration, height=1.5, ground_z=0.0)

    def test_lift_quad_point_order_is_deterministic(self) -> None:
        from keypoint_lifted.geometry import lift_quad, order_quad_points
        from keypoint_lifted.schemas import CameraCalibration, KeypointDetection

        calibration = CameraCalibration.from_xtreme(_calibration_payload())
        points = ((-2.0, -1.0), (2.0, -1.0), (2.0, 1.0), (-2.0, 1.0))
        permuted = (points[2], points[0], points[3], points[1])
        ordered = order_quad_points(
            tuple(np.array((x, y, 0.0), dtype=np.float64) for x, y in permuted)
        )
        first = lift_quad(
            KeypointDetection("car", 0.8, 0, _ground_keypoints(points)),
            calibration,
            height=1.5,
            ground_z=0.0,
        )
        second = lift_quad(
            KeypointDetection("car", 0.8, 1, _ground_keypoints(permuted)),
            calibration,
            height=1.5,
            ground_z=0.0,
        )

        self.assertEqual(
            tuple((float(point[0]), float(point[1])) for point in ordered),
            points,
        )
        self.assertEqual(first.center3D, second.center3D)
        self.assertEqual(first.size3D, second.size3D)
        self.assertEqual(first.rotation3D, second.rotation3D)


class SchemaAndFusionTests(unittest.TestCase):
    def test_polyline_fusion_averages_overlapping_same_class_points(self) -> None:
        from keypoint_lifted.polyline_fusion import fuse_ground_polylines
        from keypoint_lifted.schemas import GroundPolyline, Vector3

        first = GroundPolyline(
            "GROUND_POLYLINE",
            "curb",
            0.8,
            (Vector3(0.0, 0.0, -0.3), Vector3(1.0, 0.0, -0.3)),
            (0,),
            ((10.0, 10.0, 20.0, 10.0),),
        )
        second = GroundPolyline(
            "GROUND_POLYLINE",
            "curb",
            0.6,
            (Vector3(0.0, 0.2, -0.3), Vector3(1.0, 0.2, -0.3)),
            (1,),
            ((11.0, 11.0, 21.0, 11.0),),
        )

        fused = fuse_ground_polylines((first, second), distance_threshold=0.3)

        self.assertEqual(len(fused), 1)
        self.assertEqual(fused[0].source_view_indexes, (0, 1))
        self.assertAlmostEqual(fused[0].confidence, 0.7)
        np.testing.assert_allclose(
            [(point.x, point.y, point.z) for point in fused[0].points],
            ((0.0, 0.1, -0.3), (1.0, 0.1, -0.3)),
            atol=1e-8,
        )

    def test_vehicle_info_ground_z_uses_negative_wheel_radius(self) -> None:
        from keypoint_lifted.schemas import load_vehicle_ground_z

        with tempfile.TemporaryDirectory() as temp_dir:
            vehicle_info_path = Path(temp_dir) / "car_info.json"
            vehicle_info_path.write_text(
                json.dumps({"car_info": {"wheel_radius": 0.332284}}),
                encoding="utf-8",
            )

            ground_z = load_vehicle_ground_z(vehicle_info_path)

        self.assertEqual(ground_z, -0.332284)

    def test_calibration_schemas_are_model_specific(self) -> None:
        from keypoint_lifted.schemas import parse_camera_config

        calibrations = parse_camera_config(
            {
                "3d_img0": _calibration_payload("pinhole"),
                "3d_img1": _calibration_payload("fisheye"),
            }
        )

        self.assertEqual(type(calibrations["3d_img0"]).__name__, "PinholeCalibration")
        self.assertEqual(type(calibrations["3d_img1"]).__name__, "FisheyeCalibration")

    def test_xtreme_camera_config_normalizes_alias_keys(self) -> None:
        from keypoint_lifted.schemas import parse_camera_config

        pinhole = _calibration_payload("pinhole")
        pinhole["camera_internal"] = pinhole.pop("cameraInternal")
        pinhole["camera_external"] = pinhole.pop("cameraExternal")
        pinhole["camera_model"] = pinhole.pop("cameraModel")
        fisheye = _calibration_payload("fisheye")
        fisheye["cameraDistortion"] = fisheye.pop("distortion")

        try:
            calibrations = parse_camera_config(
                {"3d_img0": pinhole, "3d_img1": fisheye}
            )
        except (KeyError, TypeError, ValueError) as error:
            self.fail("Xtreme aliases were not normalized: {!r}".format(error))

        self.assertEqual(calibrations["3d_img0"].camera_model, "pinhole")
        self.assertEqual(calibrations["3d_img1"].distortion, (0.01, -0.005, 0.001, 0.0))

    def test_xtreme_camera_config_accepts_snake_case_distortion_alias(self) -> None:
        from keypoint_lifted.schemas import parse_camera_config

        fisheye = _calibration_payload("fisheye")
        fisheye["camera_distortion"] = fisheye.pop("distortion")

        try:
            calibrations = parse_camera_config({"3d_img0": fisheye})
        except ValueError as error:
            self.fail("camera_distortion alias was rejected: {!r}".format(error))

        self.assertEqual(calibrations["3d_img0"].distortion, (0.01, -0.005, 0.001, 0.0))

    def test_xtreme_camera_config_parses_pinhole_and_fisheye_views(self) -> None:
        from keypoint_lifted.schemas import parse_camera_config

        calibrations = parse_camera_config(
            {
                "3d_img0": _calibration_payload("pinhole"),
                "3d_img1": _calibration_payload("fisheye"),
            }
        )

        self.assertEqual(tuple(calibrations), ("3d_img0", "3d_img1"))
        self.assertEqual(calibrations["3d_img0"].camera_model, "pinhole")
        self.assertEqual(calibrations["3d_img1"].camera_model, "fisheye")

    def test_height_defaults_load_for_approved_classes(self) -> None:
        from keypoint_lifted.schemas import load_height_defaults

        heights = load_height_defaults(SERVICE_ROOT / "config" / "heights.yaml")

        self.assertEqual(len(heights), 15)
        self.assertEqual(heights["car"], 1.5)
        self.assertEqual(heights["cone"], 0.7)
        self.assertEqual(heights["pillar"], 2.8)
        with tempfile.TemporaryDirectory() as temp_dir:
            invalid_path = Path(temp_dir) / "heights.yaml"
            invalid_path.write_text(json.dumps({"car": -1.0}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_height_defaults(invalid_path)

    def test_same_class_overlap_keeps_higher_confidence_and_sources(self) -> None:
        from keypoint_lifted.fusion import fuse_bev_boxes
        from keypoint_lifted.schemas import Box3D, Vector3

        low = Box3D(
            objType="3D_BOX",
            modelClass="car",
            confidence=0.70,
            center3D=Vector3(0.0, 0.0, 0.75),
            size3D=Vector3(4.0, 2.0, 1.5),
            rotation3D=Vector3(0.0, 0.0, 0.0),
            source_view_indexes=(0,),
            source_keypoints=((1.0,) * 8,),
        )
        high = Box3D(
            objType="3D_BOX",
            modelClass="car",
            confidence=0.95,
            center3D=Vector3(0.5, 0.0, 0.75),
            size3D=Vector3(4.0, 2.0, 1.5),
            rotation3D=Vector3(0.0, 0.0, 0.0),
            source_view_indexes=(2,),
            source_keypoints=((2.0,) * 8,),
        )
        other_class = Box3D(
            objType="3D_BOX",
            modelClass="cone",
            confidence=0.80,
            center3D=Vector3(0.0, 0.0, 0.35),
            size3D=Vector3(4.0, 2.0, 0.7),
            rotation3D=Vector3(0.0, 0.0, 0.0),
            source_view_indexes=(1,),
            source_keypoints=((3.0,) * 8,),
        )

        fused = fuse_bev_boxes((low, high, other_class), iou_threshold=0.5)

        self.assertEqual(len(fused), 2)
        car = next(box for box in fused if box.modelClass == "car")
        self.assertEqual(car.confidence, 0.95)
        self.assertEqual(car.source_view_indexes, (0, 2))
        self.assertEqual(car.source_keypoints, ((1.0,) * 8, (2.0,) * 8))

    def test_bev_iou_supports_rotated_boxes(self) -> None:
        from keypoint_lifted.fusion import bev_iou
        from keypoint_lifted.schemas import Box3D, Vector3

        first = Box3D(
            "3D_BOX",
            "car",
            0.8,
            Vector3(0.0, 0.0, 0.75),
            Vector3(4.0, 2.0, 1.5),
            Vector3(0.0, 0.0, 0.0),
            (0,),
            ((1.0,) * 8,),
        )
        rotated = first._replace(
            rotation3D=Vector3(0.0, 0.0, math.pi / 2.0),
            source_view_indexes=(1,),
        )

        self.assertAlmostEqual(bev_iou(first, rotated), 1.0 / 3.0, places=12)

    def test_fusion_merges_boxes_at_exact_half_iou(self) -> None:
        from keypoint_lifted.fusion import fuse_bev_boxes
        from keypoint_lifted.schemas import Box3D, Vector3

        first = Box3D(
            "3D_BOX",
            "car",
            0.9,
            Vector3(0.0, 0.0, 0.75),
            Vector3(4.0, 2.0, 1.5),
            Vector3(0.0, 0.0, 0.0),
            (0,),
            ((1.0,) * 8,),
        )
        half_iou = first._replace(
            confidence=0.8,
            center3D=Vector3(4.0 / 3.0, 0.0, 0.75),
            source_view_indexes=(1,),
            source_keypoints=((2.0,) * 8,),
        )

        fused = fuse_bev_boxes((first, half_iou), iou_threshold=0.5)

        self.assertEqual(len(fused), 1)

    def test_equal_confidence_merge_retains_first_box_and_all_sources(self) -> None:
        from keypoint_lifted.fusion import fuse_bev_boxes
        from keypoint_lifted.schemas import Box3D, Vector3

        first = Box3D(
            "3D_BOX",
            "car",
            0.9,
            Vector3(0.0, 0.0, 0.75),
            Vector3(4.0, 2.0, 1.5),
            Vector3(0.0, 0.0, 0.0),
            (3,),
            ((3.0,) * 8,),
        )
        second = first._replace(
            center3D=Vector3(0.25, 0.0, 0.75),
            source_view_indexes=(1,),
            source_keypoints=((1.0,) * 8,),
        )

        fused = fuse_bev_boxes((first, second), iou_threshold=0.5)

        self.assertEqual(len(fused), 1)
        self.assertEqual(fused[0].center3D, first.center3D)
        self.assertEqual(fused[0].source_view_indexes, (1, 3))
        self.assertEqual(fused[0].source_keypoints, ((1.0,) * 8, (3.0,) * 8))


if __name__ == "__main__":
    unittest.main()
