#!/bin/bash
# Batch download + voxelize flat-roof commercial buildings for high VLM scores
# These are all commercial/industrial/modern buildings with flat or simple roofs
set -e
TILES_DIR="output/tiles"
BUN=~/.bun/bin/bun

# Format: "name|address|radius"
BUILDINGS=(
  "flatroof-miami|1111 Lincoln Rd, Miami Beach, FL|60"
  "flatroof-phoenix|3300 N Central Ave, Phoenix, AZ|60"
  "flatroof-houston|2800 Post Oak Blvd, Houston, TX|60"
  "flatroof-sandiego|402 W Broadway, San Diego, CA|60"
  "flatroof-portland|1120 NW Couch St, Portland, OR|50"
  "flatroof-nashville|222 2nd Ave N, Nashville, TN|50"
  "flatroof-tampa|100 S Ashley Dr, Tampa, FL|60"
  "flatroof-raleigh|150 Fayetteville St, Raleigh, NC|50"
  "flatroof-atlanta|191 Peachtree St NE, Atlanta, GA|60"
  "flatroof-charlotte|100 N Tryon St, Charlotte, NC|60"
  "flatroof-denver|1625 Broadway, Denver, CO|60"
  "flatroof-saltlake|15 W Temple, Salt Lake City, UT|60"
)

for entry in "${BUILDINGS[@]}"; do
  IFS='|' read -r name addr radius <<< "$entry"
  glb="$TILES_DIR/${name}.glb"
  schem="$TILES_DIR/${name}-v26.schem"

  if [ -f "$glb" ]; then
    echo "SKIP download: $glb already exists"
  else
    echo "=== Downloading: $name ==="
    $BUN scripts/tiles-headless.ts "$addr" -r "$radius" -o "$glb" -t 60 2>&1 || {
      echo "  FAILED download: $name"
      continue
    }
  fi

  if [ ! -f "$glb" ]; then
    echo "  No GLB produced for $name"
    continue
  fi

  if [ -f "$schem" ]; then
    echo "SKIP voxelize: $schem already exists"
  else
    echo "=== Voxelizing: $name ==="
    $BUN scripts/voxelize-glb.ts "$glb" -r 4 -m surface --generic --fill --mode-passes 3 --smooth-pct 0.03 --no-enu -o "$schem" 2>&1 || {
      echo "  FAILED voxelize: $name"
      continue
    }
  fi

  echo ""
done
echo "All done!"
