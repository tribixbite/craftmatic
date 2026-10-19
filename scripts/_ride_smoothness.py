"""How evenly a ride's picture moves, from a screen recording (COAST-06: "stutter-jerks", round 30zq).

The view of a ride moves by a similar amount every frame when it is smooth. A camera that jerks against what it
shows moves in uneven steps: a frame that hardly moves followed by one that catches up (a STALL), or steps that
swing frame to frame (JERK). This measures the frame-to-frame image shift by phase correlation on downscaled grey
frames, normalised by the time between the frames (a phone's screen recording has a variable frame rate), and
reports per window:

  - frames, mean frame interval, and the frames that repeat the one before (no change at all);
  - the shift speed median (px per 1/60 s at the analysis width);
  - JERK: |speed[i] - speed[i-1]| / median speed, as p50 / p90 / p99;
  - STALLS: frames moving under a quarter of the median of their 4 neighbours while those neighbours move, per second.

Phase correlation sees translation; a view that rolls (a loop) is not measured by it - read those windows by eye.
A window is `start-end` in seconds of the recording. Compare two recordings of the same stretch, never absolutes.

Usage: python -I scripts/_ride_smoothness.py <video.mp4> [--window=12.0-20.0 ...] [--width=320] [--csv=out.csv]
"""
from __future__ import annotations

import argparse
import csv
import statistics
import sys

import cv2
import numpy as np


def frames(path: str, width: int):
    """Yield (time ms, grey float32 frame at `width`) for every decoded frame."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"cannot open {path}")
    while True:
        ok, img = cap.read()
        if not ok:
            break
        t = cap.get(cv2.CAP_PROP_POS_MSEC)
        h, w = img.shape[:2]
        small = cv2.resize(img, (width, max(1, round(h * width / w))), interpolation=cv2.INTER_AREA)
        grey = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
        yield t, grey
    cap.release()


def measure(path: str, width: int):
    """Per frame after the first: time (s), interval (ms), shift (px), speed (px per 1/60 s), repeat flag."""
    rows = []
    prev = None
    window = None
    for t, grey in frames(path, width):
        if window is None:
            window = cv2.createHanningWindow(grey.shape[::-1], cv2.CV_32F)
        if prev is not None:
            dt = t - prev[0]
            if dt <= 0:
                prev = (t, grey)
                continue
            same = float(np.mean(np.abs(grey - prev[1]))) < 0.05
            (dx, dy), _response = cv2.phaseCorrelate(prev[1], grey, window)
            shift = float(np.hypot(dx, dy))
            rows.append({"t": t / 1000.0, "dt": dt, "shift": shift, "speed": shift * (1000.0 / 60.0) / dt, "repeat": same})
        prev = (t, grey)
    return rows


def pct(xs, q):
    if not xs:
        return float("nan")
    s = sorted(xs)
    return s[min(len(s) - 1, int(q * len(s)))]


def summarise(rows, label: str) -> str:
    if len(rows) < 8:
        return f"{label}: {len(rows)} frames - too few"
    speeds = [r["speed"] for r in rows]
    med = statistics.median(speeds) or 1e-9
    jerk = [abs(speeds[i] - speeds[i - 1]) / med for i in range(1, len(speeds))]
    stalls = 0
    for i in range(2, len(speeds) - 2):
        around = [speeds[i - 2], speeds[i - 1], speeds[i + 1], speeds[i + 2]]
        m = statistics.median(around)
        if m > 0.5 and speeds[i] < 0.25 * m:
            stalls += 1
    span = rows[-1]["t"] - rows[0]["t"] or 1e-9
    repeats = sum(1 for r in rows if r["repeat"])
    dts = [r["dt"] for r in rows]
    return (f"{label}: {len(rows)} frames over {span:.1f} s, interval mean {statistics.mean(dts):.1f} ms "
            f"(p90 {pct(dts, 0.9):.1f}), repeats {repeats}; speed median {med:.2f} px/frame60; "
            f"jerk p50 {pct(jerk, 0.5):.2f} p90 {pct(jerk, 0.9):.2f} p99 {pct(jerk, 0.99):.2f}; "
            f"stalls {stalls} ({stalls / span:.2f}/s)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("video")
    ap.add_argument("--window", action="append", default=[], help="start-end seconds; repeatable")
    ap.add_argument("--width", type=int, default=320)
    ap.add_argument("--csv")
    a = ap.parse_args()
    rows = measure(a.video, a.width)
    if a.csv:
        with open(a.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=["t", "dt", "shift", "speed", "repeat"])
            w.writeheader()
            w.writerows(rows)
    print(summarise(rows, f"{a.video} (whole)"))
    for spec in a.window:
        s, e = (float(v) for v in spec.split("-"))
        print(summarise([r for r in rows if s <= r["t"] <= e], f"  window {s:g}-{e:g} s"))


if __name__ == "__main__":
    main()
