#!/bin/bash
# Batch voxelize v18 — generic mode (best), r=3, more aggressive smoothing
# Changes from v17: revert to --generic (v16 baseline was better),
# increase smoothing (5 passes, 5% threshold) for cleaner geometry.
# Key insight: baked texture shadows = correct signal, don't destroy with rectification.
set -e

BUN=~/.bun/bin/bun
DIR=output/tiles
# Generic mode preserves raw geometry (v16 scored 2.58 avg vs v17 1.75)
# 5 mode passes + 5% smooth for cleaner surfaces
COMMON="-m surface -r 3 --generic --fill --mode-passes 5 --smooth-pct 0.05"

vox() {
  local glb="$1" name="$2" crop="$3" coords="$4"
  echo "=== $name (crop=$crop, coords=$coords) ==="
  $BUN scripts/voxelize-glb.ts "$DIR/tiles-$glb.glb" $COMMON --crop "$crop" --coords "$coords" -o "$DIR/${name}-v18.schem" 2>&1 | grep -E 'Grid:|Palette:|Wrote:|ENU|Error|OSM footprint|crop|ground|Interior|rectif|Vertical|Horizontal|solidif|Mode|Palette con|component|Smooth|Generic'
  echo ""
}

# 12 addresses — per-building crop tuning at 3 blocks/m
# Tighter crops for better building isolation
vox "2340-francisco-st-san-francisco-ca-94123"   sf           36 "37.8011,-122.4439"
vox "240-highland-st-newton-ma-02465"            newton       45 "42.3435,-71.2215"
vox "525-s-winchester-blvd-san-jose-ca-95128"    sanjose      54 "37.3183,-121.9511"
vox "13-union-st-walpole-nh-03608"               walpole      36 "43.0775,-72.4248"
vox "2431-72nd-st-sw-byron-center-mi-49315"      byron        36 "42.8350,-85.7236"
vox "216-zekes-point-rd-vinalhaven-me-04863"     vinalhaven   36 "44.1172,-68.8472"
vox "5835-s-bridget-rose-ln-suttons-bay-mi-49682" suttonsbay  36 "44.8946,-85.6412"
vox "2607-glendower-ave-los-angeles-ca-90027"    losangeles   36 "34.1162,-118.2929"
vox "4810-sw-ledroit-pl-seattle-wa-98136"        seattle      45 "47.5389,-122.3942"
vox "8504-long-canyon-dr-austin-tx-78730"        austin       45 "30.3714,-97.8206"
vox "2730-ulysses-st-ne-minneapolis-mn-55418"    minneapolis  36 "45.0180,-93.2361"
vox "41-legare-st-charleston-sc-29401"           charleston   45 "32.7744,-79.9345"

echo "=== Rendering top-down views ==="
for schem in $DIR/*-v18.schem; do
  name=$(basename "$schem" .schem)
  echo -n "  $name... "
  timeout 60 $BUN scripts/render-one-td.ts "$schem" 2>&1 | tail -1
  if [ $? -ne 0 ]; then echo "TIMEOUT"; fi
done

echo "Done! v18 schematics and renders in $DIR/"
