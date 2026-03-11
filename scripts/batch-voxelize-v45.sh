#!/bin/bash
# Batch voxelize v45: expanded building set + browser pipeline sync
# - Same v44 pipeline (morph close, surface smooth, facade flatten, glaze→mode order)
# - Adds 11 new headless captures beyond the original 12 landmarks
# - Includes flat-roof commercial/institutional buildings for variety

TILES_DIR="output/tiles"
BUN=~/.bun/bin/bun
VERSION="v45"

# Building name → GLB path + coordinates
declare -A GLBS COORDS

# === Original 12 landmarks (from v44) ===
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

# === New headless captures ===
GLBS[willistower]="willistower-headless.glb"
COORDS[willistower]="41.8789,-87.6359"
GLBS[gettycenter]="gettycenter-headless.glb"
COORDS[gettycenter]="34.0780,-118.4741"
GLBS[applepark]="applepark-headless.glb"
COORDS[applepark]="37.3349,-122.0090"
GLBS[rosebowl]="rosebowl-headless.glb"
COORDS[rosebowl]="34.1613,-118.1676"
GLBS[ansonia]="nyc-ansonia-headless.glb"
COORDS[ansonia]="40.7804,-73.9810"
GLBS[apthorp]="nyc-apthorp-headless.glb"
COORDS[apthorp]="40.7857,-73.9759"
GLBS[sanremo]="nyc-sanremo-headless.glb"
COORDS[sanremo]="40.7767,-73.9737"
GLBS[artinstitute]="tiles-artinstitute-headless.glb"
COORDS[artinstitute]="41.8796,-87.6237"
GLBS[chicagoloop]="chicago-loop-headless.glb"
COORDS[chicagoloop]="41.8827,-87.6233"

# === Flat-roof commercial samples ===
GLBS[flatmiami]="flatroof-miami.glb"
COORDS[flatmiami]="25.7617,-80.1918"
GLBS[flatportland]="flatroof-portland.glb"
COORDS[flatportland]="45.5152,-122.6784"

# Ordered: landmarks first, then new captures, then flat-roofs
BUILDINGS=(esb chrysler transamerica flatiron guggenheim pentagon uscapitol stpatricks mitdome geisel dakota sentinel willistower gettycenter applepark rosebowl ansonia apthorp sanremo artinstitute chicagoloop flatmiami flatportland)

# Filter by --name= argument
FILTER=""
SKIP_EXISTING=""
for arg in "$@"; do
  case "$arg" in
    --name=*) FILTER="${arg#--name=}" ;;
    --skip-existing) SKIP_EXISTING=1 ;;
  esac
done

echo "=== Batch Voxelize $VERSION (${#BUILDINGS[@]} buildings) ==="
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

  if [ -n "$SKIP_EXISTING" ] && [ -f "$schem" ]; then
    echo "SKIP: $name (already exists)"
    continue
  fi

  echo "=== $name (coords: $coords) ==="
  $BUN scripts/voxelize-glb.ts "$glb" --auto --coords "$coords" \
    -o "$(pwd)/$schem" 2>&1 | grep -v 'blob:\|THREE\.' | \
    grep -E '(Grid:|Blocks|Interior|Component|Pre-fill|Mode filter|Palette:|Wrote:|Ground|Vegetation|OSM|fill|Window glazing|Surface smooth|Facade flat|Rect crop|Skipping rect|Morph close)'
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
