#!/bin/bash
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun

vox() {
  local glb="$1" out="$2"
  echo "=== $out ==="
  timeout 120 $BUN scripts/voxelize-glb.ts "$DIR/$glb" --auto -o "$DIR/$out" 2>&1 | grep -E "Skipping fill|Interior fill|Palette consolidation|Mode filter|Window|Grid:" || true
  echo ""
}

# Original test addresses (residential)
vox "tiles-450-noe-st-san-francisco-ca.glb" "noe-v48.schem"
vox "tiles-525-s-winchester-blvd-san-jose-ca-95128.glb" "sanjose-v48.schem"
vox "tiles-216-zekes-point-rd-vinalhaven-me-04863.glb" "vinalhaven-v48.schem"
vox "tiles-4810-sw-ledroit-pl-seattle-wa-98136.glb" "seattle-v48.schem"
vox "tiles-41-legare-st-charleston-sc-29401.glb" "charleston-v48.schem"
vox "tiles-8504-long-canyon-dr-austin-tx-78730.glb" "austin-v48.schem"
vox "tiles-2730-ulysses-st-ne-minneapolis-mn-55418.glb" "minneapolis-v48.schem"
vox "tiles-240-highland-st-newton-ma-02465.glb" "newton-v48.schem"

# St. Patrick's + Francisco (from v47c, not yet graded)
vox "tiles-st-patrick-s-cathedral-new-york-ny.glb" "stpatricks-v48.schem"
vox "tiles-2340-francisco-st-san-francisco-ca.glb" "francisco-v48.schem"

# NYC apartments
vox "nyc-ansonia-headless.glb" "ansonia-v48.schem"
vox "nyc-sanremo-headless.glb" "sanremo-v48.schem"

echo "=== BATCH DONE ==="
