#!/usr/bin/env bash
# Improvement loop driver — triggered by Claude Code Stop hook.
# Reads .claude/loop-state.json, spawns the next claude improvement pass.
#
# To stop:  set "active" to false in .claude/loop-state.json
# To reset: set "pass" to 0 and "active" to true in .claude/loop-state.json

PROJ="C:/git/craftmatic"
STATE="$PROJ/.claude/loop-state.json"
LOG="$PROJ/.claude/loop-output.log"

# Guard: only run if state file exists
[ -f "$STATE" ] || exit 0

# Use node for JSON — with Windows-style paths bun/node can read them
READ_JSON="node -e \"try{const s=JSON.parse(require('fs').readFileSync('$STATE','utf8'));process.stdout.write(String(s"

ACTIVE=$(node -e "try{const s=JSON.parse(require('fs').readFileSync('$STATE','utf8'));process.stdout.write(String(s.active))}catch(e){process.stdout.write('false')}")
[ "$ACTIVE" = "true" ] || exit 0

PASS=$(node -e "const s=JSON.parse(require('fs').readFileSync('$STATE','utf8'));process.stdout.write(String(s.pass))")
MAX=$(node -e "const s=JSON.parse(require('fs').readFileSync('$STATE','utf8'));process.stdout.write(String(s.max_passes))")

# Check limit
if [ "$PASS" -ge "$MAX" ]; then
  node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('$STATE','utf8'));s.active=false;fs.writeFileSync('$STATE',JSON.stringify(s,null,2))"
  echo "[loop $(date -Iseconds)] Reached max passes ($MAX). Loop complete." >> "$LOG"
  exit 0
fi

# Increment counter BEFORE spawning
NEXT=$((PASS + 1))
node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('$STATE','utf8'));s.pass=$NEXT;fs.writeFileSync('$STATE',JSON.stringify(s,null,2))"

{
  echo ""
  echo "========================================"
  echo "[loop $(date -Iseconds)] Starting pass $NEXT/$MAX"
  echo "========================================"
} >> "$LOG"

# Every 3rd pass = architecture review
if [ $(( NEXT % 3 )) -eq 0 ]; then
  MODE="ARCHITECTURE REVIEW"
  TASK_DETAIL="This is an architecture review pass. Step back from individual improvements:
- Analyze the overall system design and identify structural weaknesses
- Review what has worked/failed so far (see improvement-log.md)
- Consider alternative algorithmic approaches (e.g. geometry sampling vs AABB, different masking)
- Determine if the current architecture is on the right path or needs course correction
- Refactor or restructure code if it would meaningfully improve future work
- Also implement at least one concrete improvement this pass"
else
  MODE="IMPROVEMENT"
  TASK_DETAIL="This is a focused improvement pass. Implement the single highest-impact improvement:
- Consult the priority list in spec/lego-pipeline.md
- Check improvement-log.md to avoid repeating work already done
- Make a focused, targeted change (not a broad refactor)
- Prefer improvements that reduce block count waste or improve shape accuracy"
fi

PROMPT="You are running automated improvement pass $NEXT of $MAX for the craftmatic LEGO voxelization pipeline (C:/git/craftmatic).

PASS TYPE: $MODE

$TASK_DETAIL

WORKFLOW (follow exactly):
1. Read spec/lego-pipeline.md      — architecture, scale conventions, known issues
2. Read spec/improvement-log.md    — history of what has been tried
3. Plan the improvement
4. Implement it (edit source files)
5. Run: bun run typecheck           — MUST pass 0 errors
6. Run: bun scripts/visual-grade.ts — note block counts and scores
7. Append a new ## Pass $NEXT entry to spec/improvement-log.md with:
   - Date, pass type
   - What was changed and why
   - Block counts before/after
   - Grade scores
   - What to try next
8. Update spec/lego-pipeline.md if architecture changed

HARD RULES:
- Do NOT modify scripts/visual-grade.ts
- Do NOT modify .claude/loop-state.json
- Do NOT modify scripts/improve-next.sh
- Every change must pass typecheck
- Keep spec files up to date

Pass $NEXT / $MAX"

cd "$PROJ"

# Write prompt to temp file (avoids shell quoting issues)
PROMPT_FILE=$(mktemp /tmp/claude-loop-prompt-XXXXXX.txt)
printf '%s' "$PROMPT" > "$PROMPT_FILE"

# Spawn run-claude-pass.sh in background (it handles CLAUDECODE unset + claude invocation)
nohup bash "$PROJ/scripts/run-claude-pass.sh" "$PROMPT_FILE" "$LOG" >> "$LOG" 2>&1 &
echo "[loop $(date -Iseconds)] Spawned pass $NEXT (PID $!)" >> "$LOG"
