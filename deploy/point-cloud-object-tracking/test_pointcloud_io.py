from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pointcloud_io import PointCloudLoadError, load_point_cloud


class StreamingResponse:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.headers: dict[str, str] = {}

    def __enter__(self) -> 'StreamingResponse':
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def raise_for_status(self) -> None:
        return None

    def iter_content(self, chunk_size: int) -> list[bytes]:
        return self.chunks


class PointCloudCleanupTest(unittest.TestCase):
    def test_remote_temp_file_removed_when_parsing_fails(self) -> None:
        response = StreamingResponse([b'invalid'])
        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch('pointcloud_io.requests.get', return_value=response),
                patch.object(tempfile, 'tempdir', temp_dir),
            ):
                with self.assertRaises(PointCloudLoadError):
                    load_point_cloud('https://example.test/frame.bin')

            self.assertEqual([], list(Path(temp_dir).iterdir()))

    def test_partial_download_removed_when_limit_is_exceeded(self) -> None:
        response = StreamingResponse([b'1234', b'5678'])
        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch('pointcloud_io.requests.get', return_value=response),
                patch.object(tempfile, 'tempdir', temp_dir),
                patch.dict(os.environ, {'MAX_POINT_CLOUD_BYTES': '6'}),
            ):
                with self.assertRaisesRegex(
                    PointCloudLoadError, 'MAX_POINT_CLOUD_BYTES'
                ):
                    load_point_cloud('https://example.test/frame.bin')

            self.assertEqual([], list(Path(temp_dir).iterdir()))


if __name__ == '__main__':
    unittest.main()
