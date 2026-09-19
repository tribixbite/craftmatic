#!/bin/bash
# Pixel QA: device memory / frame-time / world-load harness for Minecraft Bedrock.
#
#   scripts/_pixel_perf.sh mem   <label> [outdir]  → one meminfo sample appended to samples.tsv
#   scripts/_pixel_perf.sh fps   <label> [outdir]  → frame-interval stats appended to fps.tsv
#   scripts/_pixel_perf.sh ref   [outdir]          → capture the in-world HUD reference crop
#   scripts/_pixel_perf.sh load  <label> [outdir]  → press world tile 1, time the load to in-world
#
# Two device facts this exists to work around (measured 2026-09-19, Pixel 8 Pro, 1.26.51.1):
#   * `dumpsys gfxinfo com.mojang.minecraftpe` sees almost NO frames - Minecraft draws into a
#     SurfaceView, not through HWUI. Real present timestamps come from SurfaceFlinger's
#     `--latency` on the app's (BLAST) layer; column 2 is the actual present time in ns.
#   * The adb-over-wifi transport on this device drops under load, and a dropped call is
#     indistinguishable from a dead device, so every call retries through a reconnect.
#
# `load` needs a HUD reference captured by `ref` while in-world: brightness cannot separate the
# loading dialog from the game (a screen full of entities is just as bright), but the HUD's
# right-hand buttons are a static crop, so RMSE against them is a clean in-world/not test.
set -uo pipefail
export MSYS_NO_PATHCONV=1   # Git Bash rewrites "/storage/..." into a Windows path otherwise
: "${ANDROID_SERIAL:?set ANDROID_SERIAL=<ip:port> first (adb devices -l)}"

PKG=com.mojang.minecraftpe
MODE="${1:?usage: _pixel_perf.sh mem|fps|ref|load <label> [outdir]}"
case "$MODE" in
  ref) LABEL=""; DIR="${2:-output/bedrock-entity-qa/perf}";;
  *)   LABEL="${2:?label}"; DIR="${3:-output/bedrock-entity-qa/perf}";;
esac
mkdir -p "$DIR"

# The HUD crop is in native screencap pixels for the Pixel 8 Pro in landscape (2244x1008).
HUD_CROP=160x330+2005+335
TILE_X=297; TILE_Y=527   # world tile 1 on the Play screen; taps need a ~120 ms press

a() { # adb with one reconnect retry - TEXT output only, never binary
  local out rc
  out=$(adb "$@" 2>&1); rc=$?
  if [ $rc -ne 0 ] || echo "$out" | grep -qE 'device offline|not connected|closed|no devices'; then
    adb connect "$ANDROID_SERIAL" >/dev/null 2>&1; sleep 2
    out=$(adb "$@" 2>&1); rc=$?
  fi
  printf '%s' "$out"; return $rc
}

grab() { # binary-safe screencap into $1
  adb exec-out screencap -p > "$1" 2>/dev/null || {
    adb connect "$ANDROID_SERIAL" >/dev/null 2>&1; sleep 2
    adb exec-out screencap -p > "$1"
  }
}

case "$MODE" in
mem)
  raw="$DIR/mem-$LABEL.txt"
  a shell dumpsys meminfo "$PKG" > "$raw"
  python - "$raw" "$LABEL" "$(date +%H:%M:%S)" "$DIR/samples.tsv" <<'PY'
import re, sys, os
raw, label, ts, tsv = sys.argv[1:5]
t = open(raw, encoding='utf-8', errors='replace').read()
def row(name, idx):
    m = re.search(r'^\s*' + re.escape(name) + r'\s+((?:\d+\s+){3,8}\d+)\s*$', t, re.M)
    return m.group(1).split()[idx] if m else ''
vals = {'nativePss': row('Native Heap', 0), 'nativeAlloc': row('Native Heap', 6),
        'nativeRss': row('Native Heap', 4), 'glMtrack': row('GL mtrack', 0),
        'eglMtrack': row('EGL mtrack', 0), 'totalPss': row('TOTAL', 0)}
