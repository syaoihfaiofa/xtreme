import json
import sys
import unittest
from pathlib import Path
from typing import Dict, List, Mapping, Sequence

import numpy as np


SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = SERVICE_ROOT.parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

LABELS = ("board_no_parking", "cone", "parkinglock_locked", "parkinglock_unlocked")
HEIGHTS = {
    "board_no_parking": 1.5,
    "cone": 0.7,
    "parkinglock_locked": 0.5,
    "parkinglock_unlocked": 0.3,
}
ANCHORS = 5376


def _downward_pinhole_payload() -> Dict[str, object]:
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


def _single_cone_output(keypoint_score: float) -> np.ndarray:
    # Crop [0.25, 0.75] on a 512x512 frame -> window (128, 128, 256, 256), gain 2, no pad,
    # so full-frame pixel u maps to model-input pixel (u - 128) * 2.
    output = np.zeros((1, 4 + len(LABELS) + 12, ANCHORS), dtype=np.float32)
    output[0, 0:4, 0] = (256.0, 256.0, 128.0, 64.0)
    output[0, 4 + LABELS.index("cone"), 0] = 0.9
    input_keypoints = ((192.0, 224.0), (320.0, 224.0), (320.0, 288.0), (192.0, 288.0))
    for index, (x, y) in enumerate(input_keypoints):
        output[0, 8 + index * 3 : 8 + index * 3 + 3, 0] = (x, y, keypoint_score)
    return output


class FakeSession:
    def __init__(self, output: np.ndarray) -> None:
        self._output = output

    def run(
        self, output_names: Sequence[str], inputs: Mapping[str, np.ndarray]
    ) -> List[np.ndarray]:
        if list(output_names) != ["output0"] or list(inputs) != ["images"]:
            raise AssertionError("unexpected ONNX names {} {}".format(output_names, list(inputs)))
        return [self._output]


class FakeResources:
    def __init__(self, camera_config: object, image: np.ndarray) -> None:
        self._camera_config = camera_config
        self._image = image

    def load_json(self, url: str) -> object:
        return self._camera_config

    def load_image(self, url: str) -> np.ndarray:
        return self._image


def _service(session: object, resources: FakeResources) -> object:
    from rod_detection.preprocessing import CropFractions
    from rod_detection.service import RecognitionService

    return RecognitionService(
        session=session,
        resources=resources,
        labels=LABELS,
        height_defaults=HEIGHTS,
        score_threshold=0.25,
        nms_iou_threshold=0.7,
        keypoint_score_threshold=0.5,
        max_detections=100,
        crop_windows={0: CropFractions(0.25, 0.75, 0.25, 0.75)},
        fusion_iou_threshold=0.5,
        ground_z=0.0,
    )


def _frame() -> Dict[str, object]:
    return {
        "id": 1,
        "cameras": [{"viewIndex": 0, "imageUrl": "http://image"}],
        "cameraConfigUrl": "http://config",
    }


class RecognitionServiceTest(unittest.TestCase):
    def test_recognize_lifts_cropped_keypoints_to_ground_box(self) -> None:
        resources = FakeResources(
            {"camera_image_0": _downward_pinhole_payload()},
            np.zeros((512, 512, 3), dtype=np.uint8),
        )
        result = _service(FakeSession(_single_cone_output(0.95)), resources).recognize(
            _frame()
        )

        self.assertEqual(result["code"], "OK", result["message"])
        self.assertEqual(result["rejections"], [])
        self.assertEqual(len(result["objects"]), 1)
        box = result["objects"][0]
        self.assertEqual(box["objType"], "3D_BOX")
        self.assertEqual(box["modelClass"], "cone")
        np.testing.assert_allclose(
            [box["center3D"]["x"], box["center3D"]["y"], box["center3D"]["z"]],
            [0.0, 0.0, 0.35],
            atol=1e-9,
        )
        np.testing.assert_allclose(
            [box["size3D"]["x"], box["size3D"]["y"], box["size3D"]["z"]],
            [0.5, 0.25, 0.7],
            atol=1e-9,
        )
        np.testing.assert_allclose(
            box["sourceKeypoints"][0],
            [224.0, 240.0, 288.0, 240.0, 288.0, 272.0, 224.0, 272.0],
            atol=1e-9,
        )

    def test_recognize_rejects_low_keypoint_confidence(self) -> None:
        resources = FakeResources(
            {"camera_image_0": _downward_pinhole_payload()},
            np.zeros((512, 512, 3), dtype=np.uint8),
        )
        result = _service(FakeSession(_single_cone_output(0.1)), resources).recognize(
            _frame()
        )

        self.assertEqual(result["code"], "OK", result["message"])
        self.assertEqual(result["objects"], [])
        self.assertEqual(len(result["rejections"]), 1)
        self.assertIn("keypoint_score_threshold", result["rejections"][0]["reason"])

    def test_recognize_errors_on_camera_without_crop_window(self) -> None:
        resources = FakeResources(
            {"camera_image_5": _downward_pinhole_payload()},
            np.zeros((512, 512, 3), dtype=np.uint8),
        )
        frame = _frame()
        frame["cameras"] = [{"viewIndex": 5, "imageUrl": "http://image"}]
        result = _service(FakeSession(_single_cone_output(0.95)), resources).recognize(frame)

        self.assertEqual(result["code"], "ERROR")
        self.assertIn("has no crop window", result["message"])


class RealModelSmokeTest(unittest.TestCase):
    def test_real_onnx_runs_on_fisheye_calibration(self) -> None:
        model_path = SERVICE_ROOT / "models" / "rod.onnx"
        if not model_path.is_file():
            self.skipTest("{} is not exported".format(model_path))
        import onnxruntime

        with (REPOSITORY_ROOT / "camera_config_fisheye.json").open(
            "r", encoding="utf-8"
        ) as config_file:
            camera_config = json.load(config_file)
        calibration = camera_config["3d_img0"]
        image = np.full(
            (int(calibration["height"]), int(calibration["width"]), 3),
            128,
            dtype=np.uint8,
        )
        session = onnxruntime.InferenceSession(
            str(model_path), providers=["CPUExecutionProvider"]
        )
        result = _service(session, FakeResources(camera_config, image)).recognize(
            _frame()
        )

        self.assertEqual(result["code"], "OK", result["message"])


if __name__ == "__main__":
    unittest.main()
