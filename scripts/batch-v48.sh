#!/bin/bash
set -e
DIR="output/tiles"
BUN=~/.bun/bin/bun

vox() {
  local glb="$1" out="$2"
  echo "=== $out ==="
  timeout 120 $BUN scripts/voxelize-glb.ts "$DIR/$glb" --auto -o "$DIR/$out" 2>&1 | grep -E "Skipping fill|Interior fill|Shell healing|Palette consolidation|Mode filter|Window" || true
  echo ""
}

vox "tiles-empire-state-building-new-york-ny.glb" "esb-v48.schem"
vox "tiles-flatiron-building-new-york-ny.glb" "flatiron-v48.schem"
vox "tiles-sentinel-building-san-francisco-ca.glb" "sentinel-v48.schem"
vox "pentagon-headless.glb" "pentagon-v48.schem"
vox "willistower-headless.glb" "willistower-v48.schem"
vox "uscapitol-headless.glb" "uscapitol-v48.schem"
vox "guggenheim-headless.glb" "guggenheim-v48.schem"
vox "transamerica-headless.glb" "transamerica-v48.schem"
vox "tiles-chrysler-building-new-york-ny.glb" "chrysler-v48.schem"
vox "tiles-the-dakota-new-york-ny.glb" "dakota-v48.schem"

echo "=== BATCH DONE ==="
