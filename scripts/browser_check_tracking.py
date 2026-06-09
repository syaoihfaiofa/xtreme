#!/usr/bin/env python3
"""Headless browser check for Xtreme1 tracking UI."""
import json
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8190"


def get_token():
    req = urllib.request.Request(
        f"{BASE}/api/user/login",
        data=json.dumps({"username": "tracktest@example.com", "password": "Test1234"}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        body = json.loads(resp.read())
    return body["data"]["token"]


def main():
    token = get_token()
    findings = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1920, "height": 1080})
        context.add_cookies(
            [
                {
                    "name": "localhost token",
                    "value": token,
                    "domain": "localhost",
                    "path": "/",
                }
            ]
        )
        page = context.new_page()
        page.goto(f"{BASE}/", wait_until="networkidle", timeout=60000)

        findings.append(f"Main page title: {page.title()}")

        # Open pc-tool annotation if record exists
        page.goto(
            f"{BASE}/tool/pc?recordId=9&datasetId=1&itemType=SCENE",
            wait_until="networkidle",
            timeout=120000,
        )
        page.wait_for_timeout(20000)

        findings.append(f"PC tool URL: {page.url}")

        # Check timeline / series frame UI
        timeline = page.locator(".bottom-operation-container")
        findings.append(f"Timeline visible: {timeline.count() > 0 and timeline.is_visible()}")

        cuboid_panel = page.locator(".main-class-edit")
        findings.append(f"Cuboid panel container exists: {cuboid_panel.count() > 0}")

        # Inspect bundled main.vue config in loaded JS (via page content search is hard);
        # check toolbar right buttons count
        delete_btn = page.locator(".bar-right .ant-btn")
        findings.append(f"Timeline toolbar right buttons: {delete_btn.count()}")

        page.screenshot(path="/home/lxzhu2/project/xtreme1/scripts/screenshot_pc_tool.png", full_page=True)
        findings.append("Screenshot: scripts/screenshot_pc_tool.png")

        browser.close()

    print("\n".join(findings))


if __name__ == "__main__":
    main()
