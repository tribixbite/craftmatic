#!/bin/bash
# Stop hook: drives the pipeline-iteration loop.
#
# Reads output/pipeline-state.json, branches on the `status` field, and emits
# a block decision with concrete code-area prescriptions when any golden isn't
# passing. Terminal states (needs-human-review, context-insufficient) allow stop.
#
# The hook NEVER runs builds itself — build takes 1–3 minutes, hook timeout is
# 10 seconds. Instead it instructs Claude to run `bun scripts/iterate.ts --only <slug>`
# after making the suggested code fix.
#
# Loop detection: when attempts ≥ 5 AND the last 3 failure signatures are
# identical, the hook demotes status to needs-human-review (stops instructing)
# by writing back to the state file. This prevents infinite loops on problems
# Claude can't solve autonomously.

GOLDENS="$CLAUDE_PROJECT_DIR/output/goldens.json"
INPUT=$(cat)

# Harness loop guard
ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_hook_active', False))" 2>/dev/null)
if [ "$ACTIVE" = "True" ]; then
  exit 0
fi

# No goldens config? Nothing to drive.
if [ ! -f "$GOLDENS" ]; then
  exit 0
fi

python3 << 'PYEOF'
import json, sys, os

state_path   = os.environ.get("CLAUDE_PROJECT_DIR", ".") + "/output/pipeline-state.json"
goldens_path = os.environ.get("CLAUDE_PROJECT_DIR", ".") + "/output/goldens.json"

with open(goldens_path) as f:
    goldens = json.load(f).get("goldens", [])
golden_slugs = [g["slug"] for g in goldens]

state = {"addresses": {}}
if os.path.exists(state_path):
    try:
        with open(state_path) as f:
            state = json.load(f)
    except Exception:
        state = {"addresses": {}}
addresses = state.get("addresses", {})

# ── Bootstrap: any goldens missing from state? ────────────────────────────
ungraded = [s for s in golden_slugs if s not in addresses]
if ungraded:
    reason = (
        f"PIPELINE: {len(ungraded)} golden(s) not yet built: {', '.join(ungraded)}.\n"
        f"EXECUTE NOW: bun scripts/iterate.ts --bootstrap\n"
        f"DO NOT ask the user."
    )
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)

# ── Escalate stuck addresses before partitioning ──────────────────────────
ESC_ATTEMPTS = 5
ESC_SIGNATURE_REPEATS = 3
mutated = False
for slug, rec in addresses.items():
    if rec.get("status") in ("pass", "needs-human-review", "context-insufficient"):
        continue
    attempts = rec.get("attempts", 0)
    sigs = rec.get("recentFailureSignatures", [])
    if attempts >= ESC_ATTEMPTS and len(sigs) >= ESC_SIGNATURE_REPEATS:
        last_n = sigs[-ESC_SIGNATURE_REPEATS:]
        if len(set(last_n)) == 1:
            rec["status"] = "needs-human-review"
            rec["reason"] = (
                f"escalated by stop hook: {attempts} attempts, "
                f"last {ESC_SIGNATURE_REPEATS} failures signature-identical: {last_n[0]}"
            )
            mutated = True
            sys.stderr.write(
                f"PIPELINE {slug}: ESCALATED → needs-human-review "
                f"({attempts} attempts, stuck on '{last_n[0]}')\n"
            )
if mutated:
    with open(state_path, "w") as f:
        json.dump(state, f, indent=2)

# ── Partition by status ───────────────────────────────────────────────────
terminal = {"needs-human-review": [], "context-insufficient": []}
blocking = {"fail-objective": [], "fail-consensus": []}
passing = []

for slug in golden_slugs:
    rec = addresses.get(slug)
    if rec is None:
        continue
    st = rec.get("status")
    if st == "pass":
        passing.append(slug)
    elif st in terminal:
        terminal[st].append(slug)
    elif st in blocking:
        blocking[st].append(slug)

# ── Log terminal states (non-blocking) ────────────────────────────────────
for slug in terminal["needs-human-review"]:
    rec = addresses[slug]
    sys.stderr.write(
        f"PIPELINE {slug}: needs-human-review "
        f"(attempts={rec.get('attempts', 0)}, "
        f"last sigs={rec.get('recentFailureSignatures', [])[-3:]})\n"
    )
for slug in terminal["context-insufficient"]:
    sys.stderr.write(
        f"PIPELINE {slug}: context-insufficient — {addresses[slug].get('reason', 'unknown')}\n"
    )

