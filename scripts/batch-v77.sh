#!/bin/bash
# Batch v77: tight OSM mask + luminance contrast enforcement
set -e
V="bun scripts/voxelize-glb.ts"
R="bun scripts/_render-one.ts"
T="bun scripts/_render-topdown.ts"

echo "=== v77: contrast enforcement batch ==="

# 1. Flatiron
echo "--- 1/8: Flatiron ---"
$V output/tiles/tiles-flatiron-building-new-york-ny.glb --auto --coords 40.7411,-73.9897 --mask-dilate 1 -o output/tiles/flatiron-v77.schem 2>&1 | grep -E "(Contrast|Zone|Grid:|mask)"
$R output/tiles/flatiron-v77.schem output/tiles/flatiron-v77-iso.jpg 2>&1 | tail -1
$T output/tiles/flatiron-v77.schem output/tiles/flatiron-v77-topdown.jpg 2>&1 | tail -1

# 2. Sentinel
echo "--- 2/8: Sentinel ---"
$V output/tiles/tiles-sentinel-building-san-francisco-ca.glb --auto --coords 37.7967,-122.4066 --mask-dilate 1 -o output/tiles/sentinel-v77.schem 2>&1 | grep -E "(Contrast|Zone|Grid:|mask)"
$R output/tiles/sentinel-v77.schem output/tiles/sentinel-v77-iso.jpg 2>&1 | tail -1
$T output/tiles/sentinel-v77.schem output/tiles/sentinel-v77-topdown.jpg 2>&1 | tail -1

# 3. Noe (already done above but re-render)
echo "--- 3/8: Noe ---"
$R output/tiles/noe-v77.schem output/tiles/noe-v77-iso.jpg 2>&1 | tail -1
$T output/tiles/noe-v77.schem output/tiles/noe-v77-topdown.jpg 2>&1 | tail -1

# 4. Francisco
echo "--- 4/8: Francisco ---"
$V output/tiles/tiles-2340-francisco-st-san-francisco-ca.glb --auto --coords 37.8006,-122.4354 --mask-dilate 1 -o output/tiles/francisco-v77.schem 2>&1 | grep -E "(Contrast|Zone|Grid:|mask)"
$R output/tiles/francisco-v77.schem output/tiles/francisco-v77-iso.jpg 2>&1 | tail -1
$T output/tiles/francisco-v77.schem output/tiles/francisco-v77-topdown.jpg 2>&1 | tail -1

# 5. Beach
echo "--- 5/8: Beach ---"
$V output/tiles/tiles-2130-beach-st-san-francisco-ca.glb --auto --coords 37.8054,-122.4340 --mask-dilate 1 -o output/tiles/beach-v77.schem 2>&1 | grep -E "(Contrast|Zone|Grid:|mask)"
$R output/tiles/beach-v77.schem output/tiles/beach-v77-iso.jpg 2>&1 | tail -1
$T output/tiles/beach-v77.schem output/tiles/beach-v77-topdown.jpg 2>&1 | tail -1

# 6. Green
echo "--- 6/8: Green ---"
$V output/tiles/tiles-2390-green-st-san-francisco-ca.glb --auto --coords 37.7967,-122.4066 --mask-dilate 1 -o output/tiles/green-v77.schem 2>&1 | grep -E "(Contrast|Zone|Grid:|mask)"
$R output/tiles/green-v77.schem output/tiles/green-v77-iso.jpg 2>&1 | tail -1
$T output/tiles/green-v77.schem output/tiles/green-v77-topdown.jpg 2>&1 | tail -1

# 7. Dakota
echo "--- 7/8: Dakota ---"
$V output/tiles/tiles-the-dakota-new-york-ny.glb --auto --coords 40.7765,-73.9760 --mask-dilate 1 -o output/tiles/dakota-v77.schem 2>&1 | grep -E "(Contrast|Zone|Grid:|mask)"
$R output/tiles/dakota-v77.schem output/tiles/dakota-v77-iso.jpg 2>&1 | tail -1
$T output/tiles/dakota-v77.schem output/tiles/dakota-v77-topdown.jpg 2>&1 | tail -1

# 8. St Patricks
echo "--- 8/8: St Patricks ---"
$V output/tiles/tiles-st-patrick-s-cathedral-new-york-ny.glb --auto --coords 40.7585,-73.9760 --mask-dilate 1 -o output/tiles/stpatricks-v77.schem 2>&1 | grep -E "(Contrast|Zone|Grid:|mask)"
$R output/tiles/stpatricks-v77.schem output/tiles/stpatricks-v77-iso.jpg 2>&1 | tail -1
$T output/tiles/stpatricks-v77.schem output/tiles/stpatricks-v77-topdown.jpg 2>&1 | tail -1

echo "=== All done ==="
