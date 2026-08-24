import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from typing import TYPE_CHECKING, Dict

if TYPE_CHECKING:
    import numpy as np


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

CHECKPOINT_PATH = Path(
    "/PnP/lxzhu/parkinglotperception2/CenterNet/"
    "exp/a100_release_m57_00_finetune/model_last.pth"
)


class MatchingTests(unittest.TestCase):
    def test_match_detections_is_class_aware_and_deterministic(self) -> None:
        from keypoint_lifted.matching import Detection, match_detections

        reference = [
            Detection(0, 0.90, (0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0)),
            Detection(1, 0.80, (20.0, 20.0, 30.0, 20.0, 30.0, 30.0, 20.0, 30.0)),
        ]
        candidate = [
            Detection(1, 0.79, (20.0, 20.0, 30.0, 20.0, 30.0, 30.0, 20.0, 30.0)),
            Detection(0, 0.89, (0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0)),
            Detection(2, 0.95, (0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0)),
        ]

        matches = match_detections(reference, candidate)

        self.assertEqual([(match.reference_index, match.candidate_index) for match in matches], [(0, 1), (1, 0)])
        self.assertTrue(all(match.keypoint_iou == 1.0 for match in matches))

    def test_match_detections_finds_optimal_complete_assignment(self) -> None:
        from keypoint_lifted.matching import Detection, match_detections

        reference = [
            Detection(0, 0.9, (0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0)),
            Detection(0, 0.9, (0.0, 0.0, 9.0, 0.0, 9.0, 10.0, 0.0, 10.0)),
        ]
        candidate = [
            Detection(0, 0.9, (0.0, 0.0, 9.0, 0.0, 9.0, 10.0, 0.0, 10.0)),
            Detection(0, 0.9, (1.0, 0.0, 10.0, 0.0, 10.0, 10.0, 1.0, 10.0)),
        ]

        matches = match_detections(reference, candidate)

        self.assertEqual(
            [(match.reference_index, match.candidate_index) for match in matches],
            [(0, 1), (1, 0)],
        )

    def test_equivalence_metrics_enforce_contract_thresholds(self) -> None:
        from keypoint_lifted.matching import (
            CONTRACT_THRESHOLDS,
            Detection,
            evaluate_equivalence,
            is_equivalent,
        )

        reference = [
            Detection(0, 0.90, (0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0))
        ]
        candidate = [
            Detection(0, 0.89, (0.05, 0.0, 10.05, 0.0, 10.05, 10.0, 0.05, 10.0))
        ]

        metrics = evaluate_equivalence(reference, candidate)

        self.assertTrue(is_equivalent(metrics, CONTRACT_THRESHOLDS))

    def test_equivalence_threshold_helper_rejects_each_contract_violation(self) -> None:
        from keypoint_lifted.matching import (
            CONTRACT_THRESHOLDS,
            EquivalenceMetrics,
            is_equivalent,
        )

        rejected_metrics = (
            EquivalenceMetrics(0.98, 1.0, 0.01, 1),
            EquivalenceMetrics(1.0, 2.01, 0.01, 1),
            EquivalenceMetrics(1.0, 1.0, 0.021, 1),
            EquivalenceMetrics(1.0, 0.0, 0.0, 0),
        )

        for metrics in rejected_metrics:
            with self.subTest(metrics=metrics):
                self.assertFalse(is_equivalent(metrics, CONTRACT_THRESHOLDS))

    def test_keypoint_iou_handles_concave_quad_predictions(self) -> None:
        from keypoint_lifted.matching import keypoint_iou

        keypoints = (0.0, 1.0, 6.0, 0.0, 5.0, 0.5, 5.0, 10.0)

        self.assertEqual(keypoint_iou(keypoints, keypoints), 1.0)


@unittest.skipUnless(
    importlib.util.find_spec("numpy") is not None and importlib.util.find_spec("cv2") is not None,
    "numpy and OpenCV are required for preprocessing tests",
)
class PreprocessingTests(unittest.TestCase):
    def test_preprocess_preserves_bgr_and_training_affine_contract(self) -> None:
        import numpy as np

        from keypoint_lifted.preprocessing import IMAGE_MEAN, IMAGE_STD, preprocess_bgr

        image = np.zeros((256, 1024, 3), dtype=np.uint8)
        image[:, :, 0] = 255

        tensor, metadata = preprocess_bgr(image)

        self.assertEqual(tensor.shape, (1, 3, 512, 512))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertEqual(metadata.input_size, (512, 512))
        self.assertEqual(metadata.center, (512.0, 128.0))
        self.assertEqual(metadata.scale, 1024.0)
        self.assertAlmostEqual(float(tensor[0, 0, 256, 256]), (1.0 - IMAGE_MEAN[0]) / IMAGE_STD[0], places=5)
        self.assertAlmostEqual(float(tensor[0, 1, 256, 256]), -IMAGE_MEAN[1] / IMAGE_STD[1], places=5)