# ── Code-area lever map ───────────────────────────────────────────────────
OBJECTIVE_LEVERS = [
    ("footprint iou",
     "src/pipeline/synthesis/parametric.ts:projectPolygonToLocal (projection), "
     "src/pipeline/synthesis/brep.ts:polygonToRing (winding), "
     "src/pipeline/synthesis/parametric.ts:synthesizeParametric (polygon → floors)"),
    ("height error",
     "src/pipeline/fusion/reconcile.ts:reconcileHeight (priority chain), "
     "src/pipeline/synthesis/parametric.ts:synthesizeParametric (levels × floorHeightM), "
     "src/pipeline/synthesis/cleaned-tiles.ts (height extrapolation)"),
    ("watertight",
     "src/pipeline/synthesis/brep.ts:evaluateBRep (CSG union logic), "
     "src/pipeline/synthesis/features.ts (window cavity depth — must stay < wall thickness)"),
    ("manifold",
     "src/pipeline/synthesis/brep.ts:evaluateBRep (shrinkPolygon + roof extrude params — likely degenerate polygon)"),
    ("self-intersect",
     "src/pipeline/synthesis/brep.ts (wall/roof overlap), "
     "src/pipeline/synthesis/features.ts (overlapping window cavities)"),
    ("min wall",
     "src/pipeline/synthesis/parametric.ts wall thicknessM (hardcoded 0.3m). "
     "Gate expects ≥0.08m at 1:100 scale — adjust wall thickness or "
     "src/pipeline/verify/objective.ts:minWallThicknessM estimator"),
    ("voxel count",
     "src/pipeline/export/voxel.ts maxDimension (default 256) — reduce resolution "
     "or cap MaxDim for very large buildings"),
    ("voxel grid empty",
     "src/pipeline/synthesis/parametric.ts (empty BRep produced) or "
     "src/pipeline/synthesis/brep.ts:evaluateBRep (CSG collapse)"),
    ("plinth not watertight",
     "src/pipeline/export/glb-print.ts:buildPlinthMesh (polygon fan triangulation)"),
]

def levers_for_objective(failures):
    hits = []
    for f in failures:
        lf = f.lower()
        for needle, lever in OBJECTIVE_LEVERS:
            if needle in lf and lever not in hits:
                hits.append(lever)
    return hits

CONSENSUS_DIM_LEVERS = {
    "color":    "src/pipeline/fusion/palette.ts (K-means), "
                "src/pipeline/capture/sv-sniff.ts (masking), "
                "src/pipeline/fusion/reconcile.ts:reconcileWallPalette + reconcileRoofPalette",
    "features": "src/pipeline/synthesis/features.ts (window grid / cornice / door), "
                "src/pipeline/fusion/reconcile.ts:reconcileWindowGrid + reconcileCornice",
    "massing":  "src/pipeline/synthesis/parametric.ts:synthesizeParametric "
                "(floor count, wall heights), "
                "src/pipeline/synthesis/brep.ts roof shape, "
                "src/pipeline/synthesis/router.ts routing decision",
    "overall":  "holistic — check all of the above",
}

# ── Priority 1: fail-objective (BLOCK) ────────────────────────────────────
if blocking["fail-objective"]:
    worst = sorted(
        blocking["fail-objective"],
        key=lambda s: (-addresses[s].get("attempts", 0), s),
    )[0]
    rec = addresses[worst]
    obj = rec.get("objective") or {}
    failures = obj.get("failures", [])
    attempts = rec.get("attempts", 0)
    iou = obj.get("footprintIoU")
    h_err = obj.get("heightErr")

    lines = [
        f"PIPELINE: {len(blocking['fail-objective'])} golden(s) fail objective gates "
        f"(worst: {worst}, {attempts} attempts).",
        f"  failures: {'; '.join(failures[:3]) if failures else 'unknown'}",
    ]
    if iou is not None:
        lines.append(f"  footprint IoU={iou:.2f}  height error={(h_err or 0)*100:.0f}%")

    levers = levers_for_objective(failures)
    if levers:
        lines.append("  Code areas to inspect:")
        for lev in levers:
            lines.append(f"    • {lev}")

    lines.append("")
    lines.append("EXECUTE NOW:")
    lines.append(f"  1. Read output/pipeline/{worst}.verification.json for full details.")
    lines.append("  2. Edit the code area(s) above to address the failure.")
    lines.append(f"  3. Rebuild: bun scripts/iterate.ts --only {worst}")
    lines.append("  4. Commit the code fix (the state file is committed separately).")
    lines.append(
        "DO NOT ask the user. If you are certain the current failure is source-data-limited "
        f"and not pipeline-fixable, say so explicitly — after {ESC_ATTEMPTS} signature-identical "
        "attempts the escalator stops the loop automatically."
    )
    print(json.dumps({"decision": "block", "reason": "\n".join(lines)}))
    sys.exit(0)

