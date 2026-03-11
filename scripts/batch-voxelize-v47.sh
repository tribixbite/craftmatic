#!/bin/bash
# Batch voxelize ALL non-flatroof GLBs with v47 pipeline
# v47: MIN_BRIGHT 130→60, gamma 0.5→0.75, K-Means palette consolidation, narrower DARK_BLOCKS
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun
SCRIPT="scripts/voxelize-glb.ts"

vox() {
  local glb="$1" out="$2"
  echo "=== $out ==="
  timeout 120 $BUN $SCRIPT "$DIR/$glb" --auto -o "$DIR/$out" 2>&1 | grep -E "Window|Palette cons|Grid:|Palette:" || true
  echo ""
}

# Landmarks / headless captures
vox "tiles-empire-state-building-new-york-ny.glb" "esb-v47.schem"
vox "tiles-chrysler-building-new-york-ny.glb" "chrysler-v47.schem"
vox "tiles-flatiron-building-new-york-ny.glb" "flatiron-v47.schem"
vox "tiles-sentinel-building-san-francisco-ca.glb" "sentinel-v47.schem"
vox "tiles-st-patrick-s-cathedral-new-york-ny.glb" "stpatricks-v47.schem"
vox "tiles-the-dakota-new-york-ny.glb" "dakota-v47.schem"
vox "transamerica-headless.glb" "transamerica-v47.schem"
vox "uscapitol-headless.glb" "uscapitol-v47.schem"
vox "willistower-headless.glb" "willistower-v47.schem"
vox "pentagon-headless.glb" "pentagon-v47.schem"
vox "rosebowl-headless.glb" "rosebowl-v47.schem"
vox "guggenheim-headless.glb" "guggenheim-v47.schem"

# Headless captures — iconic buildings
vox "applepark-headless.glb" "applepark-v47.schem"
vox "geisel-headless.glb" "geisel-v47.schem"
vox "gettycenter-headless.glb" "gettycenter-v47.schem"
vox "mitdome-headless.glb" "mitdome-v47.schem"
vox "nyc-ansonia-headless.glb" "ansonia-v47.schem"
vox "nyc-apthorp-headless.glb" "apthorp-v47.schem"
vox "nyc-sanremo-headless.glb" "sanremo-v47.schem"
vox "chicago-loop-headless.glb" "chicagoloop-v47.schem"

# Headless — suburban/residential
vox "test-newton-headless.glb" "newton-v47.schem"
vox "tiles-arlington-headless.glb" "arlington-v47.schem"
vox "tiles-artinstitute-headless.glb" "artinstitute-v47.schem"
vox "tiles-bellaire-headless.glb" "bellaire-v47.schem"
vox "tiles-cambridge-headless.glb" "cambridge-v47.schem"
vox "tiles-dallas-headless.glb" "dallas-v47.schem"
vox "tiles-dallas2-headless.glb" "dallas2-v47.schem"
vox "tiles-scottsdale-headless.glb" "scottsdale-v47.schem"
vox "tiles-winnetka-headless.glb" "winnetka-v47.schem"

# Browser-captured addresses (SF + other)
vox "tiles-2340-francisco-st-san-francisco-ca.glb" "francisco-v47.schem"
vox "tiles-450-noe-st-san-francisco-ca.glb" "noe-v47.schem"
vox "tiles-2001-chestnut-st-san-francisco-ca.glb" "chestnut-v47.schem"
vox "tiles-2130-beach-st-san-francisco-ca.glb" "beach-v47.schem"
vox "tiles-2390-green-st-san-francisco-ca.glb" "green-v47.schem"
vox "tiles-3170-baker-st-san-francisco-ca.glb" "baker-v47.schem"
vox "tiles-3601-lyon-st-san-francisco-ca.glb" "lyon-v47.schem"
vox "tiles-600-montgomery-st-san-francisco-ca.glb" "montgomery-v47.schem"
vox "tiles-525-s-winchester-blvd-san-jose-ca-95128.glb" "winchester-v47.schem"
vox "tiles-240-highland-st-newton-ma-02465.glb" "newton2-v47.schem"
vox "tiles-216-zekes-point-rd-vinalhaven-me-04863.glb" "vinalhaven-v47.schem"
vox "tiles-13-union-st-walpole-nh-03608.glb" "walpole-v47.schem"
vox "tiles-2431-72nd-st-sw-byron-center-mi-49315.glb" "byron-v47.schem"
vox "tiles-2607-glendower-ave-los-angeles-ca-90027.glb" "glendower-v47.schem"
vox "tiles-2730-ulysses-st-ne-minneapolis-mn-55418.glb" "minneapolis-v47.schem"
vox "tiles-41-legare-st-charleston-sc-29401.glb" "charleston-v47.schem"
vox "tiles-4810-sw-ledroit-pl-seattle-wa-98136.glb" "seattle-v47.schem"
vox "tiles-5835-s-bridget-rose-ln-suttons-bay-mi-49682.glb" "suttonsbay-v47.schem"
vox "tiles-8504-long-canyon-dr-austin-tx-78730.glb" "austin-v47.schem"

echo "=== BATCH COMPLETE ==="
ls -la "$DIR"/*-v47.schem | wc -l
echo "files generated"
