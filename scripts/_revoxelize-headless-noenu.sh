#!/bin/bash
# Re-voxelize all headless captures with --no-enu (skip ENU reorientation)
# Headless GLBs from tiles-headless.ts are already ENU-oriented via ReorientationPlugin
TILES_DIR="output/tiles"
COMMON="--generic --fill --mode-passes 3 --smooth-pct 0.03 --no-enu"
BUN=~/.bun/bin/bun

for f in \
  test-newton-headless \
  tiles-dallas-headless \
  tiles-scottsdale-headless \
  tiles-dallas2-headless \
  tiles-winnetka-headless \
  tiles-cambridge-headless \
  tiles-arlington-headless \
  tiles-bellaire-headless \
  tiles-artinstitute-headless \
  flatroof-miami; do

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
echo "All headless re-voxelized with --no-enu!"
