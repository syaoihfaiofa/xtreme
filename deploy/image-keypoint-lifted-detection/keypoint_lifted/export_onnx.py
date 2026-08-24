import argparse
from pathlib import Path
from typing import Optional, Sequence, Tuple

import torch
from torch import Tensor, nn

from .model import KeypointLiftedModel, ONNX_HEADS, load_model


class OnnxModel(nn.Module):
    def __init__(self, model: KeypointLiftedModel) -> None:
        super().__init__()
        self.model = model

    def forward(self, image: Tensor) -> Tuple[Tensor, ...]:
        heads = self.model(image)
        return tuple(heads[name] for name in ONNX_HEADS)


def export_onnx(model: KeypointLiftedModel, output_path: Path) -> None:
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    wrapper = OnnxModel(model).eval()
    example = torch.zeros((1, 3, 512, 512), dtype=torch.float32)
    torch.onnx.export(
        wrapper,
        example,
        str(destination),
        export_params=True,
        opset_version=11,
        do_constant_folding=True,
        input_names=["image"],
        output_names=list(ONNX_HEADS),
        dynamic_axes={
            "image": {0: "batch"},
            **{name: {0: "batch"} for name in ONNX_HEADS},
        },
    )


def main(arguments: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Export the keypoint-lifted model to ONNX")
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parsed = parser.parse_args(arguments)
    model = load_model(parsed.checkpoint, device=torch.device("cpu"))
    export_onnx(model, parsed.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
