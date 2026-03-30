#!/bin/bash
set -e
BUN=~/.bun/bin/bun
DIR=output/tiles

declare -A GLBS
GLBS[beach]="tiles-2130-beach-st-san-francisco-ca.glb"
GLBS[chestnut]="tiles-2001-chestnut-st-san-francisco-ca.glb"
GLBS[montgomery]="tiles-600-montgomery-st-san-francisco-ca.glb"
GLBS[noe]="tiles-450-noe-st-san-francisco-ca.glb"
GLBS[francisco]="tiles-2340-francisco-st-san-francisco-ca.glb"
GLBS[green]="tiles-2390-green-st-san-francisco-ca.glb"
GLBS[baker]="tiles-3170-baker-st-san-francisco-ca.glb"
GLBS[lyon]="tiles-3601-lyon-st-san-francisco-ca.glb"
GLBS[chrysler]="tiles-chrysler-building-new-york-ny.glb"
GLBS[esb]="tiles-empire-state-building-new-york-ny.glb"

for name in beach chestnut montgomery noe francisco green baker lyon chrysler esb; do
  glb="${DIR}/${GLBS[$name]}"
  out="${DIR}/${name}-v52f.schem"
  jpg="${DIR}/${name}-v52f-iso.jpg"
  if [ ! -f "$glb" ]; then
    echo "SKIP $name — GLB not found: $glb"
    continue
  fi
  echo "=== $name ==="
  $BUN run scripts/voxelize-glb.ts "$glb" --auto -o "$(pwd)/$out" 2>&1 | grep -E "Grid:|fill|Solidify|simpl|Roof"
  $BUN run scripts/_render-one.ts "$(pwd)/$out" "$(pwd)/$jpg" 2>&1 | tail -1
  echo
done
echo "DONE"
