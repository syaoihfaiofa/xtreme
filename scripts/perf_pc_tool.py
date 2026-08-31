#!/usr/bin/env python3
"""Browser performance acceptance runner for the Xtreme1 PC Tool.

Credentials and the fixture live outside the repository.  The generated reports intentionally
contain only metric values and request object names, never tokens, passwords or signed URLs.
"""
import argparse
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "artifacts" / "performance"
SAMPLE_COUNT = 30
MIN_SCENE_FRAMES = 500
LIMITS = {"cold_p95_ms": 1500, "hot_p95_ms": 500, "playback_fps": 10}


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * p
    lower, upper = math.floor(pos), math.ceil(pos)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (pos - lower)


def metric_summary(values):
    return {
        "count": len(values),
        "p50_ms": percentile(values, 0.50),
        "p95_ms": percentile(values, 0.95),
        "max_ms": max(values) if values else None,
    }


def required_env():
    names = [
        "XTREME1_PERF_BASE_URL",
        "XTREME1_PERF_USERNAME",
        "XTREME1_PERF_PASSWORD",
        "XTREME1_PERF_DATASET_ID",
        "XTREME1_PERF_SCENE_ID",
    ]
    values = {name: os.environ.get(name, "").strip() for name in names}
    return values, [name for name, value in values.items() if not value]


