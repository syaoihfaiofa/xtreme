#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("perf_pc_tool.py")
spec = importlib.util.spec_from_file_location("perf_pc_tool", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PerformanceStatsTest(unittest.TestCase):
    def test_percentile_and_summary(self):
        self.assertEqual(module.percentile([1, 2, 3, 4, 5], 0.5), 3)
        self.assertEqual(module.percentile([1, 2, 3, 4, 5], 0.95), 4.8)
        self.assertEqual(module.metric_summary([10, 20])["p95_ms"], 19.5)

    def test_evenly_spaced_is_valid_and_deterministic(self):
        samples = module.evenly_spaced(500, 30)
        self.assertEqual(len(samples), 30)
        self.assertEqual(samples, sorted(samples))
        self.assertGreaterEqual(min(samples), 2)
        self.assertLessEqual(max(samples), 500)


if __name__ == "__main__":
    unittest.main()
