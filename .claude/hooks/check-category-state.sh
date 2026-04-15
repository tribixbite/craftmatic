#!/bin/bash
# Stop hook: PERPETUAL CATEGORY ITERATION driver.
# Outputs JSON {"decision":"block","reason":"..."} to prevent Claude from stopping
# when there is work remaining. Checks stop_hook_active to prevent infinite loops.
#
# Input: JSON on stdin with stop_hook_active flag
# Output: JSON decision or nothing (allow stop)

STATE="$CLAUDE_PROJECT_DIR/output/category-state.json"
INPUT=$(cat)

# CRITICAL: If already in forced continuation, allow stopping to break the loop.
# This prevents infinite re-triggering when the agent can't make progress.
ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_hook_active', False))" 2>/dev/null)
if [ "$ACTIVE" = "True" ]; then
  exit 0
fi

# No state file — bootstrap the iteration pipeline
if [ ! -f "$STATE" ]; then
  REASON="CATEGORY-ITERATE: No state file exists. EXECUTE NOW: bun scripts/iterate-category-grade.ts --group old --runs 3 --recolor. After it completes, commit the state file and continue to the next group. DO NOT ask the user anything."
  echo "{\"decision\":\"block\",\"reason\":$(python3 -c "import json; print(json.dumps('$REASON'))" 2>/dev/null || echo "\"$REASON\"")}"
  exit 0
fi

# Parse state and decide
python3 << 'PYEOF'
import json, sys, os

state_path = os.environ.get("CLAUDE_PROJECT_DIR", ".") + "/output/category-state.json"
with open(state_path) as f:
    d = json.load(f)

locations = d.get('locations', {})
if not locations:
    out = {"decision": "block", "reason": "CATEGORY-ITERATE: Empty state. EXECUTE NOW: bun scripts/iterate-category-grade.ts --group old --runs 3 --recolor. DO NOT ask the user."}
    print(json.dumps(out))
    sys.exit(0)

version = d.get('version', '?')
target = d.get('target', 9)
passing = 0
failing = []
plateaued = []
ungraded_count = 0

for k, v in locations.items():
    grade = v.get('averageGrade')
    if not grade:
        ungraded_count += 1
        continue
    composite = grade.get('composite', 0)
    if composite >= target:
        passing += 1
    elif v.get('plateaued', False):
        plateaued.append({'key': k, 'composite': composite})
    else:
        cats = grade.get('categories', {})
        worst_cats = []
        for cat, result in cats.items():
            if result and result.get('score', 10) < target:
                worst_cats.append(f"{cat}={result['score']}")
        worst_cats.sort(key=lambda x: float(x.split('=')[1]))
        failing.append({'key': k, 'composite': composite, 'worst': worst_cats})

total = len(locations)
failing.sort(key=lambda x: x['composite'])

# Priority 1: Failing locations — block stop, force fix
if failing:
    worst = failing[0]
    worst_str = ', '.join(worst['worst'][:3]) if worst['worst'] else 'unknown'
    lines = [
        f"CATEGORY-ITERATE {version}: {passing}/{total} passing | {len(failing)} failing.",
        f"Worst: {worst['key']} at {worst['composite']}/10 — {worst_str}.",
    ]
    # Category-specific fixes
    for w in worst['worst'][:2]:
        cat, score = w.split('=')
        if cat == 'colors': lines.append(f"  colors fix: tune SV wall sampling, satellite roof, semantic palette")
        elif cat == 'features': lines.append(f"  features fix: tune window detection, cornice, facade smoothing")
        elif cat == 'layout': lines.append(f"  layout fix: tune OSM masking (dilate/osmId), footprint alignment")
        elif cat == 'dimensions': lines.append(f"  dimensions fix: tune height correction, resolution, capture radius")
        else: lines.append(f"  {cat} fix: tune scene enrichment params")

    lines.append(f"EXECUTE NOW: Analyze defects in {worst['key']}, adjust pipeline code, then re-grade: bun scripts/iterate-category-grade.ts --only {worst['key']} --runs 3 --recolor")
    lines.append("DO NOT ask the user. Just fix it and re-grade.")

    out = {"decision": "block", "reason": '\n'.join(lines)}
    print(json.dumps(out))
    sys.exit(0)

# Priority 2: Ungraded locations
if ungraded_count > 0:
    out = {"decision": "block", "reason": f"CATEGORY-ITERATE: {ungraded_count} ungraded locations. EXECUTE NOW: bun scripts/iterate-category-grade.ts --runs 3 --recolor. DO NOT ask the user."}
    print(json.dumps(out))
    sys.exit(0)

# Priority 3: All passing or only plateaued — allow stop
if plateaued:
    names = ', '.join(f"{p['key']}={p['composite']}" for p in plateaued)
    # Don't block — plateaued items need manual intervention
    # Just print info (non-JSON = no decision = allow stop)
    import sys as s
    s.stderr.write(f"CATEGORY-ITERATE: {passing}/{total} passing. Plateaued: {names}\n")

# All passing — allow stop
if passing == total and total > 0:
    import sys as s
    s.stderr.write(f"CATEGORY-ITERATE: ALL {total} LOCATIONS PASSING. Target met.\n")

# No output = allow stop
PYEOF
