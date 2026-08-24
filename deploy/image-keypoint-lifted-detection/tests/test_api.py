import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Dict, List, Optional, Tuple
from unittest import mock

import cv2
import numpy as np
from fastapi.testclient import TestClient


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))


def _calibration_payload() -> dict:
    camera_to_lidar = np.eye(4, dtype=np.float64)
    camera_to_lidar[:3, :3] = np.array(
        ((1.0, 0.0, 0.0), (0.0, -1.0, 0.0), (0.0, 0.0, -1.0))
    )
    camera_to_lidar[:3, 3] = (0.0, 0.0, 2.0)
    return {
        "cameraModel": "pinhole",
        "cameraInternal": {"fx": 256.0, "fy": 256.0, "cx": 256.0, "cy": 256.0},
        "cameraExternal": np.linalg.inv(camera_to_lidar).reshape(-1).tolist(),
        "rowMajor": True,
        "width": 512,
        "height": 512,
    }


def _heads(valid_quad: bool) -> Dict[str, np.ndarray]:
    heads = {
        "hm": np.full((1, 15, 128, 128), -100.0, dtype=np.float32),
        "reg": np.zeros((1, 2, 128, 128), dtype=np.float32),
        "wh": np.zeros((1, 2, 128, 128), dtype=np.float32),
        "hps": np.zeros((1, 8, 128, 128), dtype=np.float32),
        "hm_hp": np.full((1, 4, 128, 128), -100.0, dtype=np.float32),
        "hp_offset": np.zeros((1, 2, 128, 128), dtype=np.float32),
        "sktpts_hm": np.full((1, 6, 128, 128), -100.0, dtype=np.float32),
        "sktpts_reg": np.zeros((1, 2, 128, 128), dtype=np.float32),
        "semantic_mask": np.zeros((1, 7, 512, 512), dtype=np.float32),
    }
    heads["hm"][0, 0, 64, 64] = 100.0
    heads["wh"][0, :, 64, 64] = (128.0, 128.0)
    if valid_quad:
        output_points = ((0.0, 96.0), (128.0, 96.0), (128.0, 32.0), (0.0, 32.0))
    else:
        output_points = ((64.0, 64.0),) * 4
    heads["hps"][0, :, 64, 64] = np.asarray(
        [(x - 64.0, y - 64.0) for x, y in output_points],
        dtype=np.float32,
    ).reshape(-1)
    return heads


class FakeSession:
    def __init__(self, outputs: List[Dict[str, np.ndarray]]) -> None:
        self._outputs = outputs
        self.calls = 0

    def run(self, output_names: List[str], inputs: Dict[str, np.ndarray]) -> List[np.ndarray]:
        self.assert_input(inputs)
        output = self._outputs[self.calls]
        self.calls += 1
        return [output[name] for name in output_names]

    @staticmethod
    def assert_input(inputs: Dict[str, np.ndarray]) -> None:
        tensor = inputs["image"]
        if tensor.shape != (1, 3, 512, 512) or tensor.dtype != np.float32:
            raise AssertionError("unexpected model input")


class FakeResources:
    def __init__(
        self,
        camera_config: object,
        image_shape: Tuple[int, int, int] = (512, 512, 3),
    ) -> None:
        self.camera_config = camera_config
        self.image_shape = image_shape

    def load_json(self, url: str) -> object:
        if url == "memory://broken-config":
            raise ValueError("invalid JSON")
        return self.camera_config

    def load_image(self, url: str) -> np.ndarray:
        if url == "memory://broken-image":
            raise ValueError("invalid image bytes")
        return np.zeros(self.image_shape, dtype=np.uint8)


def _client(
    session: object,
    camera_config: object,
    score_threshold: float = 0.5,
    top_k: int = 10,
    fusion_iou_threshold: float = 0.5,
    resources: Optional[FakeResources] = None,
) -> TestClient:
    from app import create_app
    from keypoint_lifted.service import RecognitionService

    service = RecognitionService(
        session=session,
        resources=resources or FakeResources(camera_config),
        labels=("car",),
        height_defaults={"car": 1.5},
        score_threshold=score_threshold,
        top_k=top_k,
        fusion_iou_threshold=fusion_iou_threshold,
        ground_z=0.0,
        polyline_labels=(
            "curb",
            "wall",
            "fence",
            "vehicle_long_side_edge",
            "vehicle_short_side_edge",
            "barrier_side_edge",
        ),
        polyline_score_threshold=0.3,
        polyline_top_k=200,
        polyline_fusion_distance_threshold=0.3,
    )
    return TestClient(create_app(service))


