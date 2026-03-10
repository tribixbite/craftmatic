#!/bin/bash
# Batch voxelize all 12 tiles buildings — v11
# Key changes: PCA horizontal alignment, rectangular crop (now works with aligned buildings),
# no fill, moderate smoothing, 1 mode-pass.
set -e
BUN=~/.bun/bin/bun
DIR=/data/data/com.termux/files/home/git/craftmatic/output/tiles
SCRIPT=/data/data/com.termux/files/home/git/craftmatic/scripts/voxelize-glb.ts
# With PCA alignment, rectangular crop no longer creates triangle artifacts.
# Crop isolates the building from surrounding terrain/neighbors.
BASE="-m surface -r 1 --generic --mode-passes 1 --smooth-pct 0.02"

# Per-building crop radii — must fit the building within the aligned grid.
# Larger than v10 since alignment changes effective dimensions.
declare -A CROPS=(
  [sf]=18        # Row of buildings, needs wider crop
  [newton]=15    # House + yard
  [sanjose]=18   # Commercial strip
  [walpole]=18   # Rural, wide lot
  [byron]=18     # Rural, wide lot
  [vinalhaven]=16 # Small cabin + surroundings
  [suttonsbay]=15 # Rural house
  [losangeles]=15 # Hillside house
  [seattle]=18   # House + yard
  [austin]=18    # Residential lot
  [minneapolis]=15 # Small residential
  [charleston]=18 # Historic house + grounds
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
  $BUN $SCRIPT "$DIR/$glb" $BASE --crop "$crop" -o "$DIR/${key}-v11.schem" 2>&1 | grep -E "^(ENU|PCA|Grid|Voxel|Trim|Ground|Rect|Component|Wrote|Smooth|Mode)" || true
  echo ""
done
echo "All done."
