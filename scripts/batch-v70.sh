#!/bin/bash
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun
ABS="$(cd "$(dirname "$0")/.." && pwd)"

vox() {
  local glb="$1" out="$2" extra="$3"
  echo "=== $out ==="
  timeout 120 $BUN scripts/voxelize-glb.ts "$DIR/$glb" --auto $extra -o "$ABS/$DIR/$out" 2>&1 | grep -E "Satellite roof|OSM mask|Interior fill|Skipping fill|Mode filter|Window|Grid:|Zone facade|Roof parapet|Surface smooth|Facade flatten|Open-air" || true
  echo ""
}

# SF residential (with coords for OSM masking)
vox "tiles-sentinel-building-san-francisco-ca.glb" "sentinel-v70.schem" "--coords 37.7957,-122.4067"
vox "tiles-2340-francisco-st-san-francisco-ca.glb" "francisco-v70.schem" "--coords 37.7990,-122.4372"
vox "tiles-2390-green-st-san-francisco-ca.glb" "green-v70.schem" "--coords 37.7966,-122.4393"
vox "tiles-2130-beach-st-san-francisco-ca.glb" "beach-v70.schem" "--coords 37.8004,-122.4365"
vox "tiles-2001-chestnut-st-san-francisco-ca.glb" "chestnut-v70.schem" "--coords 37.8007,-122.4378"

# NYC
vox "tiles-the-dakota-new-york-ny.glb" "dakota-v70.schem" "--coords 40.7764,-73.9762"

# Noe — skip OSM (wrong polygon), tight crop
vox "tiles-450-noe-st-san-francisco-ca.glb" "noe-v70.schem" "--no-osm --crop 8"

echo "=== BATCH DONE ==="
