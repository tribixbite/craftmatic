#!/bin/bash
# Batch voxelize v26 — r=4, fill, generic mode
# Same pipeline as v16 but at 4 blocks/meter (33% more detail)
# Crop values = 4× meter values (v16 used 3×)
set -e

BUN=~/.bun/bin/bun
DIR=output/tiles
# 4 blocks/m, surface mode, generic (no building-specific post-processing)
COMMON="-m surface -r 4 --generic --fill --mode-passes 3 --smooth-pct 0.03"

vox() {
  local glb="$1" name="$2" crop="$3" coords="$4"
  echo "=== $name (crop=$crop, r=4) ==="
  $BUN scripts/voxelize-glb.ts "$DIR/tiles-$glb.glb" $COMMON --crop "$crop" --coords "$coords" -o "$DIR/${name}-v26.schem" 2>&1 | grep -E 'Grid:|Palette:|Wrote:|ENU|Error|OSM footprint|crop|ground|Interior|Total:'
  echo ""
}

# 12 addresses — crop values are 4× meter radius
# v16 meter values: sf=18, newton=15, sanjose=18, walpole=18, byron=18,
# vinalhaven=16, suttonsbay=15, losangeles=15, seattle=18, austin=18,
# minneapolis=15, charleston=18
vox "2340-francisco-st-san-francisco-ca-94123"     sf           72 "37.8011,-122.4439"
vox "240-highland-st-newton-ma-02465"              newton       60 "42.3435,-71.2215"
vox "525-s-winchester-blvd-san-jose-ca-95128"      sanjose      72 "37.3183,-121.9511"
vox "13-union-st-walpole-nh-03608"                 walpole      72 "43.0775,-72.4248"
vox "2431-72nd-st-sw-byron-center-mi-49315"        byron        72 "42.8350,-85.7236"
vox "216-zekes-point-rd-vinalhaven-me-04863"       vinalhaven   64 "44.1172,-68.8472"
vox "5835-s-bridget-rose-ln-suttons-bay-mi-49682"  suttonsbay   60 "44.8946,-85.6412"
vox "2607-glendower-ave-los-angeles-ca-90027"      losangeles   60 "34.1162,-118.2929"
vox "4810-sw-ledroit-pl-seattle-wa-98136"          seattle      72 "47.5389,-122.3942"
vox "8504-long-canyon-dr-austin-tx-78730"          austin       72 "30.3714,-97.8206"
vox "2730-ulysses-st-ne-minneapolis-mn-55418"      minneapolis  60 "45.0180,-93.2361"
vox "41-legare-st-charleston-sc-29401"             charleston   72 "32.7744,-79.9345"

echo "=== All v26 schematics done ==="
