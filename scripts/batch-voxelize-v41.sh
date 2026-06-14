#!/bin/bash
# Batch voxelize v41: dark window preservation + thicker shell + expanded palette
# - OSM footprint mask runs BEFORE fillInteriorGaps (prevents solid core samples)
# - Non-generic pipeline: ground → OSM mask → component(500) → fill → veg strip
# - All v36 fixes carried forward (no dark materials, no rectify, no smooth)

TILES_DIR="output/tiles"
BUN=~/.bun/bin/bun
VERSION="v41"

# Building name → GLB path + coordinates
declare -A GLBS COORDS
GLBS[esb]="tiles-empire-state-building-new-york-ny.glb"
COORDS[esb]="40.7484,-73.9856"
GLBS[chrysler]="tiles-chrysler-building-new-york-ny.glb"
COORDS[chrysler]="40.7516,-73.9755"
GLBS[transamerica]="transamerica-headless.glb"
COORDS[transamerica]="37.7952,-122.4028"
GLBS[flatiron]="tiles-flatiron-building-new-york-ny.glb"
COORDS[flatiron]="40.7411,-73.9897"
GLBS[guggenheim]="guggenheim-headless.glb"
COORDS[guggenheim]="40.7830,-73.9590"
GLBS[pentagon]="pentagon-headless.glb"
COORDS[pentagon]="38.8719,-77.0563"
GLBS[uscapitol]="uscapitol-headless.glb"
COORDS[uscapitol]="38.8899,-77.0091"
GLBS[stpatricks]="tiles-st-patrick-s-cathedral-new-york-ny.glb"
COORDS[stpatricks]="40.7585,-73.9760"
GLBS[mitdome]="mitdome-headless.glb"
COORDS[mitdome]="42.3594,-71.0928"
GLBS[geisel]="geisel-headless.glb"
COORDS[geisel]="32.8812,-117.2376"
GLBS[dakota]="tiles-the-dakota-new-york-ny.glb"
COORDS[dakota]="40.7764,-73.9762"
GLBS[sentinel]="tiles-sentinel-building-san-francisco-ca.glb"
COORDS[sentinel]="37.7858,-122.4063"

# Ordered list for consistent output
BUILDINGS=(esb chrysler transamerica flatiron guggenheim pentagon uscapitol stpatricks mitdome geisel dakota sentinel)

# Filter by --name= argument
FILTER=""
for arg in "$@"; do
  case "$arg" in
    --name=*) FILTER="${arg#--name=}" ;;
  esac
done

echo "=== Batch Voxelize $VERSION ==="
echo ""

for name in "${BUILDINGS[@]}"; do
  if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]]; then
    continue
  fi

  glb="$TILES_DIR/${GLBS[$name]}"
  schem="$TILES_DIR/${name}-${VERSION}.schem"
  coords="${COORDS[$name]}"

  if [ ! -f "$glb" ]; then
    echo "SKIP: $glb not found"
    continue
  fi

  echo "=== $name (coords: $coords) ==="
  $BUN scripts/voxelize-glb.ts "$glb" --auto --coords "$coords" \
    -o "$(pwd)/$schem" 2>&1 | grep -v 'blob:\|THREE\.' | \
    grep -E '(Grid:|Blocks|Interior|Component|Pre-fill|Mode filter|Palette:|Wrote:|Ground|Vegetation|OSM|fill|Window glazing)'
  echo ""
done

echo "=== Summary ==="
for name in "${BUILDINGS[@]}"; do
  schem="$TILES_DIR/${name}-${VERSION}.schem"
  if [ -f "$schem" ]; then
    size=$(stat -c%s "$schem" 2>/dev/null || stat -f%z "$schem" 2>/dev/null)
    echo "$name: $(( size / 1024 ))KB"
  fi
done
echo "All done!"
