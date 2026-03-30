#!/bin/bash
# Batch voxelize all 12 tiles buildings with OSM footprint masking (v8)
set -e
BUN=~/.bun/bin/bun
DIR=/data/data/com.termux/files/home/git/craftmatic/output/tiles
SCRIPT=/data/data/com.termux/files/home/git/craftmatic/scripts/voxelize-glb.ts
COMMON="--crop 20 -m surface -r 1 --generic --fill"

declare -A GLBS=(
  [sf]="tiles-2340-francisco-st-san-francisco-ca-94123.glb 37.8005,-122.4382"
  [newton]="tiles-240-highland-st-newton-ma-02465.glb 42.3295,-71.2105"
  [sanjose]="tiles-525-s-winchester-blvd-san-jose-ca-95128.glb 37.3127,-121.9480"
  [walpole]="tiles-13-union-st-walpole-nh-03608.glb 43.0767,-72.4309"
  [byron]="tiles-2431-72nd-st-sw-byron-center-mi-49315.glb 42.8064,-85.7252"
  [vinalhaven]="tiles-216-zekes-point-rd-vinalhaven-me-04863.glb 44.0521,-68.8020"
  [suttonsbay]="tiles-5835-s-bridget-rose-ln-suttons-bay-mi-49682.glb 44.9038,-85.6490"
  [losangeles]="tiles-2607-glendower-ave-los-angeles-ca-90027.glb 34.1103,-118.2808"
  [seattle]="tiles-4810-sw-ledroit-pl-seattle-wa-98136.glb 47.5551,-122.3876"
  [austin]="tiles-8504-long-canyon-dr-austin-tx-78730.glb 30.3456,-97.8005"
  [minneapolis]="tiles-2730-ulysses-st-ne-minneapolis-mn-55418.glb 45.0235,-93.2225"
  [charleston]="tiles-41-legare-st-charleston-sc-29401.glb 32.7716,-79.9377"
)

for key in sf newton sanjose walpole byron vinalhaven suttonsbay losangeles seattle austin minneapolis charleston; do
  read -r glb coords <<< "${GLBS[$key]}"
  echo "=== $key ==="
  $BUN $SCRIPT "$DIR/$glb" $COMMON --coords "$coords" -o "$DIR/${key}-v8.schem" 2>&1 | grep -E "^(OSM|Ground|Center|Grid|Wrote|Component)" || true
  echo ""
done
echo "All done."
