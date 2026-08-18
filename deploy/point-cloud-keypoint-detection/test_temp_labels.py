from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from centernet_detector import (
    _cleanup_normalized_label_files,
    _normalize_labels_file,
)


class NormalizedLabelsCleanupTest(unittest.TestCase):
    def test_normalized_labels_remain_until_process_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / 'labels.json'
            source_path.write_text(
                json.dumps({'polylineObj': ['curb']}),
                encoding='utf-8',
            )

            normalized_path = Path(_normalize_labels_file(str(source_path)))
            self.assertTrue(normalized_path.exists())
            self.assertEqual(
                ['curb'],
                json.loads(normalized_path.read_text(encoding='utf-8'))['polyline'],
            )

            _cleanup_normalized_label_files()
            self.assertFalse(normalized_path.exists())


if __name__ == '__main__':
    unittest.main()
