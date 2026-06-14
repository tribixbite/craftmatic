#!/bin/bash
# Batch voxelize v76: tight OSM mask (dilate=1) on browser-captured GLBs
set -e

VOXCMD="bun scripts/voxelize-glb.ts"

echo "=== v76 batch: tight OSM mask (dilate=1) ==="

echo "--- 1/6: Noe ---"
$VOXCMD output/tiles/tiles-450-noe-st-san-francisco-ca.glb \
  --auto --coords 37.7510,-122.4317 --mask-dilate 1 \
  -o output/tiles/noe-v76.schem 2>&1 | grep -E "(OSM|Grid:|blocks\)|Edge|Palette)"

echo "--- 2/6: Francisco ---"
$VOXCMD output/tiles/tiles-2340-francisco-st-san-francisco-ca.glb \
  --auto --coords 37.8006,-122.4354 --mask-dilate 1 \
  -o output/tiles/francisco-v76.schem 2>&1 | grep -E "(OSM|Grid:|blocks\)|Edge|Palette)"

echo "--- 3/6: Beach ---"
$VOXCMD output/tiles/tiles-2130-beach-st-san-francisco-ca.glb \
  --auto --coords 37.8054,-122.4340 --mask-dilate 1 \
  -o output/tiles/beach-v76.schem 2>&1 | grep -E "(OSM|Grid:|blocks\)|Edge|Palette)"

echo "--- 4/6: Green ---"
$VOXCMD output/tiles/tiles-2390-green-st-san-francisco-ca.glb \
  --auto --coords 37.7967,-122.4066 --mask-dilate 1 \
  -o output/tiles/green-v76.schem 2>&1 | grep -E "(OSM|Grid:|blocks\)|Edge|Palette)"

echo "--- 5/6: Dakota ---"
$VOXCMD output/tiles/tiles-the-dakota-new-york-ny.glb \
  --auto --coords 40.7765,-73.9760 --mask-dilate 1 \
  -o output/tiles/dakota-v76.schem 2>&1 | grep -E "(OSM|Grid:|blocks\)|Edge|Palette)"

echo "--- 6/6: St Patricks ---"
$VOXCMD output/tiles/tiles-st-patrick-s-cathedral-new-york-ny.glb \
  --auto --coords 40.7585,-73.9760 --mask-dilate 1 \
  -o output/tiles/stpatricks-v76.schem 2>&1 | grep -E "(OSM|Grid:|blocks\)|Edge|Palette)"

echo "=== Done ==="
