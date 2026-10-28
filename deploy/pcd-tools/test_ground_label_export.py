import unittest
from io import BytesIO

import lzf
import numpy as np

from pcd_tools.ground_label_export import append_ground_labels
from pcd_tools.load_pcd import PointCloud


class AppendGroundLabelsTest(unittest.TestCase):
    def test_appends_ground_field_preserves_fields_and_overrides_automatic_result(self):
        points = np.array(
            [
                (0.0, 0.0, 0.0, 100, 100, 100, 100.0, 9),
                (2.0, 0.0, 0.0, 20, 30, 40, 100.0, 8),
            ],
            dtype=[
                ('x', np.float32),
                ('y', np.float32),
                ('z', np.float32),
                ('r', np.uint8),
                ('g', np.uint8),
                ('b', np.uint8),
                ('intensity', np.float32),
                ('ring', np.uint16),
            ],
        )

        labeled, rule = append_ground_labels(
            points,
            {
                'version': 1,
                'operations': [
                    {
                        'type': 'polygon',
                        'vertices': [
                            {'x': -1.0, 'y': -1.0},
                            {'x': 1.0, 'y': -1.0},
                            {'x': 1.0, 'y': 1.0},
                            {'x': -1.0, 'y': 1.0},
                        ],
                    },
                ],
            },
        )

        self.assertEqual(
            labeled.dtype.names,
            ('x', 'y', 'z', 'r', 'g', 'b', 'intensity', 'ring', 'ground'),
        )
        self.assertEqual(labeled.dtype['ground'], np.dtype(np.uint8))
        np.testing.assert_array_equal(labeled['ring'], np.array([9, 8], dtype=np.uint16))
        np.testing.assert_array_equal(labeled['ground'], np.array([1, 1], dtype=np.uint8))
        self.assertEqual(rule, 'auto-plus-manual')

    def test_uses_manual_only_when_color_or_intensity_is_missing(self):
        points = np.array(
            [(0.0, 0.0, 0.0), (2.0, 0.0, 0.0)],
            dtype=[('x', np.float32), ('y', np.float32), ('z', np.float32)],
        )

        labeled, rule = append_ground_labels(
            points,
            {
                'version': 1,
                'operations': [
                    {
                        'type': 'brush',
                        'center': {'x': 0.0, 'y': 0.0},
                        'radius': 0.5,
                    },
                ],
            },
        )

        np.testing.assert_array_equal(labeled['ground'], np.array([1, 0], dtype=np.uint8))
        self.assertEqual(rule, 'manual-only')

    def test_rejects_invalid_mask_payload(self):
        points = np.array(
            [(0.0, 0.0, 0.0)],
            dtype=[('x', np.float32), ('y', np.float32), ('z', np.float32)],
        )

        with self.assertRaisesRegex(ValueError, 'groundCorrectionMask'):
            append_ground_labels(points, {'version': 2, 'operations': []})

    def test_preserves_binary_count_width_height_and_viewpoint_schema(self):
        source = _binary_pcd(compressed=False)
        point_cloud = PointCloud(BytesIO(source), valid_points=False)
        labeled, _ = append_ground_labels(point_cloud.data, None)
        output = BytesIO()

        point_cloud.save_pcd(labeled, output, point_cloud.metadata)

        exported = PointCloud(BytesIO(output.getvalue()), valid_points=False)
        self.assertEqual(exported.metadata['fields'], ['x', 'y', 'z', 'normal', 'ground'])
        self.assertEqual(exported.metadata['count'], [1, 1, 1, 3, 1])
        self.assertEqual(exported.metadata['width'], 2)
        self.assertEqual(exported.metadata['height'], 1)
        self.assertEqual(exported.metadata['viewpoint'], [1.0, 2.0, 3.0, 1.0, 0.0, 0.0, 0.0])
        np.testing.assert_array_equal(exported.data['normal_0002'], np.array([0.3, 0.6], dtype=np.float32))
        np.testing.assert_array_equal(exported.data['ground'], np.array([0, 0], dtype=np.uint8))

    def test_reads_compressed_count_schema_and_appends_ground(self):
        point_cloud = PointCloud(BytesIO(_binary_pcd(compressed=True)), valid_points=False)
        labeled, rule = append_ground_labels(point_cloud.data, None)
        output = BytesIO()

        point_cloud.save_pcd(labeled, output, point_cloud.metadata)

        exported = PointCloud(BytesIO(output.getvalue()), valid_points=False)
        self.assertEqual(rule, 'manual-only')
        self.assertEqual(exported.metadata['count'], [1, 1, 1, 3, 1])
        self.assertEqual(exported.metadata['width'], 2)
        np.testing.assert_array_equal(exported.data['normal_0000'], np.array([0.1, 0.4], dtype=np.float32))


def _binary_pcd(compressed):
    points = np.array(
        [
            (0.0, 0.0, 0.0, 0.1, 0.2, 0.3),
            (1.0, 2.0, 3.0, 0.4, 0.5, 0.6),
        ],
        dtype=[
            ('x', np.float32),
            ('y', np.float32),
            ('z', np.float32),
            ('normal_0000', np.float32),
            ('normal_0001', np.float32),
            ('normal_0002', np.float32),
        ],
    )
    header = (
        '# .PCD v0.7 - Point Cloud Data file format\n'
        'VERSION 0.7\n'
        'FIELDS x y z normal\n'
        'SIZE 4 4 4 4\n'
        'TYPE F F F F\n'
        'COUNT 1 1 1 3\n'
        'WIDTH 2\n'
        'HEIGHT 1\n'
        'VIEWPOINT 1 2 3 1 0 0 0\n'
        'POINTS 2\n'
    ).encode('ascii')
    if not compressed:
        return header + b'DATA binary\n' + points.tobytes()

    field_major = b''.join(points[name].tobytes() for name in points.dtype.names)
    compressed = lzf.compress(field_major)
    return (
        header
        + b'DATA binary_compressed\n'
        + np.array([len(compressed), len(field_major)], dtype=np.uint32).tobytes()
        + compressed
    )


if __name__ == '__main__':
    unittest.main()
