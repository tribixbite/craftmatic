#!/bin/bash
# Batch voxelize v17 — non-generic mode (rectify+solidify) at r=3
# Changes from v16: remove --generic, use full shape processing pipeline
# Per-building crop tuning for better isolation
set -e

BUN=~/.bun/bin/bun
DIR=output/tiles
# 3 blocks/m, full shape processing (no --generic), 3 mode passes, 3% smooth
COMMON="-m surface -r 3 --mode-passes 3 --smooth-pct 0.03"

vox() {
  local glb="$1" name="$2" crop="$3" coords="$4"
  echo "=== $name (crop=$crop, coords=$coords) ==="
  $BUN scripts/voxelize-glb.ts "$DIR/tiles-$glb.glb" $COMMON --crop "$crop" --coords "$coords" -o "$DIR/${name}-v17.schem" 2>&1 | grep -E 'Grid:|Palette:|Wrote:|ENU|Error|OSM footprint|crop|ground|Interior|rectif|Vertical|Horizontal|solidif|Mode|Palette con|component|Smooth'
  echo ""
}

# 12 addresses — per-building crop tuning at 3 blocks/m
# Large/complex: 54 blocks (18m), Medium: 45 (15m), Small: 36 (12m)
vox "2340-francisco-st-san-francisco-ca-94123"   sf           36 "37.8011,-122.4439"
vox "240-highland-st-newton-ma-02465"            newton       45 "42.3435,-71.2215"
vox "525-s-winchester-blvd-san-jose-ca-95128"    sanjose      54 "37.3183,-121.9511"
vox "13-union-st-walpole-nh-03608"               walpole      36 "43.0775,-72.4248"
vox "2431-72nd-st-sw-byron-center-mi-49315"      byron        36 "42.8350,-85.7236"
vox "216-zekes-point-rd-vinalhaven-me-04863"     vinalhaven   36 "44.1172,-68.8472"
vox "5835-s-bridget-rose-ln-suttons-bay-mi-49682" suttonsbay  36 "44.8946,-85.6412"
vox "2607-glendower-ave-los-angeles-ca-90027"    losangeles   36 "34.1162,-118.2929"
vox "4810-sw-ledroit-pl-seattle-wa-98136"        seattle      36 "47.5389,-122.3942"
vox "8504-long-canyon-dr-austin-tx-78730"        austin       45 "30.3714,-97.8206"
vox "2730-ulysses-st-ne-minneapolis-mn-55418"    minneapolis  36 "45.0180,-93.2361"
vox "41-legare-st-charleston-sc-29401"           charleston   45 "32.7744,-79.9345"

echo "=== Rendering top-down views ==="
for schem in $DIR/*-v17.schem; do
  name=$(basename "$schem" .schem)
  echo -n "  $name... "
  timeout 60 $BUN scripts/render-one-td.ts "$schem" 2>&1 | tail -1
  if [ $? -ne 0 ]; then echo "TIMEOUT"; fi
done

echo "Done! v17 schematics and renders in $DIR/"
