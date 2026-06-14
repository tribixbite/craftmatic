#!/bin/bash
# v72: 2 blocks/meter resolution for all buildings
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun
ABS="$(cd "$(dirname "$0")/.." && pwd)"

vox() {
  local glb="$1" out="$2" extra="$3"
  echo "=== $out ==="
  timeout 240 $BUN scripts/voxelize-glb.ts "$DIR/$glb" --auto --resolution 2 $extra -o "$ABS/$DIR/$out" 2>&1 | grep -E "Components|Grid:|Zone facade|Wrote:|ENU result" || true
  echo ""
}

# Core 7 buildings — best candidates from v71 scouting
# 1. Flatiron — distinctive wedge shape (was 7/10 at 2x)
vox "tiles-flatiron-building-new-york-ny.glb" "flatiron-v72.schem" "--coords 40.7411,-73.9897"

# 2. Montgomery — triangle footprint + peaked roof (was 9/10 at 2x)
vox "tiles-600-montgomery-st-san-francisco-ca.glb" "montgomery-v72.schem" "--coords 37.7954,-122.4029"

# 3. Sentinel — L-shape with courtyard (was 5/10 at 2x)
vox "tiles-sentinel-building-san-francisco-ca.glb" "sentinel-v72.schem" "--coords 37.7957,-122.4067"

# 4. Chestnut — small residential, use OSM coords
vox "tiles-2001-chestnut-st-san-francisco-ca.glb" "chestnut-v72.schem" "--coords 37.8007,-122.4378"

# 5. Beach — two buildings (known gap issue, try at 2x)
vox "tiles-2130-beach-st-san-francisco-ca.glb" "beach-v72.schem" "--coords 37.8004,-122.4365"

# 6. Francisco — two small wings
vox "tiles-2340-francisco-st-san-francisco-ca.glb" "francisco-v72.schem" "--coords 37.7990,-122.4372"

# 7. Green — small building
vox "tiles-2390-green-st-san-francisco-ca.glb" "green-v72.schem" "--coords 37.7966,-122.4393"

echo "=== BATCH v72 DONE ==="
