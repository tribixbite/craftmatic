#!/usr/bin/env bash
# Re-capture all 14 benchmark buildings using tiles-headless.ts with ortho camera.
# Old GLBs were captured via browser with PerspectiveCamera at (0,8,8) which
# truncated skyscrapers at ~50m. The ortho camera from Y=500 gets full height.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/output/tiles"
BUN=~/.bun/bin/bun

# Address → GLB filename mapping (must match existing filenames for batch-v*.sh compat)
declare -A ADDRS=(
  ["tiles-sentinel-building-san-francisco-ca"]="Sentinel Building, San Francisco, CA"
  ["tiles-the-dakota-new-york-ny"]="The Dakota, 1 West 72nd St, New York, NY"
  ["tiles-st-patrick-s-cathedral-new-york-ny"]="St Patrick's Cathedral, New York, NY"
  ["tiles-empire-state-building-new-york-ny"]="Empire State Building, New York, NY"
  ["tiles-flatiron-building-new-york-ny"]="Flatiron Building, New York, NY"
  ["tiles-chrysler-building-new-york-ny"]="Chrysler Building, New York, NY"
  ["tiles-2130-beach-st-san-francisco-ca"]="2130 Beach St, San Francisco, CA"
  ["tiles-2001-chestnut-st-san-francisco-ca"]="2001 Chestnut St, San Francisco, CA"
  ["tiles-600-montgomery-st-san-francisco-ca"]="600 Montgomery St, San Francisco, CA"
  ["tiles-2340-francisco-st-san-francisco-ca"]="2340 Francisco St, San Francisco, CA"
  ["tiles-2390-green-st-san-francisco-ca"]="2390 Green St, San Francisco, CA"
  ["tiles-3601-lyon-st-san-francisco-ca"]="3601 Lyon St, San Francisco, CA"
  ["tiles-450-noe-st-san-francisco-ca"]="450 Noe St, San Francisco, CA"
  ["tiles-3170-baker-st-san-francisco-ca"]="3170 Baker St, San Francisco, CA"
)

# Radius per building — skyscrapers need wider capture, residential is compact
declare -A RADII=(
  ["tiles-sentinel-building-san-francisco-ca"]=50
  ["tiles-the-dakota-new-york-ny"]=80
  ["tiles-st-patrick-s-cathedral-new-york-ny"]=80
  ["tiles-empire-state-building-new-york-ny"]=80
  ["tiles-flatiron-building-new-york-ny"]=60
  ["tiles-chrysler-building-new-york-ny"]=80
  ["tiles-2130-beach-st-san-francisco-ca"]=50
  ["tiles-2001-chestnut-st-san-francisco-ca"]=50
  ["tiles-600-montgomery-st-san-francisco-ca"]=60
  ["tiles-2340-francisco-st-san-francisco-ca"]=50
  ["tiles-2390-green-st-san-francisco-ca"]=50
  ["tiles-3601-lyon-st-san-francisco-ca"]=60
  ["tiles-450-noe-st-san-francisco-ca"]=40
  ["tiles-3170-baker-st-san-francisco-ca"]=50
)

ORDER=(
  tiles-sentinel-building-san-francisco-ca
  tiles-the-dakota-new-york-ny
  tiles-st-patrick-s-cathedral-new-york-ny
  tiles-empire-state-building-new-york-ny
  tiles-flatiron-building-new-york-ny
  tiles-chrysler-building-new-york-ny
  tiles-2130-beach-st-san-francisco-ca
  tiles-2001-chestnut-st-san-francisco-ca
  tiles-600-montgomery-st-san-francisco-ca
  tiles-2340-francisco-st-san-francisco-ca
  tiles-2390-green-st-san-francisco-ca
  tiles-3601-lyon-st-san-francisco-ca
  tiles-450-noe-st-san-francisco-ca
  tiles-3170-baker-st-san-francisco-ca
)

for key in "${ORDER[@]}"; do
  addr="${ADDRS[$key]}"
  r="${RADII[$key]}"
  glb="$OUT/${key}.glb"
  echo "=== $key (r=${r}m) ==="
  echo "  Address: $addr"
  $BUN "$DIR/scripts/tiles-headless.ts" "$addr" -r "$r" -o "$glb" -t 180 --camera ortho 2>&1 | grep -E '(→|Meshes:|Bounding|Tiles loaded|Error|Timeout)'
  echo ""
done

echo "=== All 14 re-captured ==="
