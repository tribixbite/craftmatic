#!/bin/bash
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun

vox() {
  local glb="$1" out="$2" extra="$3"
  echo "=== $out ==="
  timeout 120 $BUN scripts/voxelize-glb.ts "$DIR/$glb" --auto $extra -o "$DIR/$out" 2>&1 | grep -E "OSM mask|Interior fill|Skipping fill|Open-air|Palette|Mode filter|Grid:" || true
  echo ""
}

# Buildings that were at 70-85% density (now get fill instead of skip)
vox "nyc-ansonia-headless.glb" "ansonia-v48b.schem" "--coords 40.7840,-73.9810"
vox "nyc-sanremo-headless.glb" "sanremo-v48b.schem" "--coords 40.7830,-73.9730"
vox "pentagon-headless.glb" "pentagon-v48b.schem"
vox "tiles-st-patrick-s-cathedral-new-york-ny.glb" "stpatricks-v48b.schem" "--coords 40.7585,-73.9760"
# Verify top scorers unchanged
vox "tiles-the-dakota-new-york-ny.glb" "dakota-v48b.schem"
vox "tiles-flatiron-building-new-york-ny.glb" "flatiron-v48b.schem"
vox "transamerica-headless.glb" "transamerica-v48b.schem"

echo "=== BATCH DONE ==="
