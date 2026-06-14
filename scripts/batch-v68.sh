#!/bin/bash
# v68 batch: 1 block per foot (3.28 blocks/m) — high-res multi-zone facade
set -e
BUN=~/.bun/bin/bun
DIR=output/tiles
RES=3.28

echo "=== v68 batch voxelize (${RES} blocks/m = 1 block/ft) ==="

# SF Residential
$BUN scripts/voxelize-glb.ts $DIR/tiles-450-noe-st-san-francisco-ca.glb --auto --coords=37.7604,-122.4314 -r $RES -o $DIR/noe-v68.schem 2>&1 | grep -E "Grid estimate|Zones|Zone facade|Grid:|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2390-green-st-san-francisco-ca.glb --auto --coords=37.7954,-122.4332 -r $RES -o $DIR/green-v68.schem 2>&1 | grep -E "Grid estimate|Zones|Zone facade|Grid:|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2340-francisco-st-san-francisco-ca.glb --auto --coords=37.8005,-122.4382 -r $RES -o $DIR/francisco-v68.schem 2>&1 | grep -E "Grid estimate|Zones|Zone facade|Grid:|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2130-beach-st-san-francisco-ca.glb --auto --coords=37.8031,-122.4397 -r $RES -o $DIR/beach-v68.schem 2>&1 | grep -E "Grid estimate|Zones|Zone facade|Grid:|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2001-chestnut-st-san-francisco-ca.glb --auto --coords=37.8007,-122.4378 -r $RES -o $DIR/chestnut-v68.schem 2>&1 | grep -E "Grid estimate|Zones|Zone facade|Grid:|Wrote"

# NYC
$BUN scripts/voxelize-glb.ts $DIR/tiles-the-dakota-new-york-ny.glb --auto --coords=40.7766,-73.9762 -r $RES -o $DIR/dakota-v68.schem 2>&1 | grep -E "Grid estimate|Zones|Zone facade|Grid:|Wrote"

# SF Commercial
$BUN scripts/voxelize-glb.ts $DIR/tiles-sentinel-building-san-francisco-ca.glb --auto --coords=37.7978,-122.4068 -r $RES -o $DIR/sentinel-v68.schem 2>&1 | grep -E "Grid estimate|Zones|Zone facade|Grid:|Wrote"

echo "=== Done ==="
