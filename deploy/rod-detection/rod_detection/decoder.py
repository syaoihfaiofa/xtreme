from typing import List, NamedTuple

import numpy as np


KEYPOINT_COUNT = 4
KEYPOINT_DIMENSIONS = 3
# Offsets boxes per class so a single greedy NMS pass never suppresses across classes.
_CLASS_OFFSET = 7680.0


class PoseDetection(NamedTuple):
    class_id: int
    score: float
    box_xyxy: np.ndarray
    keypoints: np.ndarray


def _xywh_to_xyxy(boxes: np.ndarray) -> np.ndarray:
    converted = np.empty_like(boxes)
    half_size = boxes[:, 2:4] / 2.0
    converted[:, 0:2] = boxes[:, 0:2] - half_size
    converted[:, 2:4] = boxes[:, 0:2] + half_size
    return converted


def _greedy_nms(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float) -> List[int]:
    x1, y1, x2, y2 = boxes.T
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)
    order = scores.argsort()[::-1]
    keep: List[int] = []
    while order.size > 0:
        best = int(order[0])
        keep.append(best)
        rest = order[1:]
        inter_width = np.maximum(
            0.0, np.minimum(x2[best], x2[rest]) - np.maximum(x1[best], x1[rest])
        )
        inter_height = np.maximum(
            0.0, np.minimum(y2[best], y2[rest]) - np.maximum(y1[best], y1[rest])
        )
        intersection = inter_width * inter_height
        iou = intersection / (areas[best] + areas[rest] - intersection + 1e-7)
        order = rest[iou <= iou_threshold]
    return keep


def decode_pose_output(
    output: np.ndarray,
    class_count: int,
    score_threshold: float,
    iou_threshold: float,
    max_detections: int,
) -> List[PoseDetection]:
    """Decode a raw Ultralytics pose head ``[1, 4 + nc + 4 * 3, anchors]``.

    Box and class channels are already decoded and sigmoid-activated by the exported
    head; coordinates are in model-input pixels.
    """
    expected_channels = 4 + class_count + KEYPOINT_COUNT * KEYPOINT_DIMENSIONS
    if output.ndim != 3 or output.shape[0] != 1 or output.shape[1] != expected_channels:
        raise ValueError(
            "ONNX output shape {} does not match expected [1, {}, anchors] for "
            "{} classes and {}x{} keypoints".format(
                output.shape,
                expected_channels,
                class_count,
                KEYPOINT_COUNT,
                KEYPOINT_DIMENSIONS,
            )
        )
    predictions = output[0].T.astype(np.float32)
    class_scores = predictions[:, 4 : 4 + class_count]
    class_ids = class_scores.argmax(axis=1)
    scores = class_scores.max(axis=1)
    selected = scores > score_threshold
    if not selected.any():
        return []
    predictions = predictions[selected]
    class_ids = class_ids[selected]
    scores = scores[selected]
    boxes = _xywh_to_xyxy(predictions[:, 0:4])
    offset_boxes = boxes + class_ids[:, None].astype(np.float32) * _CLASS_OFFSET
    keep = _greedy_nms(offset_boxes, scores, iou_threshold)[:max_detections]
    keypoints = predictions[:, 4 + class_count :].reshape(
        -1, KEYPOINT_COUNT, KEYPOINT_DIMENSIONS
    )
    return [
        PoseDetection(
            class_id=int(class_ids[index]),
            score=float(scores[index]),
            box_xyxy=boxes[index].copy(),
            keypoints=keypoints[index].copy(),
        )
        for index in keep
    ]
