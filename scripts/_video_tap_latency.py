"""Tap-to-picture latency from a screen recording with Android's "pointer location" on.

Pointer location draws a status strip at the top of the screen whose text
changes the moment a finger goes down. Each touch-down is a frame where the
TAP region (that strip) changes after at least `--quiet` seconds without a
change; the latency is the time from it to the first later frame where any
RESPONSE region (a flipper) changes, within half a second. Times are the
video's own presentation timestamps (variable frame rate is handled).

Usage: python scripts/_video_tap_latency.py <video.mp4> --tap=W:H:X:Y --resp=W:H:X:Y [--resp=...] [--thresh=25] [--min-pixels=15] [--quiet=0.4]
Use even widths and heights. Needs ffmpeg/ffprobe on PATH.
"""
import argparse, subprocess
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('video')
ap.add_argument('--tap', required=True)
ap.add_argument('--resp', action='append', required=True)
ap.add_argument('--thresh', type=int, default=25)
ap.add_argument('--min-pixels', type=int, default=15)
ap.add_argument('--quiet', type=float, default=0.4)
a = ap.parse_args()

def frames(crop: str):
    w, h, x, y = (int(v) for v in crop.split(':'))
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', a.video, '-vf', f'crop={w}:{h}:{x}:{y},format=gray', '-vsync', 'passthrough', '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w).astype(np.int16)

def changes(fr):
    return [False] + [bool((np.abs(fr[i] - fr[i - 1]) > a.thresh).sum() >= a.min_pixels) for i in range(1, len(fr))]

pts = [float(t) for t in subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', a.video], capture_output=True, text=True).stdout.split()]
tc = changes(frames(a.tap))
rcs = [changes(frames(r)) for r in a.resp]
n = min([len(tc), len(pts)] + [len(r) for r in rcs])
out, last = [], -1e9
for i in range(1, n):
    if not tc[i]:
        continue
    t = pts[i]
    quiet = t - last >= a.quiet
    last = t
    if not quiet:
        continue
    for j in range(i, n):
        if pts[j] - t > 0.5:
            out.append((round(t, 2), None)); break
        hit = [k for k, r in enumerate(rcs) if r[j]]
        if hit:
            out.append((round(t, 2), round((pts[j] - t) * 1000), hit[0])); break
lat = sorted(x[1] for x in out if x[1] is not None)
print(f'{a.video}: {len(out)} touch-downs; (time s, latency ms, region) {out}')
print(f'median {lat[len(lat) // 2] if lat else "-"} ms over {len(lat)} responses')
