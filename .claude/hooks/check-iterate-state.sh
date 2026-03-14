#!/bin/bash
# Stop hook: PERPETUAL ITERATION driver.
# Always outputs a concrete next action. Never silent when improvements possible.
STATE="$CLAUDE_PROJECT_DIR/output/tiles/iterate-state.json"

if [ ! -f "$STATE" ]; then
  echo "ITERATE: No state file. Run: bun scripts/iterate-grade.ts --version v95 --runs 6"
  exit 0
fi

python3 << 'PYEOF'
import json, sys, os

state_path = os.environ.get("CLAUDE_PROJECT_DIR", ".") + "/output/tiles/iterate-state.json"
with open(state_path) as f:
    d = json.load(f)

buildings = d.get('buildings', {})
if not buildings:
    print("ITERATE: Empty state. Run: bun scripts/iterate-grade.ts --version v95 --runs 6")
    sys.exit(0)

version = d.get('version', '?')
passing = d.get('passing', 0)
total = d.get('total', 0)

# Classify all buildings
failing = []
borderline = []  # passing but < 9.5
solid = []       # >= 9.5
low_runs = []    # < 12 runs (need more data)

for k, v in buildings.items():
    tm = v.get('trimmedMean', 0)
    runs = len(v.get('scores', []))
    ss = v.get('subscores', [])
    n = len(ss) if ss else 1
    avgA = sum(s.get('A',0) for s in ss) / n if ss else 0
    avgB = sum(s.get('B',0) for s in ss) / n if ss else 0
    avgC = sum(s.get('C',0) for s in ss) / n if ss else 0
    scores = v.get('scores', [])
    rng = max(scores) - min(scores) if scores else 0
    diag = v.get('diagnosis', '')
    info = {'key': k, 'tm': tm, 'A': avgA, 'B': avgB, 'C': avgC, 'runs': runs, 'range': rng, 'diag': diag}

    if tm < 9:
        failing.append(info)
    elif tm < 9.5:
        borderline.append(info)
    else:
        solid.append(info)
    if runs < 12:
        low_runs.append(info)

# Sort by priority
failing.sort(key=lambda x: x['tm'])
borderline.sort(key=lambda x: x['tm'])
low_runs.sort(key=lambda x: x['runs'])

# Status line
print(f"ITERATE {version}: {passing}/{total} passing | {len(failing)} fail | {len(borderline)} borderline | {len(solid)} solid")

# Priority 1: Fix failing buildings
if failing:
    worst = failing[0]
    names = ','.join(f['key'] for f in failing)
    print(f"\nFAILING ({len(failing)}): {names}")
    for f in failing:
        print(f"  {f['key']}: {f['tm']} (A={f['A']:.1f} B={f['B']:.1f} C={f['C']:.1f}, {f['runs']} runs, range={f['range']}) — {f['diag']}")

    # Specific fix suggestions
    for f in failing:
        fixes = []
        if f['A'] < 3: fixes.append("footprint: try --no-osm, different dilate, or 2x res")
        if f['B'] < 2.5: fixes.append("massing: check capture completeness, mode-passes")
        if f['C'] < 2.5: fixes.append("surface: reduce homogenize, check color pipeline")
        if f['range'] >= 4: fixes.append("high-variance: accumulate 12+ runs, check sat ref")
        if fixes:
            print(f"  → {f['key']} fixes: {'; '.join(fixes)}")

    print(f"\nACTION: Fix worst failing building ({worst['key']} at {worst['tm']}), then re-grade.")
    sys.exit(0)

# Priority 2: Stabilize borderline buildings (9.0-9.4) with more runs
if borderline:
    unstable = [b for b in borderline if b['runs'] < 12 or b['range'] >= 4]
    if unstable:
        names = ','.join(b['key'] for b in unstable)
        print(f"\nBORDERLINE UNSTABLE ({len(unstable)}): {names}")
        for b in unstable:
            print(f"  {b['key']}: {b['tm']} ({b['runs']} runs, range={b['range']}) — needs confirmation")
        print(f"\nACTION: Accumulate runs on borderline buildings: bun scripts/iterate-grade.ts --version {version} --runs 6 --only {names} --merge-scores")
        sys.exit(0)

    # Borderline but stable — try to improve them
    names = ','.join(b['key'] for b in borderline)
    weakest = borderline[0]
    print(f"\nBORDERLINE STABLE ({len(borderline)}): {names}")
    for b in borderline:
        weak_dim = 'A' if b['A'] == min(b['A'], b['B'], b['C']) else ('B' if b['B'] == min(b['A'], b['B'], b['C']) else 'C')
        print(f"  {b['key']}: {b['tm']} (A={b['A']:.1f} B={b['B']:.1f} C={b['C']:.1f}) — weakest: {weak_dim}")
    print(f"\nACTION: Improve weakest borderline ({weakest['key']} at {weakest['tm']}). Analyze composite, tweak pipeline params, re-voxelize and grade.")
    sys.exit(0)

# Priority 3: Low-run buildings need more data
if low_runs:
    names = ','.join(b['key'] for b in low_runs)
    print(f"\nLOW DATA ({len(low_runs)}): {names} — need 12+ runs for stable trimmed mean")
    print(f"\nACTION: Accumulate runs: bun scripts/iterate-grade.ts --version {version} --runs 6 --only {names} --merge-scores")
    sys.exit(0)

# Priority 4: All solid — deep review or visual quality pass
high_var = [s for s in solid + borderline if s['range'] >= 4]
if high_var:
    names = ','.join(h['key'] for h in high_var)
    print(f"\nHIGH VARIANCE ({len(high_var)}): {names} — scores range >=4, VLM inconsistent")
    print(f"ACTION: Investigate sat ref quality and composite framing for: {names}")
    sys.exit(0)

# All buildings solid and stable
avg_tm = sum(v.get('trimmedMean', 0) for v in buildings.values()) / len(buildings)
print(f"\nALL {total} BUILDINGS SOLID — avg trimmedMean={avg_tm:.1f}")
print("No failing or borderline buildings. Pipeline is stable.")
print(f"ACTION: Run deep review for honest assessment: bun scripts/iterate-grade.ts --version {version} --deep-review --runs 0 --deep-runs 3")
PYEOF
