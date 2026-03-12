#!/bin/bash
# Batch v78: 3-zone contrast (dark roof + medium wall + warm ground)
set -e
V="bun scripts/voxelize-glb.ts"
R="bun scripts/_render-one.ts"
T="bun scripts/_render-topdown.ts"

echo "=== v78: 3-zone contrast batch ==="

for entry in \
  "Flatiron:tiles-flatiron-building-new-york-ny.glb:40.7411,-73.9897:flatiron" \
  "Sentinel:tiles-sentinel-building-san-francisco-ca.glb:37.7967,-122.4066:sentinel" \
  "Noe:tiles-450-noe-st-san-francisco-ca.glb:37.7510,-122.4317:noe" \
  "Francisco:tiles-2340-francisco-st-san-francisco-ca.glb:37.8006,-122.4354:francisco" \
  "Beach:tiles-2130-beach-st-san-francisco-ca.glb:37.8054,-122.4340:beach" \
  "Green:tiles-2390-green-st-san-francisco-ca.glb:37.7967,-122.4066:green" \
  "Dakota:tiles-the-dakota-new-york-ny.glb:40.7765,-73.9760:dakota" \
  "StPatricks:tiles-st-patrick-s-cathedral-new-york-ny.glb:40.7585,-73.9760:stpatricks"
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
