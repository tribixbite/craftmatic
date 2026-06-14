#!/bin/bash
# Batch voxelize v15 — color pipeline v2: fixed selective desat + sky remap
# Changes from v14:
#   - Re-enabled selective desaturation (removed --desaturate-off)
#   - MIN_BRIGHT 60→100, DARK_THRESHOLD 20→30 (balanced shadow handling)
#   - Warm desat relaxed: l<0.72→l<0.40, s*=0.15→s*=0.3 (preserves brick/sandstone)
#   - light_blue_terracotta removed from blue-gray cluster (sky contamination fix)
#   - Palette remap: light_blue_terracotta→light_gray_concrete, cyan_terracotta→stone
#   - Added missing blocks to BLOCK_COLORS (renderer no longer shows hash-purple)
set -e

BUN=~/.bun/bin/bun
DIR=output/tiles
# 2 blocks/m, crop in block units (2x meter value), 3 mode passes, 5% smooth
# NOTE: no --desaturate-off — selective desat kills blue shadows while preserving warm tones
COMMON="-m surface -r 2 --generic --mode-passes 3 --smooth-pct 0.05"

vox() {
  local glb="$1" name="$2" crop="$3" coords="$4"
  echo "=== $name (crop=$crop, coords=$coords) ==="
  $BUN scripts/voxelize-glb.ts "$DIR/tiles-$glb.glb" $COMMON --crop "$crop" --coords "$coords" -o "$DIR/${name}-v15.schem" 2>&1 | grep -E 'Grid:|Palette:|Wrote:|ENU|Error|OSM footprint|crop|ground'
  echo ""
}

# 12 addresses — crop values doubled for 2 block/m (18m→36 blocks, 15m→30 blocks)
vox "2340-francisco-st-san-francisco-ca-94123"   sf           36 "37.8011,-122.4439"
vox "240-highland-st-newton-ma-02465"            newton       30 "42.3435,-71.2215"
vox "525-s-winchester-blvd-san-jose-ca-95128"    sanjose      36 "37.3183,-121.9511"
vox "13-union-st-walpole-nh-03608"               walpole      36 "43.0775,-72.4248"
vox "2431-72nd-st-sw-byron-center-mi-49315"      byron        36 "42.8350,-85.7236"
vox "216-zekes-point-rd-vinalhaven-me-04863"     vinalhaven   32 "44.1172,-68.8472"
vox "5835-s-bridget-rose-ln-suttons-bay-mi-49682" suttonsbay  30 "44.8946,-85.6412"
vox "2607-glendower-ave-los-angeles-ca-90027"    losangeles   30 "34.1162,-118.2929"
vox "4810-sw-ledroit-pl-seattle-wa-98136"        seattle      36 "47.5389,-122.3942"
vox "8504-long-canyon-dr-austin-tx-78730"        austin       36 "30.3714,-97.8206"
vox "2730-ulysses-st-ne-minneapolis-mn-55418"    minneapolis  30 "45.0180,-93.2361"
vox "41-legare-st-charleston-sc-29401"           charleston   36 "32.7744,-79.9345"

echo "=== Rendering top-down views ==="
for schem in $DIR/*-v15.schem; do
  name=$(basename "$schem" .schem)
  echo -n "  $name... "
  timeout 45 $BUN scripts/render-one-td.ts "$schem" 2>&1 | tail -1
  if [ $? -ne 0 ]; then echo "TIMEOUT"; fi
done

echo "Done! v15 schematics and renders in $DIR/"
