#!/bin/bash
# v65 batch: zone-aware facade simplification, density-adaptive dilation, morphClose r=3
set -e
BUN=~/.bun/bin/bun
DIR=output/tiles

echo "=== v65 batch voxelize ==="

# SF Residential (street camera captures)
$BUN scripts/voxelize-glb.ts $DIR/tiles-450-noe-st-san-francisco-ca.glb --auto -o $DIR/noe-v65.schem 2>&1 | grep -E "Zone|Interior|Grid|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2390-green-st-san-francisco-ca.glb --auto -o $DIR/green-v65.schem 2>&1 | grep -E "Zone|Interior|Grid|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2340-francisco-st-san-francisco-ca.glb --auto -o $DIR/francisco-v65.schem 2>&1 | grep -E "Zone|Interior|Grid|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2130-beach-st-san-francisco-ca.glb --auto -o $DIR/beach-v65.schem 2>&1 | grep -E "Zone|Interior|Grid|Wrote"
$BUN scripts/voxelize-glb.ts $DIR/tiles-2001-chestnut-st-san-francisco-ca.glb --auto -o $DIR/chestnut-v65.schem 2>&1 | grep -E "Zone|Interior|Grid|Wrote"

# NYC (street camera re-captures)
$BUN scripts/voxelize-glb.ts $DIR/tiles-the-dakota-new-york-ny.glb --auto -o $DIR/dakota-v65.schem 2>&1 | grep -E "Zone|Interior|Grid|Wrote"

# SF Sentinel (street camera re-capture)
$BUN scripts/voxelize-glb.ts $DIR/tiles-sentinel-building-san-francisco-ca.glb --auto -o $DIR/sentinel-v65.schem 2>&1 | grep -E "Zone|Interior|Grid|Wrote"

echo "=== Done ==="
