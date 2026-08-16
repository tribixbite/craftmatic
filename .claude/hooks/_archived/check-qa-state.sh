#!/usr/bin/env bash
# Stop hook: check if QA tasks remain incomplete
# Outputs remaining task count to stderr so the user knows to type 'go'

STATE_FILE="$CLAUDE_PROJECT_DIR/output/qa-state.md"
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

REMAINING=$(grep -c '^\- \[ \]' "$STATE_FILE" 2>/dev/null || echo 0)
COMPLETED=$(grep -c '^\- \[x\]' "$STATE_FILE" 2>/dev/null || echo 0)
TOTAL=$((REMAINING + COMPLETED))

if [ "$REMAINING" -gt 0 ]; then
  echo "⏳ QA pipeline: $COMPLETED/$TOTAL tasks complete, $REMAINING remaining. Type 'go' to continue." >&2
fi

exit 0
