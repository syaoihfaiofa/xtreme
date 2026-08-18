from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from detection_service import DetectionService, InputLimitError


class DownloadLimitTest(unittest.TestCase):
    def test_streamed_download_rejects_body_larger_than_limit(self) -> None:
        response = MagicMock()
        response.__enter__.return_value = response
        response.headers = {}
        response.raise_for_status.return_value = None
        response.iter_content.return_value = [b'1234', b'5678']

        service = DetectionService.__new__(DetectionService)
        service.config = SimpleNamespace(http_timeout=20)

        with patch('detection_service.requests.get', return_value=response):
            with self.assertRaisesRegex(
                InputLimitError, 'MAX_IMAGE_DOWNLOAD_BYTES'
            ):
                service._download_bytes(
                    'https://example.test/image.jpg',
                    max_bytes=6,
                    limit_name='MAX_IMAGE_DOWNLOAD_BYTES',
                )


if __name__ == '__main__':
    unittest.main()
