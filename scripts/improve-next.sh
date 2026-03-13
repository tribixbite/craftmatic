#!/usr/bin/env bash
# Improvement loop driver — triggered by Claude Code Stop hook.
# Reads .claude/loop-state.json, spawns the next claude improvement pass.
#
# To stop the loop:  echo '{"active":false,"pass":0,"max_passes":30}' > .claude/loop-state.json
# To reset:         edit .claude/loop-state.json and set pass=0, active=true

set -euo pipefail

PROJ="/c/git/craftmatic"
STATE="$PROJ/.claude/loop-state.json"
LOG="$PROJ/.claude/loop-output.log"

# Guard: only run if state file exists
[ -f "$STATE" ] || exit 0

# Read state
ACTIVE=$(bun -e "try{const s=JSON.parse(require('fs').readFileSync('$STATE','utf8'));console.log(s.active)}catch(e){console.log('false')}" 2>/dev/null || echo "false")
[ "$ACTIVE" = "true" ] || exit 0

PASS=$(bun -e "const s=JSON.parse(require('fs').readFileSync('$STATE','utf8'));console.log(s.pass)" 2>/dev/null || echo "0")
MAX=$(bun -e "const s=JSON.parse(require('fs').readFileSync('$STATE','utf8'));console.log(s.max_passes)" 2>/dev/null || echo "30")

# Check if we've hit the limit
if [ "$PASS" -ge "$MAX" ]; then
  bun -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('$STATE','utf8'));s.active=false;fs.writeFileSync('$STATE',JSON.stringify(s,null,2))" 2>/dev/null
  echo "[loop $(date -Iseconds)] Reached max passes ($MAX). Loop complete." >> "$LOG"
  exit 0
fi

# Increment pass counter BEFORE spawning (prevents double-fire race)
NEXT=$((PASS + 1))
bun -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('$STATE','utf8'));s.pass=$NEXT;fs.writeFileSync('$STATE',JSON.stringify(s,null,2))" 2>/dev/null

echo "" >> "$LOG"
echo "========================================" >> "$LOG"
echo "[loop $(date -Iseconds)] Starting pass $NEXT/$MAX" >> "$LOG"
echo "========================================" >> "$LOG"

# Every 3rd pass = architecture review (passes 3, 6, 9, ...)
if [ $(( NEXT % 3 )) -eq 0 ]; then
  MODE="ARCHITECTURE REVIEW"
  TASK_DETAIL="This is an architecture review pass. Step back from individual improvements and:
- Analyze the overall system design and identify structural weaknesses
- Review what improvements have worked/failed so far (see improvement-log.md)
- Consider alternative algorithmic approaches (e.g., geometry sampling vs AABB, different masking strategies)
- Identify whether the current architecture is on the right path or needs a course correction
- Refactor or restructure code if it would meaningfully improve future work
- Then also implement at least one concrete improvement"
else
  MODE="IMPROVEMENT"
  TASK_DETAIL="This is a focused improvement pass. Implement the single highest-impact improvement:
- Consult the priority list in spec/lego-pipeline.md
- Check the log to avoid repeating work already tried
- Make a focused, targeted change (not a broad refactor)
- Prefer improvements that reduce block count waste, improve shape accuracy, or fix systematic errors"
fi

# Build prompt
PROMPT="You are running automated improvement pass $NEXT of $MAX for the craftmatic LEGO voxelization pipeline.

PASS TYPE: $MODE

$TASK_DETAIL

WORKFLOW (follow exactly):
1. Read spec/lego-pipeline.md      — architecture, scale conventions, known issues
2. Read spec/improvement-log.md    — history of what has been tried
3. Plan the improvement (think it through before editing)
4. Implement it (edit source files as needed)
5. Run: bun run typecheck           — MUST pass with 0 errors
6. Run: bun scripts/visual-grade.ts — note block counts and scores
7. Append a new entry to spec/improvement-log.md with:
   - Pass number, date, type
   - What was changed and why
   - Block counts before/after (compare to previous pass in log)
   - Grade scores
   - What to try next
8. Update spec/lego-pipeline.md if architecture/approach changed

HARD RULES:
- Do NOT modify scripts/visual-grade.ts
- Do NOT modify .claude/loop-state.json
- Do NOT modify scripts/improve-next.sh
- Every change must pass typecheck
- Keep spec files up to date

Current pass: $NEXT / $MAX
"

# Spawn next claude session non-interactively (runs in background, triggers next hook when done)
cd "$PROJ"
nohup claude --dangerously-skip-permissions -p "$PROMPT" >> "$LOG" 2>&1 &
CHILD_PID=$!
echo "[loop $(date -Iseconds)] Spawned pass $NEXT (PID $CHILD_PID)" >> "$LOG"
