#!/bin/bash
# Stop hook: PERPETUAL ITERATION driver.
# Always outputs a next action — never silent. Drives indefinite improvement.
STATE="$CLAUDE_PROJECT_DIR/output/tiles/iterate-state.json"

if [ ! -f "$STATE" ]; then
  echo "ITERATE: No state file. Start with: bun scripts/iterate-grade.ts --version v92 --runs 5"
  exit 0
fi

python3 << PYEOF
import json, sys

with open("$STATE") as f:
    d = json.load(f)

buildings = d.get('buildings', {})
if not buildings:
    print("ITERATE: Empty state. Run: bun scripts/iterate-grade.ts --version v92 --runs 5")
    sys.exit(0)

version = d.get('version', '?')
passing = d.get('passing', 0)
total = d.get('total', 0)
last_deep = d.get('lastDeepReview', '')

# Classify failing buildings
failing = {}
for k, v in buildings.items():
    tm = v.get('trimmedMean', 0)
    if tm < 9:
        ss = v.get('subscores', [])
        n = len(ss) if ss else 1
        avgA = sum(s.get('A',0) for s in ss) / n if ss else 0
        avgB = sum(s.get('B',0) for s in ss) / n if ss else 0
        avgC = sum(s.get('C',0) for s in ss) / n if ss else 0
        dr = v.get('deepReviewMean')
        sat = v.get('satRefQuality', 5)
        diag = v.get('diagnosis', '')
        failing[k] = {'tm': tm, 'A': avgA, 'B': avgB, 'C': avgC, 'dr': dr, 'sat': sat, 'diag': diag}

# Deep review stats
deep_reviewed = {k: v for k,v in buildings.items() if v.get('deepReviewMean') is not None}
deep_count = len(deep_reviewed)
deep_avg = sum(v['deepReviewMean'] for v in deep_reviewed.values()) / deep_count if deep_count else 0
vlm_avg = sum(v['trimmedMean'] for v in deep_reviewed.values()) / deep_count if deep_count else 0
deep_passing = sum(1 for v in deep_reviewed.values() if v.get('deepReviewMean', 0) >= 8)

# Bad sat refs
bad_sat = sorted([k for k,v in buildings.items() if v.get('satRefQuality', 5) < 3])

# Build prioritized action list
actions = []

if bad_sat:
    actions.append(f"P0: Replace unclear sat refs: {','.join(bad_sat)}")

if failing:
    ranked = sorted(failing.items(), key=lambda x: x[1]['tm'])
    surface_bad = [k for k,v in ranked if v['C'] < 2]
    footprint_bad = [k for k,v in ranked if v['A'] < 3]
    massing_bad = [k for k,v in ranked if v['B'] < 2]
    near_pass = [(k,v['tm']) for k,v in ranked if v['tm'] >= 7]

    if surface_bad:
        actions.append(f"P1: Fix surface noise [{','.join(surface_bad)}] — more modeFilter passes, stronger homogenization")
    if footprint_bad:
        actions.append(f"P2: Fix footprint [{','.join(footprint_bad)}] — tighter OSM mask, 2x res")
    if massing_bad:
        actions.append(f"P3: Fix massing [{','.join(massing_bad)}] — check capture height")
    if near_pass:
        near_str = ', '.join(f'{k}({v})' for k,v in near_pass)
        actions.append(f"P4: Near-passing [{near_str}] — fine-tune")

actions.append(f"P5: Re-grade: bun scripts/iterate-grade.ts --grade-only --version {version} --runs 5")

if not last_deep or (deep_count > 0 and deep_avg < 6):
    actions.append(f"P6: Deep review: bun scripts/iterate-grade.ts --grade-only --deep-review --version {version} --runs 0 --deep-runs 3")

# Output
deep_str = f"deep avg {deep_avg:.1f} ({deep_passing}/{deep_count} at 8+)" if deep_count else "no deep review"
print(f"ITERATE: {passing}/{total} VLM passing | {deep_str} | {len(failing)} failing")
if failing:
    worst3 = sorted(failing.items(), key=lambda x: x[1]['tm'])[:3]
    for k, v in worst3:
        dr_str = f" deep={v['dr']}" if v['dr'] is not None else ""
        print(f"  {k}: vlm={v['tm']} A={v['A']:.1f} B={v['B']:.1f} C={v['C']:.1f}{dr_str} — {v['diag']}")
print("NEXT ACTIONS:")
for a in actions:
    print(f"  {a}")
PYEOF
