#!/bin/bash
# Batch voxelize flat-roof commercial buildings (already downloaded)
# Uses --no-enu since headless GLBs are pre-oriented via ReorientationPlugin
TILES_DIR="output/tiles"
COMMON="--generic --fill --mode-passes 3 --smooth-pct 0.03 --no-enu"
BUN=~/.bun/bin/bun

for f in \
  flatroof-miami \
  flatroof-phoenix \
  flatroof-houston \
  flatroof-sandiego \
  flatroof-portland \
  flatroof-nashville \
  flatroof-tampa \
  flatroof-raleigh \
  flatroof-atlanta \
  flatroof-charlotte; do

  glb="$TILES_DIR/${f}.glb"
  schem="$TILES_DIR/${f}-v26.schem"

  if [ ! -f "$glb" ]; then
    echo "SKIP: $glb not found"
    continue
  fi
  if [ -f "$schem" ]; then
    echo "SKIP: $schem already exists"
    continue
  fi

  echo "=== Voxelizing: $f ==="
  $BUN scripts/voxelize-glb.ts "$glb" -r 4 -m surface $COMMON -o "$schem" 2>&1
  echo ""
done
echo "All flat-roof buildings voxelized!"
