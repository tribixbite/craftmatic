#!/bin/bash
# Re-capture all 20 buildings with fixed tiles-headless.ts (matrixWorld baked into geometry)
# Run: bash scripts/recapture-all.sh
set -e
DIR="output/tiles"

capture() {
  local name=$1 lat=$2 lng=$3 radius=$4 output=$5
  echo "=== Capturing $name (r=${radius}m) ==="
  bun scripts/tiles-headless.ts --lat=$lat --lng=$lng -r $radius --multi-angle -o "$DIR/$output" -t 120
  echo "  -> $(ls -lh "$DIR/$output" | awk '{print $5}')"
}

# Old group (10 buildings)
capture "flatiron"         40.7411  -73.9897  50  tiles-flatiron-building-new-york-ny.glb
capture "pennzoil"         29.7601  -95.3698  60  pennzoil-v200.glb
capture "nga-east"         38.8913  -77.0199  60  national-gallery-east.glb
capture "dallas-cityhall"  32.7763  -96.7968  60  dallas-cityhall.glb
capture "seattle-library"  47.6067 -122.3326  60  seattle-library.glb
capture "boston-cityhall"   42.3605  -71.0580  60  boston-cityhall.glb
capture "citigroup"        40.7585  -73.9703  50  citigroup-v200.glb
capture "geisel"           32.8811 -117.2376  50  geisel-v200.glb
capture "transamerica"     37.7952 -122.4028  60  transamerica-v200b.glb
capture "la-cityhall"      34.0537 -118.2430  60  la-cityhall.glb

# New group (10 buildings)
capture "marina-city"      41.8887  -87.6355  60  marina-city.glb
capture "hearst-tower"     40.7666  -73.9810  50  hearst-tower.glb
capture "guggenheim"       40.7830  -73.9590  50  guggenheim.glb
capture "fbi-hq"           38.8948  -77.0247  80  fbi-hq.glb
capture "mopop"            47.6215 -122.3481  60  mopop.glb
capture "natl-cathedral"   38.9306  -77.0707  80  natl-cathedral.glb
capture "boa-tower"        40.7555  -73.9848  50  boa-tower.glb
capture "tribune-tower"    41.8903  -87.6233  50  tribune-tower.glb
capture "vessel-nyc"       40.7536  -74.0022  50  vessel-nyc.glb
capture "disney-hall"      34.0553 -118.2498  60  disney-hall.glb

echo ""
echo "=== All 20 buildings re-captured ==="
