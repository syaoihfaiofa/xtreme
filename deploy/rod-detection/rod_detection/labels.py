import json
from pathlib import Path
from typing import Tuple


def load_labels(path: Path) -> Tuple[str, ...]:
    with Path(path).open("r", encoding="utf-8") as labels_file:
        payload = json.load(labels_file)
    if (
        not isinstance(payload, list)
        or not payload
        or any(not isinstance(label, str) or not label for label in payload)
    ):
        raise ValueError(
            "Label config must be a non-empty array of non-empty strings: {}".format(
                path
            )
        )
    labels = tuple(payload)
    if len(set(labels)) != len(labels):
        raise ValueError("Label config contains duplicate values: {}".format(path))
    return labels