def login(base_url, username, password):
    request = urllib.request.Request(
        urllib.parse.urljoin(base_url + "/", "api/user/login"),
        data=json.dumps({"username": username, "password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    token = (payload.get("data") or {}).get("token")
    if payload.get("code") != "OK" or not token:
        raise RuntimeError("login failed; check XTREME1_PERF_USERNAME and XTREME1_PERF_PASSWORD")
    return token


def scene_url(base_url, dataset_id, scene_id):
    query = urllib.parse.urlencode({
        "datasetId": dataset_id,
        "dataId": scene_id,
        "dataType": "scene",
        "type": "readOnly",
    })
    return urllib.parse.urljoin(base_url + "/", "tool/pc") + "?" + query


def request_name(url):
    return Path(urllib.parse.urlsplit(url).path).name


def evenly_spaced(total, count):
    if total < 2:
        return [1]
    count = min(count, total - 1)
    return sorted({max(2, min(total, round(2 + i * (total - 2) / max(1, count - 1)))) for i in range(count)})


class BrowserRun:
    def __init__(self, browser, config, request_names):
        self.browser = browser
        self.config = config
        self.request_names = request_names
        self.context = None
        self.page = None

    def open(self):
        self.context = self.browser.new_context(viewport={"width": 1920, "height": 1080})
        host = urllib.parse.urlsplit(self.config["XTREME1_PERF_BASE_URL"]).hostname
        self.context.add_cookies([{
            "name": f"{host} token",
            "value": self.config["token"],
            "domain": host,
            "path": "/",
        }])
        self.page = self.context.new_page()
        self.page.add_init_script("""
            window.__pcPerfMetrics = [];
            window.addEventListener('pc-performance-metric', function(event) {
              window.__pcPerfMetrics.push(event.detail);
            });
        """)
        self.page.on("request", lambda request: self.request_names.append(request_name(request.url))
                            if request_name(request.url).endswith(".pcd") else None)
        self.page.goto(scene_url(
            self.config["XTREME1_PERF_BASE_URL"],
            self.config["XTREME1_PERF_DATASET_ID"],
            self.config["XTREME1_PERF_SCENE_ID"],
        ), wait_until="domcontentloaded", timeout=120000)
        frame_input = self.page.locator('[data-testid="pc-perf-frame-index"] input, input[data-testid="pc-perf-frame-index"]').first
        frame_input.wait_for(timeout=120000)
        self.page.wait_for_function("window.__pcPerfMetrics.some(m => m.name === 'frame-interactive')", timeout=120000)
        maximum = frame_input.get_attribute("max")
        if not maximum:
            raise RuntimeError("frame index control does not expose a maximum frame count")
        return int(maximum)

    def jump(self, frame_index):
        before = self.page.evaluate("window.__pcPerfMetrics.length")
        frame_input = self.page.locator('[data-testid="pc-perf-frame-index"] input, input[data-testid="pc-perf-frame-index"]').first
        frame_input.fill(str(frame_index))
        frame_input.press("Enter")
        self.page.wait_for_function(
            "([before]) => window.__pcPerfMetrics.slice(before).some(m => m.name === 'frame-interactive')",
            arg=[before], timeout=120000,
        )
        metrics = self.page.evaluate("([before]) => window.__pcPerfMetrics.slice(before)", [before])
        interactive = [metric for metric in metrics if metric.get("name") == "frame-interactive"]
        if not interactive:
            raise RuntimeError(f"frame {frame_index} did not emit frame-interactive")
        return interactive[-1]["duration"], metrics

    def playback(self, seconds, direction):
        if direction < 0:
            self.page.locator('[data-testid="pc-perf-prev-frame"]').click()
        before = self.page.evaluate("window.__pcPerfMetrics.length")
        self.page.locator('[data-testid="pc-perf-play-toggle"]').click()
        self.page.wait_for_timeout(seconds * 1000)
        # The player may have stopped itself on a buffer miss.  Click only if its pause icon is visible.
        pause_icon = self.page.locator('[data-testid="pc-perf-play-toggle"] .icon-guaqi')
        if pause_icon.count() and pause_icon.is_visible():
            self.page.locator('[data-testid="pc-perf-play-toggle"]').click()
        return self.page.evaluate("([before]) => window.__pcPerfMetrics.slice(before)", [before])

    def close(self):
        if self.context:
            self.context.close()


def write_report(report):
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = REPORT_DIR / f"pc-perf-{stamp}.json"
    markdown_path = REPORT_DIR / f"pc-perf-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    checks = report["checks"]
    full_p95 = report["full_point_ready"]["p95_ms"]
    markdown_path.write_text("\n".join([
        "# PC Tool performance report",
        "",
        f"- Mode: `{report['mode']}`",
        f"- Scene frames: {report['scene_frames']}",
        f"- Result: **{'SMOKE — not an SLA gate' if report['mode'] == 'smoke' else ('PASS' if checks['passed'] else 'FAIL')}**",
        "",
        "| Metric | Result | Limit |",
        "|---|---:|---:|",
        f"| Cold frame-interactive P95 | {report['cold']['p95_ms']:.1f} ms | ≤ 1500 ms |",
        f"| Hot frame-interactive P95 | {report['hot']['p95_ms']:.1f} ms | ≤ 500 ms |",
        f"| Full point ready P95 | {full_p95:.1f} ms | informational |" if full_p95 is not None else "| Full point ready P95 | n/a | informational |",
        f"| Playback FPS | {report['playback_fps']:.1f} | ≥ 10 |",
        f"| Preview hit rate | {report['preview_hit_rate']:.1%} | 100% |",
        "",
        "Full data is in the adjacent JSON report. URLs, tokens and passwords are intentionally omitted.",
    ]) + "\n")
    return json_path, markdown_path


def run_smoke_tests():
    if not shutil.which("node"):
        print("cache-policy unit test skipped; node is not installed")
        return 0
    result = subprocess.run(["node", "frontend/pc-tool/tests/cachePolicy.test.cjs"], cwd=ROOT)
    return result.returncode


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--smoke", action="store_true", help="allow a scene with fewer than 500 frames and do not enforce SLA")
    parser.add_argument("--samples", type=int, default=SAMPLE_COUNT)
    args = parser.parse_args()
    config, missing = required_env()
    if missing:
        print("performance acceptance skipped; missing " + ", ".join(missing))
        return run_smoke_tests()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise RuntimeError("Playwright is required for browser performance acceptance") from error
    config["token"] = login(config["XTREME1_PERF_BASE_URL"], config["XTREME1_PERF_USERNAME"], config["XTREME1_PERF_PASSWORD"])
    requests = []
    cold, hot, playback_metrics, all_metrics = [], [], [], []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        # A fresh context per cold sample prevents browser and in-memory resource reuse.
        scene_frames = None
        for index in range(args.samples):
            run = BrowserRun(browser, config, requests)
            total = run.open()
            scene_frames = total
            samples = evenly_spaced(total, args.samples)
            duration, metrics = run.jump(samples[index % len(samples)])
            cold.append(duration)
            all_metrics.extend(metrics)
            run.close()
        hot_run = BrowserRun(browser, config, requests)
        total = hot_run.open()
        scene_frames = total
        for frame in evenly_spaced(total, args.samples):
            duration, metrics = hot_run.jump(frame)
            hot.append(duration)
            all_metrics.extend(metrics)
        playback_metrics.extend(hot_run.playback(10, 1))
        playback_metrics.extend(hot_run.playback(10, -1))
        hot_run.close()
        browser.close()
    preview_requests = set(name for name in requests if name.startswith("preview-binary-"))
    full_requests = set(name for name in requests if name.startswith("binary-"))
    fps = [metric.get("detail", {}).get("fps") for metric in playback_metrics if metric.get("name") == "playback-fps"]
    fps = [value for value in fps if isinstance(value, (int, float))]
    all_metrics.extend(playback_metrics)
    full_ready = [metric["duration"] for metric in all_metrics if metric.get("name") == "full-point-ready"]
    worker_decode = [metric["duration"] for metric in all_metrics if metric.get("name") == "worker-decode"]
    heap_values = [metric.get("detail", {}).get("jsHeapBytes") for metric in all_metrics if metric.get("name") == "memory-snapshot"]
    resource_values = [metric.get("detail", {}).get("resourceBytes") for metric in all_metrics if metric.get("name") == "memory-snapshot"]
    report = {
        "version": 1,
        "mode": "smoke" if args.smoke else "acceptance",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "scene_frames": scene_frames,
        "sample_count": len(cold),
        "cold": metric_summary(cold),
        "hot": metric_summary(hot),
        "full_point_ready": metric_summary(full_ready),
        "worker_decode": metric_summary(worker_decode),
        "playback_fps": min(fps) if fps else 0,
        "preview_hit_rate": len(preview_requests) / max(1, len(full_requests)),
        "js_heap_peak_bytes": max((value for value in heap_values if isinstance(value, (int, float))), default=None),
        "estimated_resource_peak_bytes": max((value for value in resource_values if isinstance(value, (int, float))), default=None),
        "request_object_names": sorted(set(requests)),
        "browser": "Chromium via Playwright",
        "platform": platform.platform(),
        "viewport": "1920x1080",
        "checks": {},
    }
    passed = (
        len(cold) >= args.samples
        and len(hot) >= args.samples
        and (args.smoke or scene_frames >= MIN_SCENE_FRAMES)
        and (args.smoke or report["preview_hit_rate"] == 1)
        and (args.smoke or report["cold"]["p95_ms"] <= LIMITS["cold_p95_ms"])
        and (args.smoke or report["hot"]["p95_ms"] <= LIMITS["hot_p95_ms"])
        and (args.smoke or report["playback_fps"] >= LIMITS["playback_fps"])
    )
    report["checks"] = {"passed": passed, "limits": LIMITS}
    json_path, markdown_path = write_report(report)
    print(f"performance report: {markdown_path}")
    print(f"machine report: {json_path}")
    return 0 if args.smoke or passed else 1


if __name__ == "__main__":
    sys.exit(main())
