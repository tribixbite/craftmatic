#!/bin/bash
# Stop hook: PERPETUAL CATEGORY ITERATION driver.
# Outputs IMPERATIVE directives — agent MUST execute, NEVER ask for confirmation.
# Reads output/category-state.json and forces the agent to keep iterating.
STATE="$CLAUDE_PROJECT_DIR/output/category-state.json"

if [ ! -f "$STATE" ]; then
  echo "CATEGORY-ITERATE: No state file exists yet. You MUST execute the following command NOW without asking the user anything:"
  echo "EXECUTE: bun scripts/iterate-category-grade.ts --group old --runs 3 --recolor"
  echo "After it completes, commit the state file and continue to the next group."
  echo "DO NOT ask the user for permission or confirmation. Just do it."
  exit 0
fi

python3 << 'PYEOF'
import json, sys, os

state_path = os.environ.get("CLAUDE_PROJECT_DIR", ".") + "/output/category-state.json"
with open(state_path) as f:
    d = json.load(f)

locations = d.get('locations', {})
if not locations:
    print("CATEGORY-ITERATE: Empty state. You MUST execute NOW without asking:")
    print("EXECUTE: bun scripts/iterate-category-grade.ts --group old --runs 3 --recolor")
    print("DO NOT ask the user anything. Just run it.")
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
        plateaued.append({'key': k, 'composite': composite, 'worst': v.get('worstCategories', [])})
    else:
        cats = grade.get('categories', {})
        worst_cats = []
        for cat, result in cats.items():
            if result and result.get('score', 10) < target:
                worst_cats.append(f"{cat}={result['score']}")
        worst_cats.sort(key=lambda x: float(x.split('=')[1]))
        failing.append({'key': k, 'composite': composite, 'worst': worst_cats, 'defects': grade.get('defects', {})})

total = len(locations)
failing.sort(key=lambda x: x['composite'])

print(f"CATEGORY-ITERATE {version}: {passing}/{total} passing (target {target}) | {len(failing)} fail | {len(plateaued)} plateau")

# Priority 1: Fix failing locations
if failing:
    worst = failing[0]
    print(f"\nFAILING ({len(failing)}):")
    for f in failing:
        worst_str = ', '.join(f['worst'][:4]) if f['worst'] else 'unknown'
        print(f"  {f['key']}: {f['composite']}/10 — worst: {worst_str}")

        for w in f['worst'][:2]:
            cat, score = w.split('=')
            score = float(score)
            if cat == 'colors' and score < target:
                print(f"    → colors: tune SV wall sampling, satellite roof sampling, semantic palette resolution")
            elif cat == 'features' and score < target:
                print(f"    → features: tune window detection, cornice preservation, facade smoothing params")
            elif cat == 'layout' and score < target:
                print(f"    → layout: tune OSM masking (dilate, osmId), footprint alignment, crop radius")
            elif cat == 'dimensions' and score < target:
                print(f"    → dimensions: tune height correction, resolution, capture radius")
            elif cat in ('walking_paths', 'pavement', 'vegetation') and score < target:
                print(f"    → {cat}: tune scene enrichment params, environment placement")

    print(f"\nYou MUST fix the worst location ({worst['key']} at {worst['composite']}/10) NOW. Do NOT ask the user.")
    print(f"1. Analyze the defects and adjust pipeline params in the source code")
    print(f"2. Re-voxelize and re-grade: bun scripts/iterate-category-grade.ts --only {worst['key']} --runs 3 --recolor")
    print(f"3. Commit the changes and updated state file")
    print(f"EXECUTE NOW. Do not ask for confirmation.")
    sys.exit(0)

# Priority 2: Ungraded locations
if ungraded_count > 0:
    print(f"\nUNGRADED: {ungraded_count} locations still need grading.")
    print(f"You MUST grade them NOW: bun scripts/iterate-category-grade.ts --runs 3 --recolor")
    print(f"DO NOT ask the user. Just execute it.")
    sys.exit(0)

# Priority 3: Plateaued locations
if plateaued:
    names = ', '.join(f"{p['key']}={p['composite']}" for p in plateaued)
    print(f"\nPLATEAU ({len(plateaued)}): {names}")
    print("These are limited by source data. Requires GLB recapture or manual intervention.")

# All passing
if passing == total:
    avg = sum(v.get('averageGrade', {}).get('composite', 0) for v in locations.values()) / total if total > 0 else 0
    print(f"\nALL {total} LOCATIONS PASSING — avg composite={avg:.1f}/10")
    print("Category iteration complete. Target met. You may stop.")
else:
    print(f"\n{passing}/{total} passing. Only plateaued items remain.")
    print("Plateaued items need manual intervention (GLB recapture). You may stop or investigate.")
PYEOF
