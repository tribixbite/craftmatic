#!/usr/bin/env bash
# Montages for a verification round (Git Bash + ImageMagick 7).
#
#   bash scripts/_verify-sets-montage.sh <outDir> "<set> <set> ...">
#
# HARD CONSTRAINT (user global rule): no image dimension may be >= 2000 px and
# every file must stay under 4 MB. Tile widths below are chosen so the widest
# output lands at 1974 px.
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT=${1:-output/verify-sets}
SETS=${2:-"910047 910004 10303 10326 76419 71043 76435 21061 21063 60446 10341 10337 42172 76286 31141 11371 21318 910032"}

# ---- per-set montage: iso | front | left, labelled ------------------------
for s in $SETS; do
  d="$ROOT/$s"
  imgs=""
  for v in iso front left; do
    [ -f "$d/$s-$v.png" ] && imgs="$imgs $d/$s-$v.png"
  done
  if [ -z "$imgs" ]; then echo "SKIP $s (no captures)"; continue; fi
  # 3 x 640 + gutters = 1956 px wide. `-label` is an image SETTING, so it has
  # to precede the filenames it applies to — after them it silently no-ops.
  magick montage -background '#111' -fill '#ddd' -pointsize 20 -label '%t' $imgs \
    -tile 3x1 -geometry '640x640>+6+6' "$d/montage.png" \
    && echo "OK   $d/montage.png"
done

# ---- contact sheets: one tile per set, iso and front ----------------------
for v in iso front; do
  tiles=""
  for s in $SETS; do
    [ -f "$ROOT/$s/$s-$v.png" ] && tiles="$tiles $ROOT/$s/$s-$v.png"
  done
  out="$ROOT/contact-sheet.png"
  [ "$v" = front ] && out="$ROOT/contact-sheet-front.png"
  # 6 x 320 + gutters = 1974 px wide, 3 rows.
  magick montage -background '#111' -fill '#ddd' -pointsize 26 -label '%t' $tiles \
    -tile 6x3 -geometry '320x320>+6+6' "$out" && echo "OK   $out"
done

echo '--- sizes (must be < 2000 px and < 4 MB) ---'
magick identify "$ROOT"/*/montage.png "$ROOT"/contact-sheet*.png 2>/dev/null \
  | awk '{print $1, $3, $7}'
