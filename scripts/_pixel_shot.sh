#!/bin/bash
# Pixel QA: screenshot the connected Android device into a size-safe JPEG.
#   scripts/_pixel_shot.sh <name> [outdir]   → <outdir>/<name>.jpg (≤1999 px, q85)
# Default outdir: output/bedrock-entity-qa/shots. Needs adb + ImageMagick (`magick`).
set -euo pipefail
export MSYS_NO_PATHCONV=1
name="${1:?usage: _pixel_shot.sh <name> [outdir]}"
out="${2:-output/bedrock-entity-qa/shots}"
mkdir -p "$out"
adb exec-out screencap -p > "$out/$name.png"
magick "$out/$name.png" -resize "1999x1999>" -quality 85 "$out/$name.jpg"
rm -f "$out/$name.png"
magick identify "$out/$name.jpg"
