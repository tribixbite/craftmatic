"""How many distinct pictures per second a screen recording shows in a region.

A device renders at up to 60 fps, but an entity the server teleports moves
only 20 times a second: most frames repeat the previous picture. This counts,
per second of video, the frames whose region differs from the previous frame
by more than a pixel threshold - the motion rate a player actually sees.
Used for the pinball ball (teleport vs client-drawn, 2026-09-25).

Usage: python scripts/_video_motion_rate.py <video.mp4> --crop=W:H:X:Y [--from=s] [--to=s] [--thresh=12] [--min-pixels=20]
Needs ffmpeg on PATH.
"""
import argparse, subprocess
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('video')
ap.add_argument('--crop', required=True, help='W:H:X:Y in video pixels')
ap.add_argument('--from', dest='t0', type=float, default=0.0)
ap.add_argument('--to', dest='t1', type=float, default=1e9)
ap.add_argument('--thresh', type=int, default=12, help='grey-level change that counts as a changed pixel')
ap.add_argument('--min-pixels', type=int, default=20, help='changed pixels that make a frame "new"')
a = ap.parse_args()
w, h, x, y = (int(v) for v in a.crop.split(':'))
cmd = ['ffmpeg', '-loglevel', 'error', '-ss', str(a.t0), '-i', a.video, '-t', str(max(0.0, a.t1 - a.t0)),
       '-vf', f'crop={w}:{h}:{x}:{y},format=gray', '-vsync', 'passthrough', '-f', 'rawvideo', '-']
raw = subprocess.run(cmd, capture_output=True, check=True).stdout
frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w).astype(np.int16)
probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', a.video], capture_output=True, text=True).stdout.strip()
num, den = (float(v) for v in probe.split('/'))
fps = num / den if den else 60.0
changed = [(np.abs(frames[i] - frames[i - 1]) > a.thresh).sum() >= a.min_pixels for i in range(1, len(frames))]
secs = len(frames) / fps
new = int(sum(changed))
print(f'{a.video}: {len(frames)} frames over {secs:.2f} s ({fps:.1f} fps average); {new} frames show a new picture in the region = {new / secs:.1f} per second')
# Per half-second, to see where motion happened.
step = max(1, int(round(fps / 2)))
print('per 0.5 s:', [int(sum(changed[i:i + step])) for i in range(0, len(changed), step)])
