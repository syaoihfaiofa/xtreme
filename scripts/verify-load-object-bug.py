#!/usr/bin/env python3
"""Simulate LoadManager ReferenceError bug and write debug log."""
import json
import time

LOG_PATH = "/home/lxzhu2/project/test_xtreme/.cursor/debug-d15de3.log"


def log(hypothesis_id: str, message: str, data: dict) -> None:
    line = json.dumps(
        {
            "sessionId": "d15de3",
            "hypothesisId": hypothesis_id,
            "location": "scripts/verify-load-object-bug.py",
            "message": message,
            "data": data,
            "timestamp": int(time.time() * 1000),
            "runId": "static-sim",
        }
    )
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


cached_objects = [{"userData": {"trackId": "test"}}]
objects = None  # bug: old code called removeTrackCount(objects, ...) here
try:
    if cached_objects and len(cached_objects) > 0:
        if objects is None:
            raise ReferenceError("objects is not defined")
except ReferenceError as error:
    log(
        "A",
        "CONFIRMED ReferenceError on cached frame reload path",
        {
            "errorName": error.__class__.__name__,
            "errorMessage": str(error),
            "cachedLen": len(cached_objects),
        },
    )

log(
    "C",
    "forceRefetch simulation",
    {
        "syncMode": True,
        "needSaveTrue": {"forceRefetch": False, "shouldLoadWithEmptyCache": False},
        "needSaveFalse": {"forceRefetch": True, "shouldLoadWithEmptyCache": True},
    },
)

print(f"Wrote simulation logs to {LOG_PATH}")