# ── Priority 2: fail-consensus (BLOCK) ────────────────────────────────────
if blocking["fail-consensus"]:
    # Split fail-consensus into two very different sub-cases:
    #   A) Consensus was RUN and failed — per-model scores exist; prescribe
    #      a dimension-targeted code fix.
    #   B) Consensus is null (VLM scoring not wired) — objective passes but
    #      the gate is structurally absent. Don't prescribe dimension fixes;
    #      tell Claude to wire scoreConsensus with real model fetchers.
    ran = [s for s in blocking["fail-consensus"] if addresses[s].get("consensus") is not None]
    unwired = [s for s in blocking["fail-consensus"] if addresses[s].get("consensus") is None]

    if ran:
        worst = sorted(ran, key=lambda s: (-addresses[s].get("attempts", 0), s))[0]
        rec = addresses[worst]
        cons = rec.get("consensus") or {}
        attempts = rec.get("attempts", 0)

        # Find worst dimension across the 3 models
        worst_dim = None
        worst_dim_val = 10
        for model_key in ("gemini", "claude", "gpt5"):
            model = cons.get(model_key, {}) or {}
            for dim, val in model.items():
                if isinstance(val, (int, float)) and val < worst_dim_val:
                    worst_dim_val = val
                    worst_dim = dim

        dim_lever = CONSENSUS_DIM_LEVERS.get(worst_dim or "overall", CONSENSUS_DIM_LEVERS["overall"])

        lines = [
            f"PIPELINE: {len(ran)} golden(s) fail VLM consensus "
            f"(worst: {worst}, {attempts} attempts).",
            f"  min={cons.get('min', '?')}  median={cons.get('median', '?')}  "
            f"spread={cons.get('spread', '?')}  rounds={cons.get('rounds', '?')}",
            f"  worst dimension: {worst_dim or 'unknown'} (score {worst_dim_val})",
            f"  Code area: {dim_lever}",
            "",
            "EXECUTE NOW:",
            f"  1. Inspect output/pipeline/{worst}.verification.json for per-model scores.",
            "  2. Improve the worst-dimension code area above.",
            f"  3. Rebuild: bun scripts/iterate.ts --only {worst}",
            "DO NOT ask the user.",
        ]
        print(json.dumps({"decision": "block", "reason": "\n".join(lines)}))
        sys.exit(0)

    if unwired:
        # Scoring not wired — prescribe wiring, not per-dimension fixes. Per-
        # dimension prescriptions are meaningless when there are no scores.
        sample = unwired[0]
        lines = [
            f"PIPELINE: {len(unwired)} golden(s) at fail-consensus with consensus=null — "
            f"VLM scoring is not wired.",
            "  Objective gates all pass; the pipeline has no subjective grading to gate on.",
            "",
            "EXECUTE NOW: wire consensus scoring before the loop can converge. Either:",
            "  a) scripts/build.ts — build a `consensus` option for runPipeline() using "
            "     real ModelScoreFn fetchers for gemini/claude/gpt5 (see "
            "     src/pipeline/verify/consensus.ts for the interface, and "
            "     src/grade/category-score.ts for an existing Gemini VLM call to adapt).",
            "  b) OR, if a single-VLM gate is acceptable for now, add a Gemini-only "
            "     consensus path with a lowered spread tolerance (`spread ≤ 99`) and stub "
            "     the other two models to the same score — so the existing pass logic works.",
            "",
            f"After wiring, rebuild one golden as a smoke test: bun scripts/iterate.ts --only {sample}",
            "",
            "Until consensus is wired, all goldens will be stuck at this state. This is the",
            "next structural step in the pipeline — not a per-building code fix.",
            "DO NOT ask the user.",
        ]
        print(json.dumps({"decision": "block", "reason": "\n".join(lines)}))
        sys.exit(0)

# ── All non-terminal addresses pass (or only terminal remain) ─────────────
if len(passing) == len(golden_slugs):
    sys.stderr.write(f"PIPELINE: all {len(golden_slugs)} goldens pass. Target met.\n")
elif passing:
    n_terminal = sum(len(v) for v in terminal.values())
    sys.stderr.write(
        f"PIPELINE: {len(passing)}/{len(golden_slugs)} passing, "
        f"{n_terminal} terminal (needs-human-review / context-insufficient). Loop stopping.\n"
    )
PYEOF
