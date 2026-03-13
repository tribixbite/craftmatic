#!/bin/bash
# Stop hook: check iterate-state.json — VLM passing, deep review status, score inflation.
STATE="$CLAUDE_PROJECT_DIR/output/tiles/iterate-state.json"

if [ ! -f "$STATE" ]; then
  exit 0
fi

# Parse state with python3
RESULT=$(python3 -c "
import json, sys
with open('$STATE') as f:
    d = json.load(f)
passing = d.get('passing', 0)
total = d.get('total', 0)
buildings = d.get('buildings', {})
last_deep = d.get('lastDeepReview', '')
version = d.get('version', '?')

if not buildings:
    sys.exit(0)

# VLM failing buildings
fails = sorted([k for k,v in buildings.items() if v.get('trimmedMean',0) < 9])
worst = min(buildings.values(), key=lambda x: x.get('trimmedMean', 0))
worst_str = f\"{worst['key']} ({worst.get('trimmedMean', 0)})\"

# Deep review stats
deep_reviewed = {k: v for k,v in buildings.items() if v.get('deepReviewMean') is not None}
deep_count = len(deep_reviewed)
deep_avg = 0
vlm_avg = 0
gap = 0
deep_passing = 0
if deep_count > 0:
    deep_avg = sum(v['deepReviewMean'] for v in deep_reviewed.values()) / deep_count
    vlm_avg = sum(v['trimmedMean'] for v in deep_reviewed.values()) / deep_count
    gap = abs(vlm_avg - deep_avg)
    deep_passing = sum(1 for v in deep_reviewed.values() if v.get('deepReviewMean', 0) >= 8)

# Sat ref warnings
bad_sat = [k for k,v in buildings.items() if v.get('satRefQuality', 5) < 3]

# Output structured result
print(f'PASSING={passing}')
print(f'TOTAL={total}')
print(f'FAILING={','.join(fails)}')
print(f'WORST={worst_str}')
print(f'DEEP_COUNT={deep_count}')
print(f'DEEP_AVG={deep_avg:.1f}')
print(f'VLM_AVG={vlm_avg:.1f}')
print(f'GAP={gap:.1f}')
print(f'DEEP_PASSING={deep_passing}')
print(f'BAD_SAT={','.join(bad_sat)}')
print(f'LAST_DEEP={last_deep}')
print(f'VERSION={version}')
" 2>/dev/null)

if [ -z "$RESULT" ]; then
  exit 0
fi

# Parse python output
eval "$RESULT"

TARGET=9

# Report sat ref issues
if [ -n "$BAD_SAT" ]; then
  echo "ITERATE: Unclear sat refs (quality <3): ${BAD_SAT}"
fi

if [ "$PASSING" -ge "$TARGET" ]; then
  # VLM target met — check deep review gate
  if [ "$DEEP_COUNT" -eq 0 ] || [ -z "$LAST_DEEP" ]; then
    echo "ITERATE: ${PASSING}/${TOTAL} VLM passing but NO deep review. Run:"
    echo "  bun scripts/iterate-grade.ts --deep-review --grade-only --version ${VERSION}"
  elif [ "$DEEP_PASSING" -ge 8 ]; then
    # Both gates passed
    echo "ITERATE: TARGET MET. ${PASSING}/${TOTAL} VLM passing, ${DEEP_PASSING}/${DEEP_COUNT} deep review passing (>=8)."
  else
    echo "ITERATE: ${PASSING}/${TOTAL} VLM passing but deep review only ${DEEP_PASSING}/${DEEP_COUNT} at 8+."
    echo "  Deep avg=${DEEP_AVG} vs VLM avg=${VLM_AVG} (gap=${GAP})"
  fi
  # Always warn on score inflation
  if [ "$DEEP_COUNT" -gt 0 ]; then
    GAP_INT=$(echo "$GAP" | cut -d. -f1)
    if [ "${GAP_INT:-0}" -gt 2 ]; then
      echo "WARNING: VLM avg ${VLM_AVG} vs deep review avg ${DEEP_AVG} (gap: ${GAP}). Scores may be inflated."
    fi
  fi
else
  echo "ITERATE: ${PASSING}/${TOTAL} buildings at 9+. Lowest: ${WORST}."
  if [ -n "$FAILING" ]; then
    echo "Run: bun scripts/iterate-grade.ts --only ${FAILING}"
  fi
  echo "State: output/iterate-state.md"
fi