hdr = ['ts', 'label'] + list(vals)
line = [ts, label] + [vals[k] for k in vals]
new = not os.path.exists(tsv)
with open(tsv, 'a', encoding='utf-8') as f:
    if new: f.write(chr(9).join(hdr) + chr(10))
    f.write(chr(9).join(line) + chr(10))
print(chr(9).join(hdr)); print(chr(9).join(line))
PY
  ;;
fps)
  layer=$(a shell dumpsys SurfaceFlinger --list \
          | grep -oE 'RequestedLayerState\{[^}]*SurfaceView\[com\.mojang\.minecraftpe[^}]*\(BLAST\)#[0-9]+' \
          | sed 's/^RequestedLayerState{//' | head -1)
  [ -z "$layer" ] && { echo "no BLAST layer for $PKG - is the game in the foreground?" >&2; exit 1; }
  a shell "dumpsys SurfaceFlinger --latency \"$layer\"" > "$DIR/fps-$LABEL.txt"
  python - "$DIR/fps-$LABEL.txt" "$LABEL" "$DIR/fps.tsv" <<'PY'
import sys, os, statistics
f, label, tsv = sys.argv[1:4]
rows = [l.split() for l in open(f) if l.strip()]
pres = [int(r[1]) for r in rows if len(r) == 3 and r[1] != '0' and int(r[1]) < 2 ** 62]
d = sorted((b - a) / 1e6 for a, b in zip(pres, pres[1:]) if 0 < b - a < 2e9)
if not d:
    print(label, 'NO FRAMES'); raise SystemExit
out = dict(label=label, frames=len(d), median_ms=round(statistics.median(d), 2),
           mean_ms=round(statistics.fmean(d), 2), p90_ms=round(d[int(len(d) * .9) - 1], 2),
           fps=round(1000 / statistics.median(d), 1))
new = not os.path.exists(tsv)
with open(tsv, 'a', encoding='utf-8') as fh:
    if new: fh.write(chr(9).join(out) + chr(10))
    fh.write(chr(9).join(str(v) for v in out.values()) + chr(10))
print(out)
PY
  ;;
ref)
  grab "$DIR/_ref.png"
  magick "$DIR/_ref.png" -crop "$HUD_CROP" +repage "$DIR/ref-hud.png"
  rm -f "$DIR/_ref.png"
  echo "$DIR/ref-hud.png"
  ;;
load)
  [ -f "$DIR/ref-hud.png" ] || { echo "run '_pixel_perf.sh ref' in-world first" >&2; exit 1; }
  a shell input swipe $TILE_X $TILE_Y $TILE_X $TILE_Y 120 >/dev/null
  t0=$(date +%s.%N)
  for _ in $(seq 1 90); do
    sleep 2
    grab "$DIR/_poll.png"
    magick "$DIR/_poll.png" -crop "$HUD_CROP" +repage "$DIR/_poll_crop.png"
    r=$(magick compare -metric RMSE "$DIR/ref-hud.png" "$DIR/_poll_crop.png" null: 2>&1 \
        | grep -oE '\(([0-9.]+)\)' | tr -d '()')
    [ -z "$r" ] && r=1
    el=$(python -c "print(f'{$(date +%s.%N)-$t0:.1f}')")
    echo "$el s  rmse=$r"
    if python -c "import sys; sys.exit(0 if $r < 0.15 else 1)"; then
      echo "LOADED $LABEL in $el s"
      printf '%s\t%s\n' "$LABEL" "$el" >> "$DIR/loadtimes.tsv"
      rm -f "$DIR/_poll.png" "$DIR/_poll_crop.png"; exit 0
    fi
  done
  echo "TIMEOUT $LABEL" >&2; rm -f "$DIR/_poll.png" "$DIR/_poll_crop.png"; exit 1
  ;;
*) echo "unknown mode: $MODE" >&2; exit 2;;
esac
