#!/bin/bash
# Batch v79: Resolution boost + higher quality renders
# Strategy:
# - Flatiron at 2x resolution for smoother wedge edges
# - Green/Francisco re-voxelize with tight mask for correct footprint
# - All renders at tile=8, grade at 500px panels
set -e
V="bun scripts/voxelize-glb.ts"
R="bun scripts/_render-one.ts"
T="bun scripts/_render-topdown.ts"

echo "=== v79: Resolution boost + quality re-renders ==="

# ── Flatiron: 2x resolution for smoother wedge geometry ──
echo "--- Flatiron (2x resolution) ---"
$V "output/tiles/tiles-flatiron-building-new-york-ny.glb" --auto \
  --coords "40.7411,-73.9897" --mask-dilate 1 --resolution 2 \
  -o "output/tiles/flatiron-v79.schem" 2>&1 | grep -E "(Roof darken|Wall contrast|Zone |Grid:|mask|polygon|resolution)"
$R "output/tiles/flatiron-v79.schem" "output/tiles/flatiron-v79-iso.jpg" --tile 4 2>&1 | tail -1
$T "output/tiles/flatiron-v79.schem" "output/tiles/flatiron-v79-topdown.jpg" --scale 6 2>&1 | tail -1
echo

# ── Green: re-voxelize with correct coords + tight mask ──
echo "--- Green (re-voxelize tight mask) ---"
$V "output/tiles/tiles-2390-green-st-san-francisco-ca.glb" --auto \
  --coords "37.7972,-122.4378" --mask-dilate 1 \
  -o "output/tiles/green-v79.schem" 2>&1 | grep -E "(Roof darken|Wall contrast|Zone |Grid:|mask|polygon)"
$R "output/tiles/green-v79.schem" "output/tiles/green-v79-iso.jpg" --tile 8 2>&1 | tail -1
$T "output/tiles/green-v79.schem" "output/tiles/green-v79-topdown.jpg" --scale 12 2>&1 | tail -1
echo

# ── Francisco: re-voxelize with tight mask ──
echo "--- Francisco (re-voxelize tight mask) ---"
$V "output/tiles/tiles-2340-francisco-st-san-francisco-ca.glb" --auto \
  --coords "37.8005,-122.4384" --mask-dilate 1 \
  -o "output/tiles/francisco-v79.schem" 2>&1 | grep -E "(Roof darken|Wall contrast|Zone |Grid:|mask|polygon)"
$R "output/tiles/francisco-v79.schem" "output/tiles/francisco-v79-iso.jpg" --tile 8 2>&1 | tail -1
$T "output/tiles/francisco-v79.schem" "output/tiles/francisco-v79-topdown.jpg" --scale 12 2>&1 | tail -1
echo

# ── Re-render existing v78 keepers at tile=8 ──
for entry in "Noe:noe" "Beach:beach"
do
  IFS=: read -r name slug <<< "$entry"
  schem="output/tiles/${slug}-v78.schem"
  echo "--- $name (re-render tile=8) ---"
  $R "$schem" "output/tiles/${slug}-v79-iso.jpg" --tile 8 2>&1 | tail -1
  $T "$schem" "output/tiles/${slug}-v79-topdown.jpg" --scale 12 2>&1 | tail -1
  echo
done

echo "=== Done ==="
