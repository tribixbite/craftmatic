#!/bin/bash
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun

vox() {
  local glb="$1" out="$2"
  echo "=== $out ==="
  timeout 120 $BUN scripts/voxelize-glb.ts "$DIR/$glb" --auto -o "$DIR/$out" 2>&1 | grep -E "Skipping fill|Interior fill|Skipping facade|Facade flat|Grid:|Window" || true
  echo ""
}

vox "tiles-empire-state-building-new-york-ny.glb" "esb-v47c.schem"
vox "tiles-flatiron-building-new-york-ny.glb" "flatiron-v47c.schem"
vox "tiles-sentinel-building-san-francisco-ca.glb" "sentinel-v47c.schem"
vox "pentagon-headless.glb" "pentagon-v47c.schem"
vox "willistower-headless.glb" "willistower-v47c.schem"
vox "uscapitol-headless.glb" "uscapitol-v47c.schem"
vox "guggenheim-headless.glb" "guggenheim-v47c.schem"
vox "transamerica-headless.glb" "transamerica-v47c.schem"
vox "tiles-chrysler-building-new-york-ny.glb" "chrysler-v47c.schem"
vox "tiles-the-dakota-new-york-ny.glb" "dakota-v47c.schem"
vox "tiles-st-patrick-s-cathedral-new-york-ny.glb" "stpatricks-v47c.schem"
vox "tiles-2340-francisco-st-san-francisco-ca.glb" "francisco-v47c.schem"

echo "=== BATCH DONE ==="
