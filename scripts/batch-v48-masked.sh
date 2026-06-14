#!/bin/bash
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun

vox() {
  local glb="$1" out="$2" coords="$3"
  echo "=== $out ==="
  timeout 120 $BUN scripts/voxelize-glb.ts "$DIR/$glb" --auto --coords "$coords" -o "$DIR/$out" 2>&1 | grep -E "OSM mask|Interior fill|Skipping fill|Palette consolidation|Mode filter|Window|Grid:" || true
  echo ""
}

# Residential addresses with coordinates for OSM footprint masking
vox "tiles-450-noe-st-san-francisco-ca.glb" "noe-v48m.schem" "37.7553,-122.4334"
vox "tiles-525-s-winchester-blvd-san-jose-ca-95128.glb" "sanjose-v48m.schem" "37.3184,-121.9510"
vox "tiles-216-zekes-point-rd-vinalhaven-me-04863.glb" "vinalhaven-v48m.schem" "44.0576,-68.8137"
vox "tiles-4810-sw-ledroit-pl-seattle-wa-98136.glb" "seattle-v48m.schem" "47.5580,-122.3876"
vox "tiles-41-legare-st-charleston-sc-29401.glb" "charleston-v48m.schem" "32.7720,-79.9350"
vox "tiles-8504-long-canyon-dr-austin-tx-78730.glb" "austin-v48m.schem" "30.3695,-97.8170"
vox "tiles-2730-ulysses-st-ne-minneapolis-mn-55418.glb" "minneapolis-v48m.schem" "45.0105,-93.2285"
vox "tiles-240-highland-st-newton-ma-02465.glb" "newton-v48m.schem" "42.3325,-71.2060"

# Extra buildings
vox "tiles-st-patrick-s-cathedral-new-york-ny.glb" "stpatricks-v48m.schem" "40.7585,-73.9760"
vox "tiles-2340-francisco-st-san-francisco-ca.glb" "francisco-v48m.schem" "37.7990,-122.4360"
vox "nyc-ansonia-headless.glb" "ansonia-v48m.schem" "40.7840,-73.9810"
vox "nyc-sanremo-headless.glb" "sanremo-v48m.schem" "40.7830,-73.9730"

echo "=== BATCH DONE ==="
