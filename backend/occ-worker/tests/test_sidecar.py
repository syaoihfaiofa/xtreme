import unittest

from xtreme_occ.sidecar import build_frame_sidecar


class BuildFrameSidecarTest(unittest.TestCase):
    def test_builds_object_id_keyed_visibility_without_annotation_mutation(self) -> None:
        result = build_frame_sidecar(
            scene_id="scene-1",
            frame_token="frame-001",
            source_hash="abc123",
            algorithm_version="xtreme-occ-v1",
            boxes={
                "box-1": {
                    "visibleRatio": 0.75,
                    "visibleRatioByView": {"0": 0.75, "1": 0.0, "2": 0.0, "3": 0.0},
                    "occluded": False,
                }
            },
            polylines={
                "line-1": {
                    "segmentVisibilityByView": {
                        "0": [{"index": 0, "visible": True}],
                        "bev": [{"index": 0, "visible": True}],
                    },
                    "segmentMeta": {"numSegments": 1},
                }
            },
            occ={"voxelSize": 0.1, "pcRange": [-15, -15, -0.7, 15, 15, 1.3]},
        )

        self.assertEqual("xtreme-visibility/v1", result["schemaVersion"])
        self.assertEqual("scene-1", result["sceneId"])
        self.assertEqual("frame-001", result["frameToken"])
        self.assertEqual("abc123", result["source"]["hash"])
        self.assertEqual(False, result["objects"]["box-1"]["occluded"])
        self.assertEqual(True, result["polylines"]["line-1"]["segmentVisibilityByView"]["bev"][0]["visible"])
        self.assertEqual(0.1, result["occ"]["voxelSize"])


if __name__ == "__main__":
    unittest.main()
