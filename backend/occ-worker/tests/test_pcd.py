import os
import tempfile
import unittest

import numpy as np

from xtreme_occ.pcd import read_pcd_xyz


class ReadPcdXyzTest(unittest.TestCase):
    def test_reads_ascii_xyz_and_ignores_extra_fields(self) -> None:
        content = """# .PCD v0.7
VERSION 0.7
FIELDS x y z intensity
SIZE 4 4 4 4
TYPE F F F F
COUNT 1 1 1 1
WIDTH 2
HEIGHT 1
POINTS 2
DATA ascii
1.0 2.0 3.0 4.0
5.0 6.0 7.0 8.0
"""
        descriptor, path = tempfile.mkstemp(suffix=".pcd")
        try:
            with os.fdopen(descriptor, "w") as stream:
                stream.write(content)

            points = read_pcd_xyz(path)

            np.testing.assert_allclose(points, [[1.0, 2.0, 3.0], [5.0, 6.0, 7.0]])
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
