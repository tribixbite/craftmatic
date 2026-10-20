"""Read a device camera's yaw off every frame of a recording, from coloured marker pillars at known places.

usage: python -I scripts/_pillar_yaw.py <video> <pillars.json> <device key> <t0> <t1> <out.csv> [--colours=<calib.json>]

Round 30zy (COAST-06) stood six 3x3 concrete pillars ~30 blocks round 10303's lift-top, outside the model
(`output/device-round-2026-10-19zy/pillars-30.json`: per device a `centre` and per pillar its colour, x, z and the
tp / fill / clear commands; at 100 blocks the Pixel's fog hid them). In each frame the band of rows between 20 % and
80 % of the height is scanned; a column belongs to a pillar when at least `MIN_ROWS_FRAC` of its band pixels are
within `TOL` (RGB distance) of that pillar's colour AS DRAWN (fog and face shading shift it: sample a ride frame and
pass `--colours`). Each pillar's widest run of columns gives its centre x. The Bedrock yaw of the view (0 faces +Z,
+90 faces -X, +yaw turns right) is then
    yaw = bearing(pillar from the eye) - atan((x - cx) / f)
with the eye fixed at `centre`: the ~7 blocks the eye moves over the crest shift a bearing by up to ~13 degrees at
30 blocks, and a camera pitched well off level biases the reading toward the pillar's bearing (a level-camera
projection). So trust it on near-level views; a dark structure can read as the black pillar, a blue one as cyan.
`f` (pixels at width `W`) is fitted from frames that show two pillars. Writes one row per frame: video time, every
pillar seen (colour:x), the yaw from each and their mean. Measured with it: the own view just before 10303's drop
(quirk `camera-keyframe-yaw-mirrored`).
"""
import json
import math
import subprocess
import sys

import numpy as np

W = 960  # frames are scaled to this width for the scan
TOL = 24.0
MIN_ROWS_FRAC = 0.15
# Concrete under daylight, as drawn by Bedrock (sRGB); refined by --colours from a calibration shot.
REF = {
    "black": (21, 23, 28),
    "lime": (98, 172, 26),
    "orange": (226, 101, 2),
    "purple": (101, 33, 158),
    "brown": (97, 61, 33),
    "cyan": (22, 120, 137),
}


def frames(video: str, t0: float, t1: float):
    """(time, HxWx3 uint8) for every frame in [t0, t1), scaled to width W; times from ffmpeg's own showinfo."""
    import os
    import tempfile
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                            "-of", "json", video], capture_output=True, text=True, check=True)
    st = json.loads(probe.stdout)["streams"][0]
    h = round(st["height"] * W / st["width"]) // 2 * 2
    fd, log = tempfile.mkstemp(suffix=".log")
    os.close(fd)
    cmd = ["ffmpeg", "-v", "info", "-ss", f"{t0:.3f}", "-i", video, "-t", f"{t1 - t0:.3f}", "-vf", f"scale={W}:{h},showinfo",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-fps_mode", "passthrough", "-"]
    with open(log, "w") as err:
        raw = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=err).stdout
    ts = []
    for line in open(log, encoding="utf-8", errors="replace"):
        if "Parsed_showinfo" in line and "pts_time:" in line:
            ts.append(t0 + float(line.split("pts_time:")[1].split()[0]))
    os.remove(log)
    size = W * h * 3
    n = len(raw) // size
    for i in range(n):
        yield (ts[i] if i < len(ts) else t0 + i / 30), np.frombuffer(raw, np.uint8, size, i * size).reshape(h, W, 3)


def scan(img: np.ndarray, ref: dict) -> dict:
    """Pillar colour -> centre x (pixels in the scaled frame) of its widest column run."""
    h = img.shape[0]
    band = img[int(h * 0.2):int(h * 0.8)].astype(np.float32)
    out = {}
    for name, rgb in ref.items():
        d = np.sqrt(((band - np.array(rgb, np.float32)) ** 2).sum(axis=2))
        hits = (d < TOL).sum(axis=0)
        cols = hits >= MIN_ROWS_FRAC * band.shape[0]
        best, run, start, best_start = 0, 0, 0, 0
        for x, c in enumerate(cols):
            if c:
                if run == 0:
                    start = x
                run += 1
                if run > best:
                    best, best_start = run, start
            else:
                run = 0
        if best >= 2:
            out[name] = best_start + (best - 1) / 2
    return out


def bearing(eye, p) -> float:
    """Bedrock yaw that faces pillar p from eye (0 = +Z, +90 = -X)."""
    return math.degrees(math.atan2(-(p[0] - eye[0]), p[1] - eye[1]))


def wrap(a: float) -> float:
    return (a + 180) % 360 - 180


def main() -> None:
    video, pj, key, t0, t1, out = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]), sys.argv[6]
    ref = dict(REF)
    for a in sys.argv[7:]:
        if a.startswith("--colours="):
            ref.update({k: tuple(v) for k, v in json.load(open(a.split("=", 1)[1])).items()})
    cfg = json.load(open(pj))[key]
    eye = (cfg["centre"][0] + 0.5, cfg["centre"][1] + 0.5)
    pil = {p["colour"]: (p["x"] + 0.5, p["z"] + 0.5) for p in cfg["pillars"]}
    rows = [(t, scan(img, ref)) for t, img in frames(video, t0, t1)]
    cx = W / 2
    # Focal length: every frame with two pillars gives one estimate (their bearing difference against their x).
    fs = []
    for _, seen in rows:
        names = sorted(seen)
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                a, b = names[i], names[j]
                db = math.radians(wrap(bearing(eye, pil[b]) - bearing(eye, pil[a])))
                xa, xb = seen[a] - cx, seen[b] - cx
                # Solve atan(xb/f) - atan(xa/f) = db for f by bisection (monotone in f for xa != xb).
                if abs(db) < math.radians(5) or abs(xb - xa) < 20:
                    continue
                lo, hi = 50.0, 5000.0
                g = lambda f: (math.atan(xb / f) - math.atan(xa / f)) - db
                if g(lo) * g(hi) > 0:
                    continue
                for _ in range(60):
                    mid = (lo + hi) / 2
                    if g(lo) * g(mid) <= 0:
                        hi = mid
                    else:
                        lo = mid
                fs.append((lo + hi) / 2)
    f = float(np.median(fs)) if fs else W / 2 / math.tan(math.radians(51))
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(f"# focal {f:.1f} px at width {W} from {len(fs)} pair(s); eye {eye}\n")
        fh.write("t,seen,yaw_each,yaw\n")
        for t, seen in rows:
            ys = {k: wrap(bearing(eye, pil[k]) - math.degrees(math.atan((x - cx) / f))) for k, x in seen.items()}
            mean = ""
            if ys:
                base = next(iter(ys.values()))
                mean = f"{wrap(base + sum(wrap(v - base) for v in ys.values()) / len(ys)):.1f}"
            fh.write(f"{t:.3f},{' '.join(f'{k}:{x:.0f}' for k, x in seen.items())},{' '.join(f'{k}:{v:.1f}' for k, v in ys.items())},{mean}\n")
    print(out, len(rows), "frames, focal", round(f, 1), "from", len(fs), "pairs")


if __name__ == "__main__":
    main()
