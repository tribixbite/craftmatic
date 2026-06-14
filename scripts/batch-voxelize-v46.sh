#!/bin/bash
# Batch voxelize v46: 2D connected-component clearOpenAirFill + frequency-based window detection
# Run: bash scripts/batch-voxelize-v46.sh [--skip-existing]
set -euo pipefail

SKIP_EXISTING=false
[[ "${1:-}" == "--skip-existing" ]] && SKIP_EXISTING=true

BUN=~/.bun/bin/bun
SCRIPT=scripts/voxelize-glb.ts
OUT=output/tiles

voxelize() {
  local glb="$1" name="$2"
  local out="$OUT/${name}-v46.schem"
  if $SKIP_EXISTING && [[ -f "$out" ]]; then
    echo "SKIP: $name (exists)"
    return
  fi
  echo "=== $name ==="
  $BUN $SCRIPT "$glb" --auto -o "$(pwd)/$out" 2>&1 | grep -E '(Grid:|Palette:|Window|open-air|Error|error)' || true
  echo ""
}

# Landmarks (12)
voxelize "$OUT/tiles-empire-state-building-new-york-ny.glb"    esb
voxelize "$OUT/tiles-chrysler-building-new-york-ny.glb"        chrysler
voxelize "$OUT/tiles-flatiron-building-new-york-ny.glb"        flatiron
voxelize "$OUT/tiles-sentinel-building-san-francisco-ca.glb"   sentinel
voxelize "$OUT/tiles-the-dakota-new-york-ny.glb"               dakota
voxelize "$OUT/tiles-st-patrick-s-cathedral-new-york-ny.glb"   stpatricks
voxelize "$OUT/willistower-headless.glb"                       willistower
voxelize "$OUT/pentagon-headless.glb"                          pentagon
voxelize "$OUT/rosebowl-headless.glb"                          rosebowl
voxelize "$OUT/gettycenter-headless.glb"                       gettycenter
voxelize "$OUT/guggenheim-headless.glb"                        guggenheim
voxelize "$OUT/uscapitol-headless.glb"                         uscapitol

# Headless captures (11)
voxelize "$OUT/applepark-headless.glb"                         applepark
voxelize "$OUT/nyc-ansonia-headless.glb"                       ansonia
voxelize "$OUT/nyc-apthorp-headless.glb"                       apthorp
voxelize "$OUT/nyc-sanremo-headless.glb"                       sanremo
voxelize "$OUT/chicago-loop-headless.glb"                      chicagoloop
voxelize "$OUT/transamerica-headless.glb"                      transamerica
voxelize "$OUT/geisel-headless.glb"                            geisel
voxelize "$OUT/mitdome-headless.glb"                           mitdome

# Residential (5)
voxelize "$OUT/tiles-2340-francisco-st-san-francisco-ca.glb"   francisco
voxelize "$OUT/tiles-450-noe-st-san-francisco-ca.glb"          noe
voxelize "$OUT/tiles-525-s-winchester-blvd-san-jose-ca-95128.glb" winchester

echo "=== Batch v46 complete ==="
