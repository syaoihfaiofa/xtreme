import argparse
import shutil
import tempfile
from pathlib import Path
from typing import Mapping, Optional, Sequence, Tuple

from .labels import load_labels
from .preprocessing import INPUT_SIZE


def _model_labels(names: Mapping[int, str]) -> Tuple[str, ...]:
    return tuple(names[index] for index in sorted(names))


def export_onnx(weights_path: Path, labels_path: Path, output_path: Path) -> Path:
    from ultralytics import YOLO

    if not weights_path.is_file():
        raise FileNotFoundError("Weights do not exist: {}".format(weights_path))
    model = YOLO(str(weights_path))
    if model.task != "pose":
        raise ValueError(
            "Expected an Ultralytics pose model, got task={!r} from {}".format(
                model.task, weights_path
            )
        )
    expected_labels = load_labels(labels_path)
    model_labels = _model_labels(model.names)
    if model_labels != expected_labels:
        raise ValueError(
            "Model class names {!r} from {} do not match labels {!r} from {}".format(
                model_labels, weights_path, expected_labels, labels_path
            )
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Ultralytics writes the ONNX file next to the weights, which may be read-only.
    with tempfile.TemporaryDirectory() as work_dir:
        work_weights = Path(work_dir) / weights_path.name
        shutil.copyfile(str(weights_path), str(work_weights))
        exported = Path(
            YOLO(str(work_weights)).export(
                format="onnx",
                imgsz=INPUT_SIZE,
                opset=17,
                simplify=True,
                dynamic=False,
                batch=1,
                device="cpu",
            )
        )
        shutil.move(str(exported), str(output_path))
    return output_path


def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = argparse.ArgumentParser(
        description="Export the ROD Ultralytics pose checkpoint to a raw-head ONNX model"
    )
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args(argv)
    output = export_onnx(arguments.weights, arguments.labels, arguments.output)
    print("Exported ROD ONNX model to {}".format(output))


if __name__ == "__main__":
    main()
