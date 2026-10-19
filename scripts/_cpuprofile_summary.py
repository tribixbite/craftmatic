"""Summarise a Bedrock `/script profiler` .cpuprofile (V8 format, written by the game's script host).

The device's profile holds samples only while scripts RUN: the gap between two script ticks is one long time delta
(~25-45 ms), not idle samples. So a run of samples between such gaps is one tick's script work (a BURST), and the
burst lengths say how much of each 50 ms tick the packs take and whether a tick overruns (the ride slows and the
client's view of it stutters; the pinball's "client server lag", PIN-02).

Prints the wall span, bursts per second (≈ the tick rate), busy ms per burst (median / p90 / p99 / max, count over
50 ms), self time per function (file:line) and INCLUSIVE time per function (counted once per sample however deep it
recurses), as a share of the busy time.

Usage: python -I scripts/_cpuprofile_summary.py <profile.cpuprofile> [--top=25] [--file=coaster.js] [--gap-ms=5]
"""
from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("profile")
    ap.add_argument("--top", type=int, default=25)
    ap.add_argument("--file", default="", help="only list functions whose url contains this")
    ap.add_argument("--gap-ms", type=float, default=5.0, help="a time delta longer than this ends a burst")
    a = ap.parse_args()
    with open(a.profile, encoding="utf-8") as fh:
        prof = json.load(fh)
    nodes = {n["id"]: n for n in prof["nodes"]}
    parent: dict[int, int] = {}
    for n in prof["nodes"]:
        for c in n.get("children", []):
            parent[c] = n["id"]

    def label(nid: int) -> str:
        cf = nodes[nid]["callFrame"]
        url = (cf.get("url") or "").rsplit("/", 1)[-1]
        name = cf.get("functionName") or "(anon)"
        return f"{name} {url}:{cf.get('lineNumber', -1) + 1}" if url else name

    samples = prof["samples"]
    deltas = prof.get("timeDeltas") or [0] * len(samples)
    span_s = (prof["endTime"] - prof["startTime"]) / 1e6 if "endTime" in prof else sum(deltas) / 1e6
    gap_us = a.gap_ms * 1000
    self_t: Counter[str] = Counter()
    incl_t: Counter[str] = Counter()
    bursts: list[float] = []
    run = 0.0
    for sid, dt in zip(samples, deltas):
        # A long delta is the wait between ticks: it closes the burst and is not charged to this sample.
        if dt > gap_us:
            if run > 0:
                bursts.append(run)
            run = 0.0
            dt = 0
        run += dt
        if dt <= 0:
            continue
        self_t[label(sid)] += dt
        seen: set[str] = set()
        nid: int | None = sid
        while nid is not None:
            lab = label(nid)
            if lab not in seen:
                incl_t[lab] += dt
                seen.add(lab)
            nid = parent.get(nid)
    if run > 0:
        bursts.append(run)
    busy_us = sum(bursts) or 1.0
    ms = sorted(b / 1e3 for b in bursts)

    def q(p: float) -> float:
        return ms[min(len(ms) - 1, int(p * len(ms)))] if ms else float("nan")

    print(f"{a.profile}: {len(samples)} samples over {span_s:.1f} s")
    print(f"bursts {len(ms)} ({len(ms) / max(span_s, 1e-9):.1f}/s); busy per burst median {statistics.median(ms) if ms else float('nan'):.1f} ms, "
          f"p90 {q(0.9):.1f}, p99 {q(0.99):.1f}, max {ms[-1] if ms else float('nan'):.1f}; over 50 ms: {sum(1 for m in ms if m > 50)}; "
          f"busy {busy_us / 1e6:.1f} s ({100 * busy_us / 1e6 / max(span_s, 1e-9):.0f} % of the span)")
    print(f"\nSELF (top {a.top}, % of busy):")
    shown = 0
    for name, us in self_t.most_common():
        if a.file and a.file not in name:
            continue
        print(f"  {100 * us / busy_us:6.2f} %  {us / 1e6:7.2f} s  {name}")
        shown += 1
        if shown >= a.top:
            break
    print("\nINCLUSIVE (top 40, % of busy):")
    shown = 0
    for name, us in incl_t.most_common():
        if a.file and a.file not in name:
            continue
        print(f"  {100 * us / busy_us:6.2f} %  {us / 1e6:7.2f} s  {name}")
        shown += 1
        if shown >= 40:
            break


if __name__ == "__main__":
    main()
