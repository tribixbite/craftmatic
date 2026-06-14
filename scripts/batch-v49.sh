#!/bin/bash
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun

vox() {
  local glb="$1" out="$2" extra="$3"
  echo "=== $out ==="
  timeout 120 $BUN scripts/voxelize-glb.ts "$DIR/$glb" --auto $extra -o "$DIR/$out" 2>&1 | grep -E "OSM mask|Interior fill|Skipping fill|Palette consolidation|Mode filter|Window|Grid:" || true
  echo ""
}

# Top scorers — verify k=7 doesn't regress
vox "tiles-the-dakota-new-york-ny.glb" "dakota-v49.schem"
vox "transamerica-headless.glb" "transamerica-v49.schem"
vox "tiles-flatiron-building-new-york-ny.glb" "flatiron-v49.schem"
vox "tiles-sentinel-building-san-francisco-ca.glb" "sentinel-v49.schem"

# Mid-tier with OSM masking — check material improvement
vox "tiles-st-patrick-s-cathedral-new-york-ny.glb" "stpatricks-v49.schem" "--coords 40.7585,-73.9760"
vox "tiles-450-noe-st-san-francisco-ca.glb" "noe-v49.schem" "--coords 37.7553,-122.4334"

echo "=== BATCH DONE ==="
