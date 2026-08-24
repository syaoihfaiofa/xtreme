from __future__ import annotations

import unittest

from scene_association import associate_scene, bev_iou, project_pose


class SceneAssociationTest(unittest.TestCase):
    def test_project_pose_moves_box_into_target_vehicle_frame(self) -> None:
        x, y, _z, yaw = project_pose(
            local_x=2.0,
            local_y=0.0,
            local_z=0.5,
            local_yaw=0.0,
            source_pose={"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
            target_pose={"x": 3.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
        )
        self.assertAlmostEqual(x, -1.0)
        self.assertAlmostEqual(y, 0.0)
        self.assertAlmostEqual(yaw, 0.0)

    def test_associate_scene_links_same_object_by_projected_iou(self) -> None:
        response = associate_scene(
            {
                "config": {"iouThreshold": 0.3, "maxOutsideFrames": 50},
                "frames": [
                    {
                        "dataId": 1,
                        "frameIndex": 0,
                        "pose": {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
                        "objects": [
                            object_dict("a", "vehicle", 5.0, 0.0),
                            object_dict("b", "vehicle", -4.0, 1.0),
                        ],
                    },
                    {
                        "dataId": 2,
                        "frameIndex": 1,
                        "pose": {"x": 3.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
                        "objects": [
                            object_dict("c", "vehicle", 2.0, 0.0),
                            object_dict("d", "vehicle", -7.0, 1.0),
                        ],
                    },
                ],
            }
        )
        first = {obj["predictionId"]: obj["trackingId"] for obj in response["frames"][0]["objects"]}
        second = {obj["predictionId"]: obj["trackingId"] for obj in response["frames"][1]["objects"]}
        self.assertEqual(first["a"], second["c"])
        self.assertEqual(first["b"], second["d"])
        self.assertNotEqual(first["a"], first["b"])

    def test_associate_scene_keeps_separate_tracks_when_iou_is_low(self) -> None:
        response = associate_scene(
            {
                "config": {"iouThreshold": 0.3, "maxOutsideFrames": 50},
                "frames": [
                    {
                        "dataId": 1,
                        "frameIndex": 0,
                        "pose": {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
                        "objects": [object_dict("a", "pillar", 5.0, 0.0)],
                    },
                    {
                        "dataId": 2,
                        "frameIndex": 1,
                        "pose": {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
                        "objects": [object_dict("b", "pillar", 20.0, 0.0)],
                    },
                ],
            }
        )
        first_id = response["frames"][0]["objects"][0]["trackingId"]
        second_id = response["frames"][1]["objects"][0]["trackingId"]
        self.assertNotEqual(first_id, second_id)

    def test_associate_scene_links_thin_objects_by_center_distance(self) -> None:
        first = object_dict("a", "pole", 5.0, 0.0)
        first["dx"] = first["dy"] = 0.1
        second = object_dict("b", "pole", 5.3, 0.0)
        second["dx"] = second["dy"] = 0.1
        response = associate_scene(
            {
                "config": {
                    "iouThreshold": 0.3,
                    "distanceThreshold": 0.5,
                    "maxOutsideFrames": 50,
                },
                "frames": [
                    {
                        "dataId": 1,
                        "frameIndex": 0,
                        "pose": {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
                        "objects": [first],
                    },
                    {
                        "dataId": 2,
                        "frameIndex": 1,
                        "pose": {"x": 0.0, "y": 0.0, "z": 0.0, "yaw": 0.0},
                        "objects": [second],
                    },
                ],
            }
        )
        self.assertEqual(
            response["frames"][0]["objects"][0]["trackingId"],
            response["frames"][1]["objects"][0]["trackingId"],
        )

    def test_bev_iou_is_one_for_identical_boxes(self) -> None:
        box = {"x": 1.0, "y": 2.0, "dx": 2.0, "dy": 1.0, "rotZ": 0.2}
        self.assertAlmostEqual(bev_iou(box, box), 1.0)


def object_dict(prediction_id: str, label: str, x: float, y: float) -> dict:
    return {
        "predictionId": prediction_id,
        "label": label,
        "confidence": 0.9,
        "x": x,
        "y": y,
        "z": 0.5,
        "dx": 4.0,
        "dy": 2.0,
        "dz": 1.5,
        "rotX": 0.0,
        "rotY": 0.0,
        "rotZ": 0.0,
        "datasetClassId": 12,
    }


if __name__ == "__main__":
    unittest.main()
