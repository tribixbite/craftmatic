#!/bin/bash
# Stop hook: Verify scene pipeline completion — no stubs, shortcuts, or placeholders.
# Checks all Phase 2-5 new files for completeness and ensures typecheck passes.

DIR="$CLAUDE_PROJECT_DIR/src/convert"
FAILURES=0

echo "SCENE PIPELINE COMPLETION CHECK:"

# 1. Check all required new files exist and are non-empty
REQUIRED_FILES=(
  "$DIR/voxel-classifier.ts"
  "$DIR/class-block-map.ts"
  "$DIR/multi-angle-capture.ts"
  "$DIR/scene-enrichment.ts"
  "$DIR/osm-infrastructure.ts"
  "$DIR/environment-builder.ts"
  "$DIR/geo-projection.ts"
  "$DIR/scene-pipeline.ts"
)

for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -s "$f" ]; then
    echo "  MISSING: $f"
    FAILURES=$((FAILURES + 1))
  fi
done

# 2. Check for stubs/placeholders/shortcuts in new files
STUB_PATTERNS='TODO|FIXME|STUB|PLACEHOLDER|NOT_IMPLEMENTED|throw.*not.*implement|\.\.\.;$|pass$'
for f in "${REQUIRED_FILES[@]}"; do
  if [ -s "$f" ]; then
    stubs=$(grep -nE "$STUB_PATTERNS" "$f" 2>/dev/null | grep -v '// TODO:' | head -5)
    if [ -n "$stubs" ]; then
      echo "  STUBS in $(basename "$f"):"
      echo "$stubs" | sed 's/^/    /'
      FAILURES=$((FAILURES + 1))
    fi
  fi
done

# 3. Check key exports exist in each module
check_export() {
  local file="$1"
  local pattern="$2"
  local desc="$3"
  if [ -s "$file" ] && ! grep -q "$pattern" "$file"; then
    echo "  MISSING EXPORT: $desc in $(basename "$file")"
    FAILURES=$((FAILURES + 1))
  fi
}

check_export "$DIR/voxel-classifier.ts" "export enum VoxelClass" "VoxelClass enum"
check_export "$DIR/voxel-classifier.ts" "export function classifyGrid" "classifyGrid()"
check_export "$DIR/voxel-classifier.ts" "export function writeWithPriority" "writeWithPriority()"
check_export "$DIR/class-block-map.ts" "export function resolveBlock" "resolveBlock()"
check_export "$DIR/geo-projection.ts" "export class GeoProjection" "GeoProjection class"
check_export "$DIR/osm-infrastructure.ts" "export async function queryPlotInfrastructure" "queryPlotInfrastructure()"
check_export "$DIR/scene-enrichment.ts" "export async function enrichForScene" "enrichForScene()"
check_export "$DIR/scene-pipeline.ts" "export async function enrichScene" "enrichScene()"

# 4. Summary
if [ $FAILURES -eq 0 ]; then
  echo "  All ${#REQUIRED_FILES[@]} scene pipeline files present and complete."

  # 5. Check if grading has been done
  GRADE_STATE="$CLAUDE_PROJECT_DIR/output/tiles/scene-grade-state.json"
  if [ -f "$GRADE_STATE" ]; then
    python3 << 'PYEOF'
import json, os
state_path = os.environ.get("CLAUDE_PROJECT_DIR", ".") + "/output/tiles/scene-grade-state.json"
with open(state_path) as f:
    d = json.load(f)
buildings = d.get('buildings', {})
passing = sum(1 for v in buildings.values() if v.get('score', 0) >= 8)
total = len(buildings)
if total > 0:
    avg = sum(v.get('score', 0) for v in buildings.values()) / total
    print(f"  SCENE GRADING: {passing}/{total} at 8/10+ (avg {avg:.1f})")
    if passing < total:
        failing = [k for k, v in buildings.items() if v.get('score', 0) < 8]
        print(f"  ACTION: Improve failing scenes: {', '.join(failing)}")
else:
    print("  SCENE GRADING: No results yet. Run scene grading.")
PYEOF
  else
    echo "  SCENE GRADING: Not started yet. Run scene grading after pipeline complete."
  fi
else
  echo "  $FAILURES ISSUES FOUND — fix before proceeding."
fi
