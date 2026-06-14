#!/usr/bin/env bash
# Batch v55: stripped pipeline — no solidifyCore, no cornice, no facade simplification,
# no synthetic windows, no floor banding. Core: BVH surface → K-Means k=3 → modeFilter → glaze.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/output/tiles"
BUN=~/.bun/bin/bun

declare -A NAMES=(
  [sentinel]="tiles-sentinel-building-san-francisco-ca"
  [dakota]="tiles-the-dakota-new-york-ny"
  [stpatricks]="tiles-st-patrick-s-cathedral-new-york-ny"
  [esb]="tiles-empire-state-building-new-york-ny"
  [flatiron]="tiles-flatiron-building-new-york-ny"
  [chrysler]="tiles-chrysler-building-new-york-ny"
  [beach]="tiles-2130-beach-st-san-francisco-ca"
  [chestnut]="tiles-2001-chestnut-st-san-francisco-ca"
  [montgomery]="tiles-600-montgomery-st-san-francisco-ca"
  [francisco]="tiles-2340-francisco-st-san-francisco-ca"
  [green]="tiles-2390-green-st-san-francisco-ca"
  [lyon]="tiles-3601-lyon-st-san-francisco-ca"
  [noe]="tiles-450-noe-st-san-francisco-ca"
  [baker]="tiles-3170-baker-st-san-francisco-ca"
)

ORDER=(sentinel dakota stpatricks esb flatiron chrysler beach chestnut montgomery francisco green lyon noe baker)

for key in "${ORDER[@]}"; do
  glb="$OUT/${NAMES[$key]}.glb"
  schem="$OUT/${key}-v55.schem"
  echo "=== $key ==="
  $BUN "$DIR/scripts/voxelize-glb.ts" "$glb" --auto -o "$schem" 2>&1 | tail -5
  echo ""
done

echo "=== All 14 v55 done ==="

# Render all
for key in "${ORDER[@]}"; do
  schem="$OUT/${key}-v55.schem"
  jpg="$OUT/${key}-v55-iso.jpg"
  if [ -f "$schem" ]; then
    echo "Rendering $key..."
    $BUN "$DIR/scripts/_render-one.ts" "$schem" "$jpg" 2>&1 | tail -2
  fi
done

echo "=== Renders complete ==="
