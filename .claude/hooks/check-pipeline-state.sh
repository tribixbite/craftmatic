#!/bin/bash
# Stop hook: reads output/pipeline-state.json, branches on the `status` field.
#
# Terminal states first — so reordering the rules can't break the loop:
#   1. stop_hook_active (harness guard)
#   2. needs-human-review (VLM consensus exhausted)
#   3. context-insufficient (no usable footprint data)
#   4. fail-objective (rebuild — blocking)
#   5. fail-consensus (improve polish — blocking)
#   6. pass (silent)

STATE="$CLAUDE_PROJECT_DIR/output/pipeline-state.json"
INPUT=$(cat)

ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_hook_active', False))" 2>/dev/null)
if [ "$ACTIVE" = "True" ]; then
  exit 0
fi

if [ ! -f "$STATE" ]; then
  # No state yet — nothing to check, allow stop.
  exit 0
fi

python3 << 'PYEOF'
import json, sys, os

state_path = os.environ.get("CLAUDE_PROJECT_DIR", ".") + "/output/pipeline-state.json"
with open(state_path) as f:
    d = json.load(f)

addresses = d.get('addresses', {})
if not addresses:
    sys.exit(0)

# Partition by status (terminal first)
terminal = {'needs-human-review': [], 'context-insufficient': []}
blocking = {'fail-objective': [], 'fail-consensus': []}
passing = []

for slug, rec in addresses.items():
    status = rec.get('status')
    if status == 'pass':
        passing.append(slug)
    elif status in terminal:
        terminal[status].append(slug)
    elif status in blocking:
        blocking[status].append(slug)

# 2. needs-human-review — log to stderr, allow stop
for slug in terminal['needs-human-review']:
    rec = addresses[slug]
    cons = rec.get('consensus', {}) or {}
    sys.stderr.write(
        f"PIPELINE {slug}: needs-human-review "
        f"min={cons.get('min', '?')} median={cons.get('median', '?')} "
        f"spread={cons.get('spread', '?')} after {cons.get('rounds', '?')} rounds\n"
    )

# 3. context-insufficient — log to stderr, allow stop
for slug in terminal['context-insufficient']:
    reason = addresses[slug].get('reason', 'unknown')
    sys.stderr.write(f"PIPELINE {slug}: context-insufficient — {reason}\n")

# 4. fail-objective — BLOCK
if blocking['fail-objective']:
    worst = blocking['fail-objective'][0]
    rec = addresses[worst]
    objective = rec.get('objective', {}) or {}
    failures = objective.get('failures', [])
    failure_str = ', '.join(failures[:3]) if failures else 'unknown'
    reason = (
        f"PIPELINE: {len(blocking['fail-objective'])} address(es) fail objective gates.\n"
        f"EXECUTE NOW: fix {worst} — {failure_str}. "
        f"Rebuild via `bun scripts/build.ts \"<address>\" --out output/pipeline`.\n"
        f"DO NOT ask the user."
    )
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)

# 5. fail-consensus — BLOCK
if blocking['fail-consensus']:
    worst = blocking['fail-consensus'][0]
    rec = addresses[worst]
    cons = rec.get('consensus', {}) or {}
    min_score = cons.get('min', '?')
    reason = (
        f"PIPELINE: {len(blocking['fail-consensus'])} address(es) fail consensus.\n"
        f"EXECUTE NOW: improve {worst} — consensus min={min_score}.\n"
        f"DO NOT ask the user."
    )
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)

# 6. All pass — silent
if passing and not blocking['fail-objective'] and not blocking['fail-consensus']:
    if not terminal['needs-human-review'] and not terminal['context-insufficient']:
        # fully passing — silent
        pass
    # else: terminal states were already logged above
PYEOF
