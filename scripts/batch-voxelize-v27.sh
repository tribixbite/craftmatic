#!/bin/bash
# Batch voxelize headless captures with OSM polygon masking for building isolation.
# v27: fixes "massive cube" issue by using --coords for OSM footprint masking,
# which isolates the target building before interior fill.
TILES_DIR="output/tiles"
# Pipeline: surface mode r=4, OSM mask isolates building, fill closes thin shell gaps
COMMON="--generic --fill --mode-passes 3 --smooth-pct 0.03 --no-enu -r 4 -m surface"

# Building coordinates for OSM polygon masking
declare -A COORDS
# Residential headless captures
COORDS[tiles-dallas-headless]="32.8512,-96.8277"
COORDS[tiles-scottsdale-headless]="33.4877,-111.926"
COORDS[tiles-dallas2-headless]="32.8220,-96.8085"
COORDS[tiles-winnetka-headless]="42.1057,-87.7325"
COORDS[tiles-cambridge-headless]="42.3766,-71.1227"
COORDS[tiles-arlington-headless]="38.8824,-77.1085"
COORDS[tiles-bellaire-headless]="29.6931,-95.4678"
COORDS[tiles-artinstitute-headless]="41.8796,-87.6237"
COORDS[test-newton-headless]="42.3435,-71.2215"
# Landmark headless captures
COORDS[geisel-headless]="32.8812,-117.2376"
COORDS[guggenheim-headless]="40.7830,-73.9590"
COORDS[mitdome-headless]="42.3594,-71.0928"
COORDS[willistower-headless]="41.8789,-87.6358"
COORDS[pentagon-headless]="38.8719,-77.0563"
COORDS[chicago-loop-headless]="41.8827,-87.6233"
COORDS[transamerica-headless]="37.7952,-122.4028"
COORDS[uscapitol-headless]="38.8899,-77.0091"
COORDS[applepark-headless]="37.3346,-122.0090"
COORDS[gettycenter-headless]="34.0781,-118.4741"
COORDS[rosebowl-headless]="34.1614,-118.1676"
COORDS[nyc-ansonia-headless]="40.7806,-73.9816"
COORDS[nyc-apthorp-headless]="40.7835,-73.9770"
COORDS[nyc-sanremo-headless]="40.7760,-73.9740"

# Filter by --name= argument
FILTER=""
FORCE=""
for arg in "$@"; do
  case "$arg" in
    --name=*) FILTER="${arg#--name=}" ;;
    --force) FORCE="1" ;;
  esac
done

for f in "${!COORDS[@]}"; do
  if [ -n "$FILTER" ] && [[ "$f" != *"$FILTER"* ]]; then
    continue
  fi

  glb="$TILES_DIR/${f}.glb"
  schem="$TILES_DIR/${f}-v27.schem"

  if [ ! -f "$glb" ]; then
    echo "SKIP: $glb not found"
    continue
  fi
  if [ -f "$schem" ] && [ -z "$FORCE" ]; then
    echo "SKIP: $schem already exists"
    continue
  fi

  coords="${COORDS[$f]}"
  echo "=== Voxelizing: $f (coords: $coords) ==="
  ~/.bun/bin/bun scripts/voxelize-glb.ts "$glb" $COMMON --coords "$coords" -o "$schem" 2>&1
  echo ""
done
echo "All done!"
