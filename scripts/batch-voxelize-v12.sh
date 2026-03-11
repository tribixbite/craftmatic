#!/bin/bash
# Batch voxelize v12 — keep-vegetation + color preservation
# Key changes from v11: --keep-vegetation flag, path resolution fix
set -e

BUN=~/.bun/bin/bun
DIR=output/tiles
COMMON="-m surface -r 1 --generic --mode-passes 1 --smooth-pct 0.02 --keep-vegetation"

vox() {
  local glb="$1" name="$2" crop="$3"
  echo "=== $name (crop=$crop) ==="
  $BUN scripts/voxelize-glb.ts "$DIR/tiles-$glb.glb" $COMMON --crop "$crop" -o "$DIR/${name}-v12.schem" 2>&1 | grep -E 'Grid:|Palette:|Wrote:|ENU|Error'
  echo ""
}

# 12 core addresses — same as v11 with tuned crop radii
vox "2340-francisco-st-san-francisco-ca-94123"   sf           18
vox "240-highland-st-newton-ma-02465"            newton       15
vox "525-s-winchester-blvd-san-jose-ca-95128"    sanjose      18
vox "13-union-st-walpole-nh-03608"               walpole      18
vox "2431-72nd-st-sw-byron-center-mi-49315"      byron        18
vox "216-zekes-point-rd-vinalhaven-me-04863"     vinalhaven   16
vox "5835-s-bridget-rose-ln-suttons-bay-mi-49682" suttonsbay  15
vox "2607-glendower-ave-los-angeles-ca-90027"    losangeles   15
vox "4810-sw-ledroit-pl-seattle-wa-98136"        seattle      18
vox "8504-long-canyon-dr-austin-tx-78730"        austin       18
vox "2730-ulysses-st-ne-minneapolis-mn-55418"    minneapolis  15
vox "41-legare-st-charleston-sc-29401"           charleston   18

echo "=== Rendering top-down views ==="
for schem in $DIR/*-v12.schem; do
  $BUN scripts/render-one-td.ts "$schem" 2>&1 | tail -1
done

echo "Done! All v12 schematics and renders in $DIR/"
