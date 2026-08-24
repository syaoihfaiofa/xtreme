#!/usr/bin/env python3
"""Split every nuScenes scene by time: first 90% train, final 10% test."""

import argparse
import copy
import json
import math
import shutil
from collections import defaultdict
from pathlib import Path


TABLES = (
    "attribute", "calibrated_sensor", "category", "ego_pose", "instance", "log",
    "map", "sample", "sample_annotation", "sample_data", "scene", "sensor",
    "visibility",
)


def read_tables(directory):
    return {
        table: json.loads((directory / f"{table}.json").read_text(encoding="utf-8"))
        for table in TABLES
    }


def write_tables(directory, tables):
    directory.mkdir(parents=True, exist_ok=False)
    for table in TABLES:
        (directory / f"{table}.json").write_text(
            json.dumps(tables[table], indent=2),
            encoding="utf-8",
        )


def relink(records, key):
    records.sort(key=lambda item: (item["timestamp"], item["token"]))
    for index, item in enumerate(records):
        item["prev"] = records[index - 1]["token"] if index else ""
        item["next"] = records[index + 1]["token"] if index + 1 < len(records) else ""


def subset_tables(source, sample_tokens):
    sample_tokens = set(sample_tokens)
    samples_by_token = {sample["token"]: copy.deepcopy(sample) for sample in source["sample"]}
    selected_samples = [
        samples_by_token[token] for token in sample_tokens if token in samples_by_token
    ]

    samples_by_scene = defaultdict(list)
    for sample in selected_samples:
        samples_by_scene[sample["scene_token"]].append(sample)
    for samples in samples_by_scene.values():
        relink(samples, "sample")

    source_scenes = {scene["token"]: scene for scene in source["scene"]}
    scenes = []
    selected_scene_tokens = set()
    for scene_token, samples in samples_by_scene.items():
        if not samples:
            continue
        scene = copy.deepcopy(source_scenes[scene_token])
        scene["nbr_samples"] = len(samples)
        scene["first_sample_token"] = samples[0]["token"]
        scene["last_sample_token"] = samples[-1]["token"]
        scenes.append(scene)
        selected_scene_tokens.add(scene_token)

    annotations = [
        copy.deepcopy(annotation)
        for annotation in source["sample_annotation"]
        if annotation["sample_token"] in sample_tokens
    ]
    annotations_by_instance = defaultdict(list)
    for annotation in annotations:
        annotations_by_instance[annotation["instance_token"]].append(annotation)
    for records in annotations_by_instance.values():
        records.sort(key=lambda item: (
            samples_by_token[item["sample_token"]]["timestamp"],
            item["token"],
        ))
        for index, item in enumerate(records):
            item["prev"] = records[index - 1]["token"] if index else ""
            item["next"] = records[index + 1]["token"] if index + 1 < len(records) else ""

    source_instances = {instance["token"]: instance for instance in source["instance"]}
    instances = []
    for instance_token, records in annotations_by_instance.items():
        instance = copy.deepcopy(source_instances[instance_token])
        instance["nbr_annotations"] = len(records)
        instance["first_annotation_token"] = records[0]["token"]
        instance["last_annotation_token"] = records[-1]["token"]
        instances.append(instance)

    sample_data = [
        copy.deepcopy(item)
        for item in source["sample_data"]
        if item["sample_token"] in sample_tokens
    ]
    sample_data_by_channel = defaultdict(list)
    for item in sample_data:
        sample = samples_by_token[item["sample_token"]]
        sample_data_by_channel[
            (sample["scene_token"], item["calibrated_sensor_token"])
        ].append(item)
    for records in sample_data_by_channel.values():
        relink(records, "sample_data")

    ego_pose_tokens = {item["ego_pose_token"] for item in sample_data}
    calibrated_tokens = {item["calibrated_sensor_token"] for item in sample_data}
    calibrated_sensors = [
        copy.deepcopy(item)
        for item in source["calibrated_sensor"]
        if item["token"] in calibrated_tokens
    ]
    sensor_tokens = {item["sensor_token"] for item in calibrated_sensors}
    category_tokens = {item["category_token"] for item in instances}
    visibility_tokens = {item["visibility_token"] for item in annotations}
    attribute_tokens = {
        token for annotation in annotations for token in annotation["attribute_tokens"]
    }
    log_tokens = {
        scene["log_token"] for scene in scenes if scene.get("log_token")
    }
    maps = []
    for item in source["map"]:
        item = copy.deepcopy(item)
        item["log_tokens"] = [
            token for token in item.get("log_tokens", []) if token in log_tokens
        ]
        if item["log_tokens"]:
            maps.append(item)

    return {
        "attribute": [item for item in source["attribute"] if item["token"] in attribute_tokens],
        "calibrated_sensor": calibrated_sensors,
        "category": [item for item in source["category"] if item["token"] in category_tokens],
        "ego_pose": [item for item in source["ego_pose"] if item["token"] in ego_pose_tokens],
        "instance": instances,
        "log": [item for item in source["log"] if item["token"] in log_tokens],
        "map": maps,
        "sample": sorted(selected_samples, key=lambda item: (item["scene_token"], item["timestamp"])),
        "sample_annotation": annotations,
        "sample_data": sample_data,
        "scene": scenes,
        "sensor": [item for item in source["sensor"] if item["token"] in sensor_tokens],
        "visibility": [item for item in source["visibility"] if item["token"] in visibility_tokens],
    }


