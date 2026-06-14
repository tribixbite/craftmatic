#!/bin/bash
# Download flat-roof commercial buildings only (voxelize separately with --no-enu)
TILES_DIR="output/tiles"
BUN=~/.bun/bin/bun

# Format: "name|address|radius"
BUILDINGS=(
  "flatroof-phoenix|3300 N Central Ave, Phoenix, AZ|60"
  "flatroof-houston|2800 Post Oak Blvd, Houston, TX|60"
  "flatroof-sandiego|402 W Broadway, San Diego, CA|60"
  "flatroof-portland|1120 NW Couch St, Portland, OR|50"
  "flatroof-nashville|222 2nd Ave N, Nashville, TN|50"
  "flatroof-tampa|100 S Ashley Dr, Tampa, FL|60"
  "flatroof-raleigh|150 Fayetteville St, Raleigh, NC|50"
  "flatroof-atlanta|191 Peachtree St NE, Atlanta, GA|60"
  "flatroof-charlotte|100 N Tryon St, Charlotte, NC|60"
  "flatroof-saltlake|15 W Temple, Salt Lake City, UT|60"
)

for entry in "${BUILDINGS[@]}"; do
  IFS='|' read -r name addr radius <<< "$entry"
  glb="$TILES_DIR/${name}.glb"

  if [ -f "$glb" ]; then
    echo "SKIP: $glb already exists"
    continue
  fi

  echo "=== Downloading: $name ($addr) ==="
  $BUN scripts/tiles-headless.ts "$addr" -r "$radius" -o "$glb" -t 60 2>&1 || {
    echo "  FAILED: $name"
    continue
  }
  echo ""
done
echo "All downloads complete!"
