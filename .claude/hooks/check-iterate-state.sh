#!/bin/bash
# Stop hook: check iterate-state.json and prompt if buildings are failing.
STATE="$CLAUDE_PROJECT_DIR/output/tiles/iterate-state.json"
MD="$CLAUDE_PROJECT_DIR/output/iterate-state.md"

if [ ! -f "$STATE" ]; then
  exit 0
fi

# Parse passing count and total from JSON
PASSING=$(grep -o '"passing": [0-9]*' "$STATE" | grep -o '[0-9]*')
TOTAL=$(grep -o '"total": [0-9]*' "$STATE" | grep -o '[0-9]*')

if [ -z "$PASSING" ] || [ -z "$TOTAL" ]; then
  exit 0
fi

TARGET=9

if [ "$PASSING" -lt "$TARGET" ]; then
  # Find lowest-scoring building
  LOWEST=$(python3 -c "
import json, sys
with open('$STATE') as f:
    d = json.load(f)
b = d.get('buildings', {})
if not b: sys.exit(0)
worst = min(b.values(), key=lambda x: x.get('trimmedMean', 0))
print(f\"{worst['key']} ({worst['trimmedMean']})\")
" 2>/dev/null || echo "unknown")

  # Find all failing keys
  FAILING=$(python3 -c "
import json
with open('$STATE') as f:
    d = json.load(f)
fails = [k for k,v in d.get('buildings',{}).items() if v.get('trimmedMean',0) < 9]
print(','.join(sorted(fails)))
" 2>/dev/null || echo "")

  echo "ITERATE: ${PASSING}/${TOTAL} buildings at 9+. Lowest: ${LOWEST}."
  echo "Run: bun scripts/iterate-grade.ts --only ${FAILING}"
  echo "State: output/iterate-state.md"
fi