class RecognitionApiTests(unittest.TestCase):
    def test_response_contains_box_and_ground_polyline(self) -> None:
        heads = _heads(True)
        heads["sktpts_hm"][0, 0, 64, 40:42] = 2.0
        heads["semantic_mask"][0, 1, 250:270, 150:180] = 10.0
        client = _client(FakeSession([heads]), {"3d_img0": _calibration_payload()})

        response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 18,
                        "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                        "cameraConfigUrl": "memory://calibration",
                    }
                ]
            },
        )

        frame = response.json()["data"][0]
        self.assertEqual(frame["code"], "OK")
        self.assertEqual(
            {candidate["objType"] for candidate in frame["objects"]},
            {"3D_BOX", "GROUND_POLYLINE"},
        )
        polyline = next(
            candidate
            for candidate in frame["objects"]
            if candidate["objType"] == "GROUND_POLYLINE"
        )
        self.assertEqual(polyline["modelClass"], "curb")
        self.assertEqual(polyline["sourceViewIndexes"], [0])
        self.assertEqual(len(polyline["sourceKeypoints"][0]), 4)

    def test_labels_are_loaded_from_mounted_json(self) -> None:
        from keypoint_lifted.labels import load_labels

        labels = load_labels(SERVICE_ROOT / "config" / "labels.json")

        self.assertEqual(labels[0], "car")
        self.assertEqual(len(labels), 15)

    def test_height_defaults_load_all_model_labels_from_yaml(self) -> None:
        from keypoint_lifted.schemas import load_height_defaults

        heights = load_height_defaults(SERVICE_ROOT / "config" / "heights.yaml")

        self.assertEqual(
            heights,
            {
                "car": 1.5,
                "bus": 3.2,
                "truck": 3.5,
                "tricycle": 1.6,
                "bike": 1.2,
                "parkinglock_locked": 0.5,
                "parkinglock_unlocked": 0.3,
                "board_no_parking": 1.5,
                "handcart": 1.0,
                "person": 1.7,
                "pillar": 2.8,
                "cone": 0.7,
                "pole": 3.0,
                "barrier": 1.0,
                "concrete_ball": 0.5,
            },
        )

    def test_bev_fusion_default_is_consistently_half(self) -> None:
        repository_root = SERVICE_ROOT.parents[1]
        compose = (repository_root / "docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn('FUSION_IOU_THRESHOLD", "0.5"', (
            SERVICE_ROOT / "keypoint_lifted" / "service.py"
        ).read_text(encoding="utf-8"))
        self.assertIn("KEYPOINT_LIFTED_FUSION_IOU_THRESHOLD:-0.5", compose)

    def test_multi_camera_detections_are_decoded_lifted_and_fused(self) -> None:
        config = {"3d_img0": _calibration_payload(), "3d_img1": _calibration_payload()}
        session = FakeSession([_heads(True), _heads(True)])
        client = _client(session, config)

        response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 17,
                        "cameras": [
                            {"viewIndex": 0, "imageUrl": "memory://camera-0"},
                            {"viewIndex": 1, "imageUrl": "memory://camera-1"},
                        ],
                        "cameraConfigUrl": "memory://calibration",
                    }
                ]
            },
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["code"], "OK")
        frame = payload["data"][0]
        self.assertEqual(frame["id"], 17)
        self.assertEqual(frame["code"], "OK")
        self.assertEqual(len(frame["objects"]), 1)
        self.assertEqual(frame["objects"][0]["modelClass"], "car")
        self.assertEqual(frame["objects"][0]["sourceViewIndexes"], [0, 1])
        self.assertEqual(frame["rejections"], [])
        self.assertEqual(session.calls, 2)

    def test_sparse_camera_indexes_use_their_matching_calibrations(self) -> None:
        config = {"3d_img0": _calibration_payload(), "3d_img2": _calibration_payload()}
        session = FakeSession([_heads(True), _heads(True)])
        client = _client(session, config)

        response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 28,
                        "cameras": [
                            {"viewIndex": 0, "imageUrl": "memory://camera-0"},
                            {"viewIndex": 2, "imageUrl": "memory://camera-2"},
                        ],
                        "cameraConfigUrl": "memory://calibration",
                    }
                ]
            },
        )

        self.assertEqual(response.status_code, 200)
        frame = response.json()["data"][0]
        self.assertEqual(frame["code"], "OK")
        self.assertEqual(frame["objects"][0]["sourceViewIndexes"], [0, 2])
        self.assertEqual(session.calls, 2)

    def test_camera_config_array_uses_view_indexes(self) -> None:
        config = [_calibration_payload(), _calibration_payload(), _calibration_payload()]
        session = FakeSession([_heads(True)])
        client = _client(session, config)

        response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 29,
                        "cameras": [
                            {"viewIndex": 2, "imageUrl": "memory://camera-2"},
                        ],
                        "cameraConfigUrl": "memory://calibration",
                    }
                ]
            },
        )

        self.assertEqual(response.status_code, 200)
        frame = response.json()["data"][0]
        self.assertEqual(frame["code"], "OK")
        self.assertEqual(session.calls, 1)

    def test_frame_rejects_missing_or_empty_id(self) -> None:
        config = {"3d_img0": _calibration_payload()}
        frames = (
            {
                "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                "cameraConfigUrl": "memory://calibration",
            },
            {
                "id": " ",
                "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                "cameraConfigUrl": "memory://calibration",
            },
        )

        for frame in frames:
            with self.subTest(frame=frame):
                response = _client(FakeSession([]), config).post(
                    "/image/keypoint-lifted/recognition", json={"datas": [frame]}
                )

                result = response.json()["data"][0]
                self.assertEqual(result["code"], "ERROR")
                self.assertIn("id", result["message"])

    def test_image_dimensions_must_match_calibration_with_camera_context(self) -> None:
        config = {"3d_img0": _calibration_payload()}
        resources = FakeResources(config, image_shape=(480, 640, 3))
        client = _client(FakeSession([]), config, resources=resources)

        response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 24,
                        "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                        "cameraConfigUrl": "memory://calibration",
                    }
                ]
            },
        )

        message = response.json()["data"][0]["message"]
        self.assertIn("camera index 0", message)
        self.assertIn("imageUrl='memory://camera-0'", message)
        self.assertIn("640x480", message)
        self.assertIn("512x512", message)

    def test_invalid_calibration_includes_camera_key_and_index(self) -> None:
        invalid_calibration = _calibration_payload()
        del invalid_calibration["cameraInternal"]
        client = _client(FakeSession([]), {"3d_img0": invalid_calibration})

        response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 25,
                        "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                        "cameraConfigUrl": "memory://calibration",
                    }
                ]
            },
        )

        message = response.json()["data"][0]["message"]
        self.assertIn("camera index 0", message)
        self.assertIn("calibration key '3d_img0'", message)
        self.assertIn("cameraInternal", message)

    def test_non_runtime_onnx_error_becomes_diagnostic_frame_error(self) -> None:
        class OnnxBackendError(Exception):
            pass

        class FailingSession:
            def run(self, output_names: object, inputs: object) -> object:
                raise OnnxBackendError("CUDA provider unavailable")

        config = {"3d_img0": _calibration_payload()}
        client = _client(FailingSession(), config)

        response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 26,
                        "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                        "cameraConfigUrl": "memory://calibration",
                    }
                ]
            },
        )

        self.assertEqual(response.status_code, 200)
        result = response.json()["data"][0]
        self.assertEqual(result["code"], "ERROR")
        self.assertIn("camera index 0", result["message"])
        self.assertIn("CUDA provider unavailable", result["message"])

    def test_blocking_recognition_is_dispatched_off_async_route(self) -> None:
        import app

        calls = []

        async def tracked_run_in_threadpool(function: object, *args: object) -> object:
            calls.append(getattr(function, "__name__", repr(function)))
            return function(*args)

        config = {"3d_img0": _calibration_payload()}
        with mock.patch.object(
            app,
            "run_in_threadpool",
            new=tracked_run_in_threadpool,
            create=True,
        ):
            response = _client(FakeSession([_heads(True)]), config).post(
                "/image/keypoint-lifted/recognition",
                json={
                    "datas": [
                        {
                            "id": 27,
                            "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                            "cameraConfigUrl": "memory://calibration",
                        }
                    ]
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("recognize", calls)

    def test_invalid_detection_returns_rejection_without_failing_frame(self) -> None:
        config = {"3d_img0": _calibration_payload(), "3d_img1": _calibration_payload()}
        client = _client(FakeSession([_heads(True), _heads(False)]), config)

        response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 18,
                        "cameras": [
                            {"viewIndex": 0, "imageUrl": "memory://camera-0"},
                            {"viewIndex": 1, "imageUrl": "memory://camera-1"},
                        ],
                        "cameraConfigUrl": "memory://calibration",
                    }
                ]
            },
        )

        frame = response.json()["data"][0]
        self.assertEqual(frame["code"], "OK")
        self.assertEqual(len(frame["objects"]), 1)
        self.assertEqual(frame["rejections"][0]["cameraIndex"], 1)
        self.assertEqual(frame["rejections"][0]["detectionIndex"], 0)
        self.assertIn("duplicate", frame["rejections"][0]["reason"].lower())

    def test_frame_rejects_missing_cameras_or_valid_calibration(self) -> None:
        cases = (
            (
                {"id": 19, "cameras": [], "cameraConfigUrl": "memory://calibration"},
                {"3d_img0": _calibration_payload()},
                "cameras",
            ),
            (
                {
                    "id": 20,
                    "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                    "cameraConfigUrl": "memory://calibration",
                },
                {},
                "calibration",
            ),
            (
                {
                    "id": 21,
                    "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                    "cameraConfigUrl": "memory://calibration",
                },
                {"3d_img1": _calibration_payload()},
                "camera index 0",
            ),
        )
        for frame, config, expected_message in cases:
            with self.subTest(frame=frame):
                client = _client(FakeSession([]), config)
                response = client.post(
                    "/image/keypoint-lifted/recognition", json={"datas": [frame]}
                )
                result = response.json()["data"][0]
                self.assertEqual(result["code"], "ERROR")
                self.assertIn(expected_message, result["message"])
                self.assertEqual(result["objects"], [])

    def test_resource_errors_include_camera_index_and_request_parameters(self) -> None:
        config = {"3d_img0": _calibration_payload()}
        client = _client(FakeSession([]), config)

        image_response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 22,
                        "cameras": [{"viewIndex": 0, "imageUrl": "memory://broken-image"}],
                        "cameraConfigUrl": "memory://calibration",
                    }
                ]
            },
        )
        config_response = client.post(
            "/image/keypoint-lifted/recognition",
            json={
                "datas": [
                    {
                        "id": 23,
                        "cameras": [{"viewIndex": 0, "imageUrl": "memory://camera-0"}],
                        "cameraConfigUrl": "memory://broken-config",
                    }
                ]
            },
        )

        image_message = image_response.json()["data"][0]["message"]
        self.assertIn("camera index 0", image_message)
        self.assertIn("imageUrl='memory://broken-image'", image_message)
        config_message = config_response.json()["data"][0]["message"]
        self.assertIn("cameraConfigUrl='memory://broken-config'", config_message)
        self.assertIn("invalid JSON", config_message)

    def test_invalid_service_parameters_are_actionable(self) -> None:
        with self.assertRaisesRegex(
            ValueError,
            r"score_threshold=1.5.*top_k=0.*fusion_iou_threshold=-0.1",
        ):
            _client(
                FakeSession([]),
                {"3d_img0": _calibration_payload()},
                score_threshold=1.5,
                top_k=0,
                fusion_iou_threshold=-0.1,
            )

    def test_request_requires_non_empty_datas(self) -> None:
        client = _client(FakeSession([]), {"3d_img0": _calibration_payload()})

        response = client.post(
            "/image/keypoint-lifted/recognition",
            json={"datas": []},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["message"], "datas must be a non-empty array")


class ResourceTests(unittest.TestCase):
    def test_cv2_decode_error_is_wrapped_with_url_context(self) -> None:
        from keypoint_lifted.resources import HTTPResources

        resources = HTTPResources(timeout=1.0)
        response = SimpleNamespace(content=b"not-an-image")
        decode_error = cv2.error("decode exploded")

        with mock.patch.object(resources, "_get", return_value=response), mock.patch(
            "keypoint_lifted.resources.cv2.imdecode",
            side_effect=decode_error,
        ):
            with self.assertRaisesRegex(
                ValueError,
                r"memory://camera-0.*decode exploded",
            ):
                resources.load_image("memory://camera-0")


if __name__ == "__main__":
    unittest.main()
