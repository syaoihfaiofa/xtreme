from collections import OrderedDict
from pathlib import Path
from typing import Dict, Mapping, Optional, Tuple

import torch
from torch import Tensor, nn
from torch.nn import functional as functional


HEADS: "OrderedDict[str, int]" = OrderedDict(
    (
        ("hm", 15),
        ("reg", 2),
        ("wh", 2),
        ("hps", 8),
        ("hm_hp", 4),
        ("hp_offset", 2),
        ("sktpts_hm", 6),
        ("sktpts_reg", 2),
        ("semantic_mask", 7),
    )
)
ONNX_HEADS: Tuple[str, ...] = (
    "hm",
    "reg",
    "wh",
    "hps",
    "hm_hp",
    "hp_offset",
    "sktpts_hm",
    "sktpts_reg",
    "semantic_mask",
)


def _conv_3x3(
    input_channels: int, output_channels: int, stride: int, groups: int
) -> nn.Conv2d:
    return nn.Conv2d(
        input_channels,
        output_channels,
        kernel_size=3,
        stride=stride,
        padding=1,
        groups=groups,
        bias=False,
    )


def _conv_1x1(
    input_channels: int, output_channels: int, stride: int
) -> nn.Conv2d:
    return nn.Conv2d(
        input_channels, output_channels, kernel_size=1, stride=stride, bias=False
    )


class Bottleneck(nn.Module):
    def __init__(
        self,
        input_channels: int,
        output_channels: int,
        stride: int,
        downsample: Optional[nn.Module],
        group_width: int,
    ) -> None:
        super().__init__()
        groups = output_channels // min(output_channels, group_width)
        self.conv1 = _conv_1x1(input_channels, output_channels, 1)
        self.bn1 = nn.BatchNorm2d(output_channels)
        self.conv2 = _conv_3x3(output_channels, output_channels, stride, groups)
        self.bn2 = nn.BatchNorm2d(output_channels)
        self.conv3 = _conv_1x1(output_channels, output_channels, 1)
        self.bn3 = nn.BatchNorm2d(output_channels)
        self.relu = nn.ReLU(inplace=True)
        self.downsample = downsample

    def forward(self, inputs: Tensor) -> Tensor:
        identity = inputs
        output = self.relu(self.bn1(self.conv1(inputs)))
        output = self.relu(self.bn2(self.conv2(output)))
        output = self.bn3(self.conv3(output))
        if self.downsample is not None:
            identity = self.downsample(inputs)
        return self.relu(output + identity)


class KeypointLiftedModel(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.inplanes = 32
        self.group_width = 16
        self.conv1 = nn.Conv2d(
            3, self.inplanes, kernel_size=3, stride=2, padding=1, bias=False
        )
        self.bn1 = nn.BatchNorm2d(self.inplanes)
        self.relu = nn.ReLU(inplace=True)
        self.layer1 = self._make_layer(32, 1)
        self.layer2 = self._make_layer(64, 2)
        self.layer3 = self._make_layer(160, 7)
        self.layer4 = self._make_layer(384, 12)
        self.deconv_layers = self._make_deconv_layers()
        for name, channels in HEADS.items():
            setattr(
                self,
                name,
                nn.Sequential(
                    nn.Conv2d(64, 64, kernel_size=3, padding=1, bias=True),
                    nn.ReLU(inplace=True),
                    nn.Conv2d(64, channels, kernel_size=1, bias=True),
                ),
            )

    def _make_layer(self, output_channels: int, block_count: int) -> nn.Sequential:
        downsample = nn.Sequential(
            _conv_1x1(self.inplanes, output_channels, 2),
            nn.BatchNorm2d(output_channels),
        )
        layers = [
            Bottleneck(
                self.inplanes,
                output_channels,
                stride=2,
                downsample=downsample,
                group_width=self.group_width,
            )
        ]
        self.inplanes = output_channels
        for _ in range(1, block_count):
            layers.append(
                Bottleneck(
                    self.inplanes,
                    output_channels,
                    stride=1,
                    downsample=None,
                    group_width=self.group_width,
                )
            )
        return nn.Sequential(*layers)

    def _make_deconv_layers(self) -> nn.Sequential:
        layers = []
        for output_channels in (256, 128, 64):
            layers.extend(
                (
                    nn.ConvTranspose2d(
                        self.inplanes,
                        output_channels,
                        kernel_size=4,
                        stride=2,
                        padding=1,
                        groups=8,
                        bias=False,
                    ),
                    nn.BatchNorm2d(output_channels, momentum=0.1),
                    nn.ReLU(inplace=True),
                )
            )
            self.inplanes = output_channels
        return nn.Sequential(*layers)

    def forward(self, inputs: Tensor) -> Dict[str, Tensor]:
        output = self.relu(self.bn1(self.conv1(inputs)))
        output = self.layer1(output)
        output = self.layer2(output)
        output = self.layer3(output)
        output = self.layer4(output)
        neck = self.deconv_layers(output)
        heads = {name: getattr(self, name)(neck) for name in HEADS}
        heads["semantic_mask"] = functional.interpolate(
            heads["semantic_mask"],
            size=(inputs.shape[2], inputs.shape[3]),
            mode="bilinear",
            align_corners=False,
        )
        return heads


def _checkpoint_state(checkpoint: object) -> Mapping[str, Tensor]:
    if not isinstance(checkpoint, Mapping):
        raise TypeError(
            "Checkpoint must be a mapping, got {}".format(type(checkpoint).__name__)
        )
    raw_state = checkpoint.get("state_dict", checkpoint)
    if not isinstance(raw_state, Mapping):
        raise TypeError("Checkpoint state_dict must be a mapping")
    state = {}
    for raw_name, value in raw_state.items():
        if not isinstance(raw_name, str) or not isinstance(value, Tensor):
            continue
        name = raw_name.replace("model.module.", "").replace("module.", "")
        if name.startswith("task_specific.") or "sem_loss" in name:
            continue
        state[name] = value
    return state


def load_model(checkpoint_path: Path, device: torch.device) -> KeypointLiftedModel:
    path = Path(checkpoint_path)
    if not path.is_file():
        raise FileNotFoundError("Checkpoint does not exist: {}".format(path))
    checkpoint = torch.load(str(path), map_location="cpu")
    state = _checkpoint_state(checkpoint)
    model = KeypointLiftedModel()
    expected = model.state_dict()
    incompatible_shapes = [
        "{}: checkpoint {} != model {}".format(
            name, tuple(value.shape), tuple(expected[name].shape)
        )
        for name, value in state.items()
        if name in expected and value.shape != expected[name].shape
    ]
    if incompatible_shapes:
        raise ValueError(
            "Checkpoint has incompatible tensor shapes: {}".format(
                "; ".join(incompatible_shapes)
            )
        )
    compatible = {name: value for name, value in state.items() if name in expected}
    missing = sorted(set(expected) - set(compatible))
    if missing:
        raise ValueError(
            "Checkpoint is missing {} required model tensors: {}".format(
                len(missing), ", ".join(missing[:10])
            )
        )
    model.load_state_dict(compatible, strict=True)
    model.to(device)
    model.eval()
    return model
