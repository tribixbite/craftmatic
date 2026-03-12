#!/bin/bash
# v66 batch: satellite-derived roof/wall colors via --coords
set -e
BUN=~/.bun/bin/bun
DIR=output/tiles

echo "=== v66 batch voxelize ==="

# SF Residential (street camera captures)
$BUN scripts/voxelize-glb.ts $DIR/tiles-450-noe-st-san-francisco-ca.glb --auto --coords=37.7604,-122.4314 -o $DIR/noe-v66.schem 2>&1 | grep -E "Building color|Zone|Interior|Grid|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2390-green-st-san-francisco-ca.glb --auto --coords=37.7954,-122.4332 -o $DIR/green-v66.schem 2>&1 | grep -E "Building color|Zone|Interior|Grid|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2340-francisco-st-san-francisco-ca.glb --auto --coords=37.8005,-122.4382 -o $DIR/francisco-v66.schem 2>&1 | grep -E "Building color|Zone|Interior|Grid|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2130-beach-st-san-francisco-ca.glb --auto --coords=37.8031,-122.4397 -o $DIR/beach-v66.schem 2>&1 | grep -E "Building color|Zone|Interior|Grid|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2001-chestnut-st-san-francisco-ca.glb --auto --coords=37.8007,-122.4378 -o $DIR/chestnut-v66.schem 2>&1 | grep -E "Building color|Zone|Interior|Grid|Wrote"

# NYC (street camera re-capture)
$BUN scripts/voxelize-glb.ts $DIR/tiles-the-dakota-new-york-ny.glb --auto --coords=40.7766,-73.9762 -o $DIR/dakota-v66.schem 2>&1 | grep -E "Building color|Zone|Interior|Grid|Wrote"

# SF Commercial
$BUN scripts/voxelize-glb.ts $DIR/tiles-sentinel-building-san-francisco-ca.glb --auto --coords=37.7978,-122.4068 -o $DIR/sentinel-v66.schem 2>&1 | grep -E "Building color|Zone|Interior|Grid|Wrote"

echo "=== Done ==="