def split_samples_by_scene(tables, test_ratio):
    samples_by_scene = defaultdict(list)
    for sample in tables["sample"]:
        samples_by_scene[sample["scene_token"]].append(sample)
    train_tokens, test_tokens = [], []
    for samples in samples_by_scene.values():
        samples.sort(key=lambda item: (item["timestamp"], item["token"]))
        test_count = max(1, math.ceil(len(samples) * test_ratio))
        if len(samples) > 1:
            test_count = min(test_count, len(samples) - 1)
        train_tokens.extend(sample["token"] for sample in samples[:-test_count])
        test_tokens.extend(sample["token"] for sample in samples[-test_count:])
    return train_tokens, test_tokens


def main():
    parser = argparse.ArgumentParser(
        description="Split each source scene into first 90% train and final 10% test."
    )
    parser.add_argument("--dataroot", required=True)
    parser.add_argument("--source-version", default="v1.0-mini")
    parser.add_argument("--test-ratio", type=float, default=0.1)
    args = parser.parse_args()
    if not 0 < args.test_ratio < 1:
        raise ValueError("--test-ratio must be between 0 and 1")

    dataroot = Path(args.dataroot)
    source_dir = dataroot / args.source_version
    train_dir = dataroot / "v1.0-trainval"
    test_dir = dataroot / "v1.0-test"
    backup_dir = dataroot / f"{args.source_version}.unsplit-backup"
    if not source_dir.is_dir():
        raise FileNotFoundError(f"Source metadata directory was not found: {source_dir}")
    if test_dir.exists() or backup_dir.exists():
        raise FileExistsError(
            f"Refusing to overwrite {test_dir if test_dir.exists() else backup_dir}"
        )

    source = read_tables(source_dir)
    train_tokens, test_tokens = split_samples_by_scene(source, args.test_ratio)
    train_tables = subset_tables(source, train_tokens)
    test_tables = subset_tables(source, test_tokens)

    train_temp = dataroot / "v1.0-trainval.tmp"
    test_temp = dataroot / "v1.0-test.tmp"
    if train_temp.exists() or test_temp.exists():
        raise FileExistsError("Remove stale v1.0-*.tmp directories before retrying")
    write_tables(train_temp, train_tables)
    write_tables(test_temp, test_tables)
    source_dir.rename(backup_dir)
    train_temp.rename(train_dir)
    test_temp.rename(test_dir)
    print(
        f"train_samples={len(train_tables['sample'])} "
        f"test_samples={len(test_tables['sample'])} "
        f"backup={backup_dir}"
    )


if __name__ == "__main__":
    main()
