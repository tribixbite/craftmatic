#!/bin/bash
# Batch v78b: Additional buildings to replace Dakota/StPatricks
set -e
V="bun scripts/voxelize-glb.ts"
R="bun scripts/_render-one.ts"
T="bun scripts/_render-topdown.ts"

echo "=== v78b: replacement candidates ==="

for entry in \
  "Charleston:tiles-41-legare-st-charleston-sc-29401.glb:32.7714,-79.9326:charleston" \
  "Newton:tiles-240-highland-st-newton-ma-02465.glb:42.3289,-71.2106:newton" \
  "Seattle:tiles-4810-sw-ledroit-pl-seattle-wa-98136.glb:47.5415,-122.3850:seattle" \
  "Baker:tiles-3170-baker-st-san-francisco-ca.glb:37.7930,-122.4430:baker" \
  "Chestnut:tiles-2001-chestnut-st-san-francisco-ca.glb:37.8003,-122.4337:chestnut"
do
  IFS=: read -r name glb coords slug <<< "$entry"
  echo "--- $name ---"
  $V "output/tiles/$glb" --auto --coords "$coords" --mask-dilate 1 \
    -o "output/tiles/${slug}-v78.schem" 2>&1 | grep -E "(Roof darken|Wall contrast|Zone |Grid:|mask)"
  $R "output/tiles/${slug}-v78.schem" "output/tiles/${slug}-v78-iso.jpg" 2>&1 | tail -1
  $T "output/tiles/${slug}-v78.schem" "output/tiles/${slug}-v78-topdown.jpg" 2>&1 | tail -1
  echo
done

echo "=== Done ==="
