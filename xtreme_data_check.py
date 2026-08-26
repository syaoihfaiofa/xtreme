"""Sanity-check Xtreme annotations before they are trained on.

A label that is geometrically impossible still trains perfectly well, and the
model then reproduces it faithfully at inference -- a mislabelled track of 32
frames in ``2026-07-08-16-11-50`` (a ceiling fixture annotated as a ``car``
floating 2 m up) became a recurring floating false positive that took a long
detour to trace back to the data. Every check here exists to make that class of
defect visible in one pass instead of being discovered through inference.

The checks are heuristics, not ground truth: they are tuned so that a clean
dataset reports almost nothing, and anything reported is worth a human look.
Findings are therefore warnings, never a hard failure -- ``--floor-hi`` in
particular must stay a warning, because stacked mechanical parking legitimately
puts a car 2 m off the ground.

Checks
------
Per box   size against a per-class prior, degenerate dimensions, ``w > l`` for
          classes with a long axis, box floor (``z - h/2``) outside the ground
          band, distance from ego, unknown or non-lowercase class name.
Per frame two boxes overlapping in BEV *and* in height, one ``trackId`` twice
          in a frame, frames with no boxes at all.
Per track class flips, size jumps, implied speed, yaw jumps (a 180 deg flip is
          reported separately, since it is harmless for a symmetric box).
Schema    file shape, required fields, finite numbers.

Each finding carries the scene and token, so it can be handed straight to
``xtreme_gt_bev.py`` to be looked at; the tool prints such a command for the
worst offenders.

Examples::

    # whole dataset, default thresholds
    docker exec weizhe_j6 bash -lc '
      cd /PnP/weizhe/Horizon/v3_8/scripts &&
      python3 tools/xtreme_data_check.py --root /PnP/ParkingDataSet/BUCKET/BEV/v0
    '

    # one scene, every finding to a CSV
    python3 tools/xtreme_data_check.py --scenes 2026-07-08-16-11-50 \
        --csv WORKSPACE/check.csv

    # per-class size percentiles, to re-tune the priors above
    python3 tools/xtreme_data_check.py --stats
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import os
from collections import Counter, defaultdict
from multiprocessing import Pool

DEFAULT_ROOT = "/PnP/ParkingDataSet/BUCKET/BEV/v0"

# Per-class size prior: (l_min, l_max, w_min, w_max, h_min, h_max) in metres.
# Derived from the p0.1/p99.9 of v0 (110k boxes) then widened to a physically
# plausible range, so a real but unusual object does not fire and a class mix-up
# does. `bus` is deliberately a real bus: the 30 boxes labelled `bus` in v0 are
# all 3.81 x 1.80 x 1.34, which is a car, and should be reported.
SIZE_PRIOR = {
    "car": (2.5, 6.8, 1.2, 2.9, 1.05, 2.6),
    "bus": (5.0, 14.0, 2.0, 3.2, 2.4, 4.2),
    "pillar": (0.05, 2.0, 0.05, 2.0, 1.2, 3.8),
    "pole": (0.02, 1.0, 0.02, 1.2, 0.3, 3.8),
    "cone": (0.10, 0.9, 0.10, 0.9, 0.3, 1.2),
    "person": (0.15, 1.5, 0.20, 1.3, 1.0, 2.15),
    "barrier": (0.15, 1.2, 0.50, 2.0, 0.5, 3.0),
    "no parking board": (0.15, 1.0, 0.20, 1.0, 0.4, 2.4),
    "parking lock (locked)": (0.15, 0.5, 0.30, 0.8, 0.2, 0.7),
}

# Classes whose annotation convention puts the long side along x. For anything
# else (a pillar, a barrier) either orientation is legitimate.
LONG_AXIS = ("car", "bus")

# Classes thin or tall enough that a BEV overlap with a car is usually just the
# label sitting under an overhang rather than a contradiction.
OVERLAP_SKIP_PAIRS = frozenset(
    [
        ("cone", "cone"),
        ("pole", "pole"),
        ("pole", "pillar"),
        ("cone", "pillar"),
        ("no parking board", "pillar"),
        ("parking lock (locked)", "car"),
        ("parking lock (locked)", "parking lock (locked)"),
    ]
)


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", default=DEFAULT_ROOT)
    p.add_argument(
        "--scenes",
        nargs="*",
        default=None,
        help="default: every scene under <root>/anno",
    )
    p.add_argument(
        "--stats",
        action="store_true",
        help="print per-class size percentiles instead of checking",
    )
    p.add_argument("--csv", default=None, help="write every finding here")
    p.add_argument(
        "--top", type=int, default=6, help="examples printed per check"
    )
    p.add_argument("--workers", type=int, default=4)
    p.add_argument(
        "--checks",
        default="all",
        help="comma separated subset of check names, or 'all'",
    )
    p.add_argument(
        "--floor-lo",
        type=float,
        default=-0.9,
        help="lowest plausible box floor (z - h/2)",
    )
    p.add_argument(
        "--floor-hi",
        type=float,
        default=0.6,
        help="box floor above this is suspicious but can be legitimate "
        "(stacked mechanical parking)",
    )
    p.add_argument("--max-range", type=float, default=25.0, help="metres from ego")
    p.add_argument(
        "--iou-th", type=float, default=0.30, help="BEV IoU that counts as overlap"
    )
    p.add_argument(
        "--size-jump",
        type=float,
        default=0.35,
        help="relative size change within a track, per frame pair",
    )
    p.add_argument(
        "--size-jump-abs",
        type=float,
        default=0.30,
        help="a size jump must also exceed this many metres; keeps the jitter "
        "of a small dimension (a person's width) from firing",
    )
    p.add_argument("--max-speed", type=float, default=12.0, help="m/s within a track")
    p.add_argument(
        "--max-yaw-rate", type=float, default=200.0, help="deg/s within a track"
    )
    p.add_argument(
        "--max-track-dt",
        type=float,
        default=1.5,
        help="ignore consecutive track frames further apart than this; a track "
        "that vanishes and returns is not a jump",
    )
    p.add_argument(
        "--min-dim",
        type=float,
        default=0.02,
        help="degenerate below this, metres; a real pole is ~4 cm wide",
    )
    return p.parse_args()


def token_ns(token):
    """Nanosecond timestamp encoded in the trailing two token fields."""
    parts = token.split("_")
    try:
        return int(parts[-2]) * 10 ** 9 + int(parts[-1])
    except (ValueError, IndexError):
        return -1


def scenes_under(root):
    anno = os.path.join(root, "anno")
    if not os.path.isdir(anno):
        raise SystemExit("no anno directory under %s" % root)
    return sorted(
        s
        for s in os.listdir(anno)
        if os.path.isdir(os.path.join(anno, s, "result"))
    )


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #
def box_corners(x, y, length, width, yaw):
    cs, sn = math.cos(yaw), math.sin(yaw)
    out = []
    for dx, dy in ((0.5, 0.5), (0.5, -0.5), (-0.5, -0.5), (-0.5, 0.5)):
        ox, oy = dx * length, dy * width
        out.append((x + ox * cs - oy * sn, y + ox * sn + oy * cs))
    return out


def clip_convex(poly, a, b):
    """Sutherland-Hodgman: keep the part of `poly` inside the edge a->b.

    ``box_corners`` emits corners clockwise, for which the interior of an edge
    is the side where the cross product is positive.
    """
    ax, ay = a
    ex, ey = b[0] - ax, b[1] - ay
    out = []
    n = len(poly)
    for i in range(n):
        cx, cy = poly[i]
        nx, ny = poly[(i + 1) % n]
        c_in = (cx - ax) * ey - (cy - ay) * ex >= 0
        n_in = (nx - ax) * ey - (ny - ay) * ex >= 0
        if c_in:
            out.append((cx, cy))
        if c_in != n_in:
            dx, dy = nx - cx, ny - cy
            den = dx * ey - dy * ex
            if abs(den) > 1e-12:
                t = ((ax - cx) * ey - (ay - cy) * ex) / den
                out.append((cx + t * dx, cy + t * dy))
    return out


def poly_area(poly):
    s = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        s += x0 * y1 - x1 * y0
    return abs(s) * 0.5


def bev_iou(a, b):
    """Rotated-rectangle IoU in BEV. Corners are clockwise, so clipping works."""
    pa = box_corners(a["x"], a["y"], a["l"], a["w"], a["yaw"])
    pb = box_corners(b["x"], b["y"], b["l"], b["w"], b["yaw"])
    poly = pa
    for i in range(len(pb)):
        poly = clip_convex(poly, pb[i], pb[(i + 1) % len(pb)])
        if not poly:
            return 0.0
    inter = poly_area(poly)
    union = a["l"] * a["w"] + b["l"] * b["w"] - inter
    return inter / union if union > 1e-9 else 0.0


def z_overlap(a, b):
    """Vertical overlap in metres; negative when one box is above the other."""
    lo = max(a["z"] - a["h"] / 2, b["z"] - b["h"] / 2)
    hi = min(a["z"] + a["h"] / 2, b["z"] + b["h"] / 2)
    return hi - lo


# --------------------------------------------------------------------------- #
# loading
# --------------------------------------------------------------------------- #
def load_frame(path):
    """Boxes of one annotation file, plus any schema complaints."""
    token = os.path.basename(path)[:-5]
    bad = []
    try:
        doc = json.load(open(path))
    except (ValueError, OSError) as exc:
        return token, [], [("schema", "unreadable: %s" % exc, None, None)]
    if not isinstance(doc, list) or not doc or "objects" not in doc[0]:
        return token, [], [("schema", "expected [{'objects': [...]}]", None, None)]

    boxes = []
    for i, o in enumerate(doc[0]["objects"]):
        if o.get("type") != "3D_BOX":
            continue
        name = o.get("className")
        tid = o.get("trackId")
        c = o.get("contour") or {}
        ct, sz = c.get("center3D"), c.get("size3D")
        if not name or not isinstance(ct, dict) or not isinstance(sz, dict):
            bad.append(("schema", "object %d missing className/contour" % i, tid, name))
            continue
        try:
            vals = [
                float(ct["x"]),
                float(ct["y"]),
                float(ct["z"]),
                float(sz["x"]),
                float(sz["y"]),
                float(sz["z"]),
            ]
        except (KeyError, TypeError, ValueError):
            bad.append(("schema", "object %d bad center3D/size3D" % i, tid, name))
            continue
        if not all(math.isfinite(v) for v in vals):
            bad.append(("schema", "object %d non-finite geometry" % i, tid, name))
            continue
        yaw = (c.get("rotation3D") or {}).get("z", 0.0) or 0.0
        if not math.isfinite(float(yaw)):
            bad.append(("schema", "object %d non-finite yaw" % i, tid, name))
            continue
        x, y, z, length, width, height = vals
        boxes.append(
            dict(
                cls=name.lower(),
                raw_cls=name,
                tid=tid,
                x=x,
                y=y,
                z=z,
                l=length,
                w=width,
                h=height,
                yaw=float(yaw),
                floor=z - height / 2.0,
            )
        )
        if not tid:
            bad.append(("schema", "object %d has no trackId" % i, tid, name))
    return token, boxes, bad


# --------------------------------------------------------------------------- #
# checks
# --------------------------------------------------------------------------- #
def check_box(b, cfg):
    """Findings for a single box: (check, detail) pairs."""
    out = []
    cls = b["cls"]
    if b["raw_cls"] != cls:
        out.append(("class_case", "className %r is not lowercase" % b["raw_cls"]))
    if cls not in SIZE_PRIOR:
        out.append(("class_unknown", "no size prior for class %r" % cls))

    dims = (b["l"], b["w"], b["h"])
    if min(dims) < cfg["min_dim"]:
        out.append(
            ("degenerate", "size %.3f x %.3f x %.3f" % dims)
        )
    elif cls in SIZE_PRIOR:
        lo_l, hi_l, lo_w, hi_w, lo_h, hi_h = SIZE_PRIOR[cls]
        for name, v, lo, hi in (
            ("l", b["l"], lo_l, hi_l),
            ("w", b["w"], lo_w, hi_w),
            ("h", b["h"], lo_h, hi_h),
        ):
            if v < lo or v > hi:
                out.append(
                    (
                        "size_prior",
                        "%s %s=%.2f outside [%.2f, %.2f] (box %.2f x %.2f x %.2f)"
                        % (cls, name, v, lo, hi, b["l"], b["w"], b["h"]),
                    )
                )

    if cls in LONG_AXIS and b["w"] > b["l"]:
        out.append(
            (
                "aspect",
                "%s wider than long (%.2f x %.2f), yaw likely off 90 deg"
                % (cls, b["l"], b["w"]),
            )
        )

    if b["floor"] < cfg["floor_lo"]:
        out.append(("floor_low", "%s floor %.2f m, below ground" % (cls, b["floor"])))
    elif b["floor"] > cfg["floor_hi"]:
        out.append(
            (
                "floor_high",
                "%s floor %.2f m (h=%.2f), floating unless stacked parking"
                % (cls, b["floor"], b["h"]),
            )
        )

    r = math.hypot(b["x"], b["y"])
    if r > cfg["max_range"]:
        out.append(("range", "%s at %.1f m from ego" % (cls, r)))
    return out


def check_frame(boxes, cfg):
    """Findings that need every box in the frame at once."""
    out = []
    if not boxes:
        return [("frame_empty", "no 3D_BOX in this frame", None, None)]

    seen = Counter(b["tid"] for b in boxes if b["tid"])
    for tid, n in seen.items():
        if n > 1:
            out.append(("dup_track", "trackId appears %d times in a frame" % n, tid, None))

    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i], boxes[j]
            pair = tuple(sorted((a["cls"], b["cls"])))
            if pair in OVERLAP_SKIP_PAIRS:
                continue
            # Cheap reject before the polygon clip.
            if math.hypot(a["x"] - b["x"], a["y"] - b["y"]) > (
                a["l"] + a["w"] + b["l"] + b["w"]
            ) / 2.0:
                continue
            if z_overlap(a, b) <= 0.0:
                continue
            iou = bev_iou(a, b)
            if iou >= cfg["iou_th"]:
                out.append(
                    (
                        "overlap",
                        "%s(%s) and %s(%s) overlap, BEV IoU %.2f, z-overlap %.2f m"
                        % (a["cls"], a["tid"], b["cls"], b["tid"], iou, z_overlap(a, b)),
                        a["tid"],
                        a["cls"],
                    )
                )
    return out


def check_track(seq, cfg):
    """`seq` is [(t_seconds, box)] sorted by time, one trackId, one scene."""
    out = []
    names = {b["cls"] for _, b in seq}
    if len(names) > 1:
        out.append(
            (
                "track_class_flip",
                "trackId changes class across the scene: %s" % sorted(names),
                seq[0][0],
            )
        )
    for (t0, b0), (t1, b1) in zip(seq, seq[1:]):
        dt = t1 - t0
        if dt <= 1e-6 or dt > cfg["max_track_dt"]:
            continue
        for name, v0, v1 in (("l", b0["l"], b1["l"]), ("w", b0["w"], b1["w"]), ("h", b0["h"], b1["h"])):
            ref = max(v0, v1, 1e-3)
            delta = abs(v1 - v0)
            if delta / ref > cfg["size_jump"] and delta > cfg["size_jump_abs"]:
                out.append(
                    (
                        "track_size_jump",
                        "%s %s %.2f -> %.2f in %.2f s" % (b1["cls"], name, v0, v1, dt),
                        t1,
                    )
                )
        speed = math.hypot(b1["x"] - b0["x"], b1["y"] - b0["y"]) / dt
        if speed > cfg["max_speed"]:
            out.append(
                ("track_speed", "%s moves %.1f m/s" % (b1["cls"], speed), t1)
            )
        dyaw = math.degrees(abs((b1["yaw"] - b0["yaw"] + math.pi) % (2 * math.pi) - math.pi))
        # A symmetric box flipped end for end is the same box; report it apart
        # from a genuine rotation so the two are not confused.
        if abs(dyaw - 180.0) < 20.0:
            out.append(
                ("track_yaw_flip", "%s yaw flips %.0f deg in %.2f s" % (b1["cls"], dyaw, dt), t1)
            )
        elif dyaw / dt > cfg["max_yaw_rate"]:
            out.append(
                (
                    "track_yaw_jump",
                    "%s yaw %.0f deg in %.2f s (%.0f deg/s)"
                    % (b1["cls"], dyaw, dt, dyaw / dt),
                    t1,
                )
            )
    return out


def check_scene(job):
    """One scene: every check. Returns (scene, findings, class counter, n_frames)."""
    scene, result_dir, cfg = job
    findings = []
    cls_count = Counter()
    tracks = defaultdict(list)
    paths = sorted(glob.glob(os.path.join(result_dir, "*.json")))

    for path in paths:
        token, boxes, bad = load_frame(path)
        t = token_ns(token) / 1e9
        for check, detail, tid, cls in bad:
            findings.append((check, scene, token, tid, cls or "", detail))
        for b in boxes:
            cls_count[b["cls"]] += 1
            for check, detail in check_box(b, cfg):
                findings.append((check, scene, token, b["tid"], b["cls"], detail))
            if b["tid"]:
                tracks[b["tid"]].append((t, b))
        for check, detail, tid, cls in check_frame(boxes, cfg):
            findings.append((check, scene, token, tid, cls or "", detail))

    # Tracks need a token to point the user at, so keep a time -> token map.
    tok_at = {token_ns(os.path.basename(p)[:-5]) / 1e9: os.path.basename(p)[:-5] for p in paths}
    for tid, seq in tracks.items():
        seq.sort(key=lambda item: item[0])
        for check, detail, t in check_track(seq, cfg):
            findings.append(
                (check, scene, tok_at.get(t, ""), tid, seq[0][1]["cls"], detail)
            )
    return scene, findings, cls_count, len(paths)


# --------------------------------------------------------------------------- #
# reporting
# --------------------------------------------------------------------------- #
def print_stats(root, scenes):
    import numpy as np

    per_cls = defaultdict(list)
    for scene in scenes:
        pattern = os.path.join(root, "anno", scene, "result", "*.json")
        for path in glob.glob(pattern):
            _, boxes, _ = load_frame(path)
            for b in boxes:
                per_cls[b["cls"]].append((b["l"], b["w"], b["h"], b["floor"]))
    print(
        "%-24s %8s  %-20s %-20s %-20s %-16s"
        % ("class", "n", "l p0.1/50/99.9", "w p0.1/50/99.9", "h p0.1/50/99.9", "floor p50/99.9")
    )
    for cls in sorted(per_cls, key=lambda c: -len(per_cls[c])):
        a = np.array(per_cls[cls])
        q = lambda i, p: np.percentile(a[:, i], p)  # noqa: E731
        print(
            "%-24s %8d  %5.2f %5.2f %5.2f    %5.2f %5.2f %5.2f    "
            "%5.2f %5.2f %5.2f    %6.2f %6.2f"
            % (
                cls,
                len(a),
                q(0, 0.1),
                q(0, 50),
                q(0, 99.9),
                q(1, 0.1),
                q(1, 50),
                q(1, 99.9),
                q(2, 0.1),
                q(2, 50),
                q(2, 99.9),
                q(3, 50),
                q(3, 99.9),
            )
        )


def report(findings, root, cls_count, n_frames, n_scenes, top):
    n_box = sum(cls_count.values())
    print(
        "\nchecked %d scenes, %d frames, %d boxes  (%s)"
        % (n_scenes, n_frames, n_box, root)
    )
    print("classes: %s" % ", ".join("%s=%d" % kv for kv in cls_count.most_common()))

    if not findings:
        print("\nno findings")
        return
    by_check = defaultdict(list)
    for f in findings:
        by_check[f[0]].append(f)

    print("\n%-20s %8s  %s" % ("check", "count", "affected classes"))
    for check in sorted(by_check, key=lambda c: -len(by_check[c])):
        rows = by_check[check]
        classes = Counter(r[4] for r in rows if r[4])
        print(
            "%-20s %8d  %s"
            % (check, len(rows), ", ".join("%s=%d" % kv for kv in classes.most_common(5)))
        )

    for check in sorted(by_check, key=lambda c: -len(by_check[c])) if top > 0 else []:
        rows = by_check[check]
        print("\n--- %s (%d) ---" % (check, len(rows)))
        # One example per track keeps a 3000-frame defect from filling the page.
        seen = set()
        examples = []
        for _, scene, token, tid, _cls, detail in rows:
            key = (scene, tid)
            if key in seen:
                continue
            seen.add(key)
            if len(examples) < top:
                examples.append((scene, token, tid, detail))
        for scene, token, tid, detail in examples:
            print("  %s  %s  track=%s\n    %s" % (scene, token, tid, detail))
        if len(seen) > len(examples):
            print("  ... %d more distinct tracks" % (len(seen) - len(examples)))
        if not examples:
            continue
        scene, token, tid, _ = examples[0]
        if token:
            print(
                "  look: python3 tools/xtreme_gt_bev.py --root %s --scene %s "
                "--tokens %s --track %s --out WORKSPACE/check"
                % (root, scene, token, tid)
            )


def main():
    args = parse_args()
    scenes = args.scenes or scenes_under(args.root)
    if args.stats:
        print_stats(args.root, scenes)
        return

    cfg = dict(
        floor_lo=args.floor_lo,
        floor_hi=args.floor_hi,
        max_range=args.max_range,
        iou_th=args.iou_th,
        size_jump=args.size_jump,
        size_jump_abs=args.size_jump_abs,
        max_speed=args.max_speed,
        max_yaw_rate=args.max_yaw_rate,
        max_track_dt=args.max_track_dt,
        min_dim=args.min_dim,
    )
    jobs = [
        (s, os.path.join(args.root, "anno", s, "result"), cfg) for s in scenes
    ]
    print("checking %d scenes with %d workers ..." % (len(jobs), args.workers))
    if args.workers > 1 and len(jobs) > 1:
        with Pool(min(args.workers, len(jobs))) as pool:
            results = pool.map(check_scene, jobs)
    else:
        results = [check_scene(j) for j in jobs]

    wanted = None
    if args.checks.lower() != "all":
        wanted = {c.strip() for c in args.checks.split(",") if c.strip()}

    findings = []
    cls_count = Counter()
    n_frames = 0
    for scene, scene_findings, counts, n in results:
        print("  %-22s frames=%-6d findings=%d" % (scene, n, len(scene_findings)))
        findings.extend(
            f for f in scene_findings if wanted is None or f[0] in wanted
        )
        cls_count.update(counts)
        n_frames += n

    report(findings, args.root, cls_count, n_frames, len(scenes), args.top)

    if args.csv:
        os.makedirs(os.path.dirname(os.path.abspath(args.csv)), exist_ok=True)
        with open(args.csv, "w", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(["check", "scene", "token", "track_id", "class", "detail"])
            writer.writerows(sorted(findings))
        print("\nwrote %d findings -> %s" % (len(findings), args.csv))


if __name__ == "__main__":
    main()