@unittest.skipUnless(
    importlib.util.find_spec("numpy") is not None,
    "numpy is required for decoder tests",
)
class DecoderTests(unittest.TestCase):
    def _heads(self) -> Dict[str, "np.ndarray"]:
        import numpy as np

        heads = {
            "hm": np.full((1, 15, 5, 5), -100.0, dtype=np.float32),
            "reg": np.zeros((1, 2, 5, 5), dtype=np.float32),
            "wh": np.zeros((1, 2, 5, 5), dtype=np.float32),
            "hps": np.zeros((1, 8, 5, 5), dtype=np.float32),
            "hm_hp": np.full((1, 4, 5, 5), -100.0, dtype=np.float32),
            "hp_offset": np.zeros((1, 2, 5, 5), dtype=np.float32),
        }
        heads["hm"][0, 0, 2, 1] = 100.0
        heads["reg"][0, :, 2, 1] = (0.75, 0.5)
        heads["wh"][0, :, 2, 1] = (10.0, 10.0)
        heads["hps"][0, :, 2, 1] = (1.0, 0.0) * 4
        return heads

    def test_decode_adds_hps_to_integer_heatmap_location(self) -> None:
        from keypoint_lifted.decoder import decode_quads

        detections = decode_quads(self._heads(), score_threshold=0.1, top_k=1)

        self.assertEqual(detections[0].keypoints, (8.0, 8.0) * 4)

    def test_decode_refines_keypoints_with_heatmap_and_offset_heads(self) -> None:
        from keypoint_lifted.decoder import decode_quads

        heads = self._heads()
        heads["hm_hp"][0, :, 2, 2] = 100.0
        heads["hp_offset"][0, :, 2, 2] = (0.25, 0.5)

        detections = decode_quads(heads, score_threshold=0.1, top_k=1)

        self.assertEqual(detections[0].keypoints, (9.0, 10.0) * 4)

    def test_decode_polylines_groups_points_with_semantic_mask(self) -> None:
        import numpy as np

        from keypoint_lifted.polyline_decoder import decode_polylines
        from keypoint_lifted.preprocessing import PreprocessMetadata

        heads = {
            "sktpts_hm": np.full((1, 6, 128, 128), -100.0, dtype=np.float32),
            "sktpts_reg": np.zeros((1, 2, 128, 128), dtype=np.float32),
            "semantic_mask": np.zeros((1, 7, 512, 512), dtype=np.float32),
        }
        heads["sktpts_hm"][0, 0, 64, 40] = 2.0
        heads["sktpts_hm"][0, 0, 64, 41] = 2.0
        heads["semantic_mask"][0, 1, 250:270, 150:180] = 10.0
        metadata = PreprocessMetadata((256.0, 256.0), 512.0, (512, 512), (512, 512))

        detections = decode_polylines(heads, metadata, score_threshold=0.3, top_k=200)

        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0].class_id, 0)
        self.assertEqual(len(detections[0].points), 2)
        self.assertTrue(all(score > 0.8 for score in detections[0].point_scores))


class ModelAndOnnxTests(unittest.TestCase):
    def setUp(self) -> None:
        required = ("torch", "onnx", "onnxruntime", "numpy")
        missing = [name for name in required if importlib.util.find_spec(name) is None]
        if missing or not CHECKPOINT_PATH.is_file():
            reason = f"heavyweight dependencies/assets unavailable: {missing}, checkpoint={CHECKPOINT_PATH.is_file()}"
            self.skipTest(reason)

    def test_checkpoint_loads_without_source_centernet_imports(self) -> None:
        import torch

        from keypoint_lifted.model import HEADS, load_model

        before = {name for name in sys.modules if name == "backbone" or name.startswith("backbone.")}
        model = load_model(CHECKPOINT_PATH, device=torch.device("cpu"))
        output = model(torch.zeros((1, 3, 512, 512), dtype=torch.float32))
        after = {name for name in sys.modules if name == "backbone" or name.startswith("backbone.")}

        self.assertEqual(after, before)
        self.assertEqual(tuple(output), tuple(HEADS))
        self.assertEqual(output["hm"].shape, (1, 15, 128, 128))
        self.assertEqual(output["hps"].shape, (1, 8, 128, 128))
        self.assertEqual(output["sktpts_hm"].shape, (1, 6, 128, 128))
        self.assertEqual(output["semantic_mask"].shape, (1, 7, 512, 512))

    def test_onnx_exports_polyline_heads(self) -> None:
        from keypoint_lifted.model import ONNX_HEADS

        self.assertEqual(
            ONNX_HEADS,
            (
                "hm",
                "reg",
                "wh",
                "hps",
                "hm_hp",
                "hp_offset",
                "sktpts_hm",
                "sktpts_reg",
                "semantic_mask",
            ),
        )

    def test_exported_onnx_matches_pytorch_detection_contract(self) -> None:
        import numpy as np
        import onnxruntime
        import torch

        from keypoint_lifted.decoder import decode_quads
        from keypoint_lifted.export_onnx import export_onnx
        from keypoint_lifted.matching import (
            CONTRACT_THRESHOLDS,
            evaluate_equivalence,
            is_equivalent,
        )
        from keypoint_lifted.model import ONNX_HEADS, load_model

        generator = np.random.default_rng(317)
        input_tensor = generator.standard_normal((1, 3, 512, 512), dtype=np.float32)
        model = load_model(CHECKPOINT_PATH, device=torch.device("cpu"))

        with tempfile.TemporaryDirectory() as temp_dir:
            onnx_path = Path(temp_dir) / "keypoint-lifted.onnx"
            export_onnx(model, onnx_path)
            session = onnxruntime.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
            onnx_values = session.run(list(ONNX_HEADS), {"image": input_tensor})

        with torch.inference_mode():
            torch_output = model(torch.from_numpy(input_tensor))
        torch_heads = {name: value.detach().cpu().numpy() for name, value in torch_output.items()}
        onnx_heads = dict(zip(ONNX_HEADS, onnx_values))
        torch_detections = decode_quads(torch_heads, score_threshold=0.0, top_k=100)
        onnx_detections = decode_quads(onnx_heads, score_threshold=0.0, top_k=100)
        metrics = evaluate_equivalence(torch_detections, onnx_detections)

        self.assertTrue(is_equivalent(metrics, CONTRACT_THRESHOLDS), metrics)


if __name__ == "__main__":
    unittest.main()
