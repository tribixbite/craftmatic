#!/usr/bin/env bash
# Stop hook: check if accuracy fix tasks remain incomplete
# Reads the task list state file and prompts user to type 'go' if work remains

TASK_FILE="$CLAUDE_PROJECT_DIR/output/accuracy-tasks.md"
if [ ! -f "$TASK_FILE" ]; then
  exit 0
fi

REMAINING=$(grep -c '^\- \[ \]' "$TASK_FILE" 2>/dev/null || echo 0)
COMPLETED=$(grep -c '^\- \[x\]' "$TASK_FILE" 2>/dev/null || echo 0)
TOTAL=$((REMAINING + COMPLETED))

if [ "$REMAINING" -gt 0 ]; then
  echo "⏳ Accuracy fixes: $COMPLETED/$TOTAL phases complete, $REMAINING remaining. Type 'go' to continue." >&2
fi

exit 0
