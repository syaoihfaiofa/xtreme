#!/usr/bin/env python3
"""Populate a labels-only nuScenes export with Xtreme1 raw sensor files."""

import argparse
import json
import re
import shutil
from pathlib import Path


DEFAULT_VERSION = "v1.0-mini"
LIDAR_CHANNEL = "LIDAR_TOP"
# Source files ending in _0, _1, _2, _3 mean front, left, back, right.
CAMERA_CHANNELS = ("CAM_FRONT", "CAM_LEFT", "CAM_BACK", "CAM_RIGHT")
LEGACY_UUID_PREFIX = re.compile(r"^[0-9a-f]{32}_")


def files_by_stem(directory):
    files = {}
    if not directory.is_dir():
        return files
    for path in directory.iterdir():
        if path.is_file():
            files.setdefault(path.stem, path)
    return files


def copy_or_link(source, destination, link):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.samefile(source):
            return "existing"
        destination.unlink()
    if link:
        destination.hardlink_to(source)
    else:
        shutil.copy2(source, destination)
    return "linked" if link else "copied"


def source_camera_file(camera_files, frame_name, camera_index):
    return camera_files.get(f"{frame_name}_{camera_index}")


def frame_name_from_filename(filename):
    """Return the raw frame name from current and older UUID-prefixed exports."""
    return LEGACY_UUID_PREFIX.sub("", Path(filename).stem)


def scenes_from_root(root):
    """Accept either one scene directory or its parent containing scene directories."""
    root = Path(root)
    if (root / "lidar_point_cloud").is_dir() or (root / "camera_image").is_dir():
        return [root]
    if not root.is_dir():
        raise FileNotFoundError(f"Input root does not exist: {root}")
    return sorted(
        path
        for path in root.iterdir()
        if path.is_dir()
        and ((path / "lidar_point_cloud").is_dir() or (path / "camera_image").is_dir())
    )


def populate(source_scenes, dataroot, version, link=False):
    source_scenes = [Path(scene) for scene in source_scenes]
    dataroot = Path(dataroot)
    metadata_path = dataroot / version / "sample_data.json"
    if not metadata_path.is_file():
        raise FileNotFoundError(f"nuScenes metadata was not found: {metadata_path}")

    sample_data = json.loads(metadata_path.read_text(encoding="utf-8"))
    lidar_files, camera_files = {}, {}
    for source_scene in source_scenes:
        lidar_files.update(files_by_stem(source_scene / "lidar_point_cloud"))
        camera_files.update(files_by_stem(source_scene / "camera_image"))
    stats = {"copied": 0, "linked": 0, "existing": 0, "rewritten": 0, "missing": []}

    for item in sample_data:
        channel = item.get("channel")
        if not channel:
            # Standard nuScenes sample_data records do not include channel.
            # Resolve it from the target filename's parent directory instead.
            channel = Path(item["filename"]).parent.name
        frame_name = frame_name_from_filename(item["filename"])
        source = None
        if channel == LIDAR_CHANNEL:
            source = lidar_files.get(frame_name)
        elif channel in CAMERA_CHANNELS:
            source = source_camera_file(camera_files, frame_name, CAMERA_CHANNELS.index(channel))

        if source is None:
            stats["missing"].append({"channel": channel, "filename": item["filename"]})
            continue
        filename = f"samples/{channel}/{source.name}"
        if item["filename"] != filename:
            item["filename"] = filename
            item["fileformat"] = source.suffix.lower().lstrip(".")
            stats["rewritten"] += 1
        target = dataroot / filename
        result = copy_or_link(source, target, link)
        stats[result] += 1
    metadata_path.write_text(json.dumps(sample_data, indent=2), encoding="utf-8")
    return stats


def main():
    parser = argparse.ArgumentParser(
        description="Copy raw PCD and camera files into a labels-only nuScenes export."
    )
    parser.add_argument(
        "--source-scene",
        action="append",
        help="Xtreme1 source scene directory; specify this option repeatedly for multiple scenes",
    )
    parser.add_argument(
        "--input-root",
        action="append",
        help="A scene directory or a parent directory containing multiple scene directories",
    )
    parser.add_argument(
        "--dataroot",
        required=True,
        help="Extracted nuScenes export directory",
    )
    parser.add_argument(
        "--version",
        default=DEFAULT_VERSION,
        help="Metadata version directory to populate (default: v1.0-mini)",
    )
    parser.add_argument(
        "--link",
        action="store_true",
        help="Create hard links instead of copying files when source and destination share a filesystem",
    )
    args = parser.parse_args()
    source_scenes = args.source_scene or []
    for input_root in args.input_root or []:
        source_scenes.extend(scenes_from_root(input_root))
    if not source_scenes:
        source_scenes = [
            "/PnP/lxzhu/lidar_data_prepare/data/finally_data2/2026-07-20-11-25-13"
        ]
    stats = populate(source_scenes, args.dataroot, args.version, args.link)
    print(
        f"copied={stats['copied']} linked={stats['linked']} "
        f"existing={stats['existing']} rewritten={stats['rewritten']} "
        f"missing={len(stats['missing'])}"
    )
    if stats["missing"]:
        for item in stats["missing"][:20]:
            print(f"missing: {item['channel']} {item['filename']}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
