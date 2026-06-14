#!/bin/bash
# Batch voxelize all headless captures
TILES_DIR="output/tiles"
COMMON="--generic --fill --mode-passes 3 --smooth-pct 0.03 --no-enu"

for f in \
  tiles-dallas-headless \
  tiles-scottsdale-headless \
  tiles-dallas2-headless \
  tiles-winnetka-headless \
  tiles-cambridge-headless \
  tiles-arlington-headless \
  tiles-bellaire-headless \
  test-newton-headless; do
  
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
  ~/.bun/bin/bun scripts/voxelize-glb.ts "$glb" -r 4 -m surface $COMMON -o "$schem" 2>&1
  echo ""
done
echo "All done!"
