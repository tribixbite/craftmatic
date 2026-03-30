#!/bin/bash
# Batch voxelize all 12 tiles buildings — v9
# Changes from v8: no OSM masking (coordinate alignment broken), expanded vegetation filter,
# tighter crop radii based on actual building sizes.
set -e
BUN=~/.bun/bin/bun
DIR=/data/data/com.termux/files/home/git/craftmatic/output/tiles
SCRIPT=/data/data/com.termux/files/home/git/craftmatic/scripts/voxelize-glb.ts
BASE="--fill -m surface -r 1 --generic"

# Per-building crop radii — estimated from OSM footprint dimensions:
# crop = max(width, length)/2 + 5 margin, capped at 20
# Rural addresses without clear buildings get crop=15
declare -A CROPS=(
  [sf]=15        # ~25x20m building, crop=17.5 → 15 (tight)
  [newton]=12    # ~15x10m house
  [sanjose]=15   # ~20x15m commercial
  [walpole]=15   # rural, no OSM building
  [byron]=15     # rural, uncertain
  [vinalhaven]=12 # small cabin
  [suttonsbay]=15 # rural, no OSM building
  [losangeles]=12 # hillside house
  [seattle]=15   # medium house
  [austin]=15    # residential
  [minneapolis]=12 # small residential
  [charleston]=15 # historic house
)

declare -A GLBS=(
  [sf]="tiles-2340-francisco-st-san-francisco-ca-94123.glb"
  [newton]="tiles-240-highland-st-newton-ma-02465.glb"
  [sanjose]="tiles-525-s-winchester-blvd-san-jose-ca-95128.glb"
  [walpole]="tiles-13-union-st-walpole-nh-03608.glb"
  [byron]="tiles-2431-72nd-st-sw-byron-center-mi-49315.glb"
  [vinalhaven]="tiles-216-zekes-point-rd-vinalhaven-me-04863.glb"
  [suttonsbay]="tiles-5835-s-bridget-rose-ln-suttons-bay-mi-49682.glb"
  [losangeles]="tiles-2607-glendower-ave-los-angeles-ca-90027.glb"
  [seattle]="tiles-4810-sw-ledroit-pl-seattle-wa-98136.glb"
  [austin]="tiles-8504-long-canyon-dr-austin-tx-78730.glb"
  [minneapolis]="tiles-2730-ulysses-st-ne-minneapolis-mn-55418.glb"
  [charleston]="tiles-41-legare-st-charleston-sc-29401.glb"
)

for key in sf newton sanjose walpole byron vinalhaven suttonsbay losangeles seattle austin minneapolis charleston; do
  crop="${CROPS[$key]}"
  glb="${GLBS[$key]}"
  echo "=== $key (crop=$crop) ==="
  $BUN $SCRIPT "$DIR/$glb" $BASE --crop "$crop" -o "$DIR/${key}-v9.schem" 2>&1 | grep -E "^(OSM|Ground|Center|Grid|Wrote|Component|Veg)" || true
  echo ""
done
echo "All done."
