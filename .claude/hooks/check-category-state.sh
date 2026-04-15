#!/bin/bash
# Stop hook: PERPETUAL CATEGORY ITERATION driver.
# Always outputs a concrete next action. Never silent when improvements possible.
# Reads output/category-state.json and directs the agent to keep iterating.
STATE="$CLAUDE_PROJECT_DIR/output/category-state.json"

if [ ! -f "$STATE" ]; then
  echo "CATEGORY-ITERATE: No state file. Run: bun scripts/iterate-category-grade.ts --group old --runs 3 --recolor"
  exit 0
fi

python3 << 'PYEOF'
import json, sys, os

state_path = os.environ.get("CLAUDE_PROJECT_DIR", ".") + "/output/category-state.json"
with open(state_path) as f:
    d = json.load(f)

locations = d.get('locations', {})
if not locations:
    print("CATEGORY-ITERATE: Empty state. Run: bun scripts/iterate-category-grade.ts --group old --runs 3 --recolor")
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
        # Find worst individual category
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

        # Category-specific fix suggestions
        for w in f['worst'][:2]:
            cat, score = w.split('=')
            score = float(score)
            if cat == 'colors' and score < target:
                print(f"    → colors fix: tune SV wall sampling, satellite roof sampling, semantic palette resolution")
            elif cat == 'features' and score < target:
                print(f"    → features fix: tune window detection, cornice preservation, facade smoothing params")
            elif cat == 'layout' and score < target:
                print(f"    → layout fix: tune OSM masking (dilate, osmId), footprint alignment, crop radius")
            elif cat == 'dimensions' and score < target:
                print(f"    → dimensions fix: tune height correction, resolution, capture radius")
            elif cat in ('walking_paths', 'pavement', 'vegetation') and score < target:
                print(f"    → {cat} fix: tune scene enrichment params, environment placement")

    print(f"\nACTION: Fix worst location ({worst['key']} at {worst['composite']}/10). Analyze defects, adjust pipeline params, re-voxelize and re-grade:")
    print(f"  bun scripts/iterate-category-grade.ts --only {worst['key']} --runs 3 --recolor")
    sys.exit(0)

# Priority 2: Ungraded locations
if ungraded_count > 0:
    print(f"\nUNGRADED: {ungraded_count} locations need initial grading")
    print(f"\nACTION: Grade ungraded locations: bun scripts/iterate-category-grade.ts --runs 3 --recolor")
    sys.exit(0)

# Priority 3: Plateaued locations — report but don't block
if plateaued:
    names = ', '.join(f"{p['key']}={p['composite']}" for p in plateaued)
    print(f"\nPLATEAU ({len(plateaued)}): {names}")
    print("These are limited by source data (Google 3D Tiles LOD/geometry). Requires GLB recapture or manual intervention.")

# All passing
if passing == total:
    avg = sum(v.get('averageGrade', {}).get('composite', 0) for v in locations.values()) / total if total > 0 else 0
    print(f"\nALL {total} LOCATIONS PASSING — avg composite={avg:.1f}/10")
    print("Category iteration pipeline complete. No further action needed.")
else:
    print(f"\n{passing}/{total} passing. Only plateaued buildings remain — investigate source data quality.")
PYEOF
