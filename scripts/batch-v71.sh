#!/bin/bash
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun
ABS="$(cd "$(dirname "$0")/.." && pwd)"

vox() {
  local glb="$1" out="$2" extra="$3"
  echo "=== $out ==="
  timeout 120 $BUN scripts/voxelize-glb.ts "$DIR/$glb" --auto $extra -o "$ABS/$DIR/$out" 2>&1 | grep -E "Morph close|Satellite roof|OSM mask|Interior fill|Skipping fill|Mode filter|Window|Grid:|Zone facade|Roof parapet|Surface smooth|Facade flatten|Open-air|Footprint enforce|enforceFootprint" || true
  echo ""
}

# SF residential (with coords for OSM masking)
vox "tiles-sentinel-building-san-francisco-ca.glb" "sentinel-v71.schem" "--coords 37.7957,-122.4067"
vox "tiles-2340-francisco-st-san-francisco-ca.glb" "francisco-v71.schem" "--coords 37.7990,-122.4372"
vox "tiles-2390-green-st-san-francisco-ca.glb" "green-v71.schem" "--coords 37.7966,-122.4393"
vox "tiles-2130-beach-st-san-francisco-ca.glb" "beach-v71.schem" "--coords 37.8004,-122.4365"
vox "tiles-2001-chestnut-st-san-francisco-ca.glb" "chestnut-v71.schem" "--coords 37.8007,-122.4378"

# NYC — Dakota partial capture, keep for comparison
vox "tiles-the-dakota-new-york-ny.glb" "dakota-v71.schem" "--coords 40.7764,-73.9762"

# Flatiron — replacement for Noe (clear wedge shape, good source data)
vox "tiles-flatiron-building-new-york-ny.glb" "flatiron-v71.schem" "--coords 40.7411,-73.9897"

echo "=== BATCH DONE ==="
