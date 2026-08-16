#!/data/data/com.termux/files/usr/bin/bash
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
# Escalation (see ESCALATION below) demotes hopeless slugs to needs-human-review
# so the loop can't spin forever, and AUTO-CLEARS that demotion once the pipeline
# code changes — an escalation is a statement about the code as it was, not a
# life sentence.
#
# Shebang is the absolute Termux bash: Claude Code strips LD_PRELOAD when
# spawning hooks, so `#!/usr/bin/env bash` and `#!/bin/bash` fail to resolve
# ("No such file or directory") if this script is ever executed directly
# rather than through the `bash <script>` form in settings.json.

GOLDENS="$CLAUDE_PROJECT_DIR/output/goldens.json"
INPUT=$(cat)

if ! command -v python3 > /dev/null 2>&1; then
  echo "check-pipeline-state: python3 not found — pipeline loop hook disabled" >&2
  exit 0
fi

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
import json, sys, os, subprocess

project_dir  = os.environ.get("CLAUDE_PROJECT_DIR", ".")
state_path   = project_dir + "/output/pipeline-state.json"
goldens_path = project_dir + "/output/goldens.json"

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


def current_commit():
    """HEAD sha, or None when git is unavailable. Used to expire escalations."""
    try:
        out = subprocess.run(
            ["git", "-C", project_dir, "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def write_state():
    """Persist state under the same mkdir-lock + atomic-rename protocol
    scripts/build.ts uses. Without the lock a concurrent build's
    read-modify-write silently drops whatever the hook just wrote (and
    vice versa) — that race cost several days of state history before it
    was fixed on the build side."""
    lock_dir = state_path + ".lock"
    import time
    deadline = time.time() + 5  # hook budget is 10s; never spend it all here
    have_lock = False
    while time.time() < deadline:
        try:
            os.mkdir(lock_dir)
            have_lock = True
            break
        except FileExistsError:
            try:
                if time.time() - os.stat(lock_dir).st_mtime > 30:
                    os.rmdir(lock_dir)
                    continue
            except OSError:
                pass
            time.sleep(0.15)
    try:
        tmp = "%s.tmp-hook-%d" % (state_path, os.getpid())
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, state_path)
    finally:
        if have_lock:
            try:
                os.rmdir(lock_dir)
            except OSError:
                pass


def block(reason):
    """Emit a Stop-hook block decision and exit.

    `{"decision":"block","reason":...}` on stdout with exit 0 is the form this
    installation honours (it is what drove the loop for 50+ attempts). The
    one-line stderr summary is belt-and-braces: if a future version stops
    reading that field, the signal still reaches the transcript instead of
    the loop going silently dead."""
    first = reason.split("\n", 1)[0]
    sys.stderr.write(first + "\n")
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


def derive_status(rec):
    """Re-derive a record's real status from its stored gate results —
    mirrors composeReport() in src/pipeline/verify/report.ts."""
    obj = rec.get("objective")
    if obj is not None and not obj.get("pass", False):
        return "fail-objective"
    cons = rec.get("consensus")
    if cons is None or not cons.get("pass", False):
        return "fail-consensus"
    return "pass"


# ── Bootstrap: any goldens missing from state? ────────────────────────────
ungraded = [s for s in golden_slugs if s not in addresses]
if ungraded:
    block(
        f"PIPELINE: {len(ungraded)} golden(s) not yet built: {', '.join(ungraded)}.\n"
        f"EXECUTE NOW: bun scripts/iterate.ts --bootstrap\n"
        f"DO NOT ask the user."
    )

# ── ESCALATION ────────────────────────────────────────────────────────────
# Two escalation triggers:
#   (a) identical signatures — Claude has made no progress on the failure mode.
#   (b) high attempt ceiling — `attempts` counts CONSECUTIVE runs with the same
#       failure signature (build.ts resets it when the signature changes), so
#       reaching the ceiling means genuinely repeated identical failures.
# Escalation is scoped to goldens: non-golden records (…-qa, one-off addresses)
# aren't driven by this loop and must not be mutated by it.
ESC_ATTEMPTS_IDENTICAL = 5
ESC_SIGNATURE_REPEATS = 3
ESC_ATTEMPTS_HARD = 10
ESC_PREFIX = "escalated by stop hook: "

head = current_commit()
mutated = False

# ── De-escalation: an escalation describes the code AS IT WAS. Once the
# pipeline code moves, that verdict is stale — restore the record's real
# status so the loop can try again. Without this the loop is a one-way
# ratchet: escalate → hook stops instructing rebuilds → never rebuilt →
# escalated forever. That is exactly how every golden ended up terminal.
for slug in golden_slugs:
    rec = addresses.get(slug)
    if rec is None or rec.get("status") != "needs-human-review":
        continue
    if not str(rec.get("reason", "")).startswith(ESC_PREFIX):
        continue  # human-set review state — never auto-clear
    at = rec.get("escalatedAtCommit")
    if head is not None and at == head:
        continue  # code unchanged since escalation — verdict still stands
    restored = derive_status(rec)
    prior_attempts = rec.get("attempts", 0)
    rec["status"] = restored
    rec["reason"] = (
        f"de-escalated by stop hook: pipeline code changed since escalation "
        f"({'unknown→' + head[:8] if at is None else at[:8] + '→' + head[:8]})"
        if head else "de-escalated by stop hook: escalation expired"
    )
    rec.pop("escalatedAtCommit", None)
    # Reset the attempt tally and signature history with the escalation.
    # `attempts` counts consecutive same-signature failures UNDER THE CURRENT
    # CODE; carrying a pre-change tally forward re-trips the hard ceiling on
    # the very next hook run, which silently re-escalates the record and
    # reinstates the one-way ratchet this de-escalation exists to break.
    rec["attempts"] = 0
    rec["recentFailureSignatures"] = []
    mutated = True
    sys.stderr.write(
        f"PIPELINE {slug}: de-escalated → {restored} "
        f"(code changed since escalation; attempts {prior_attempts}→0)\n"
    )

for slug in golden_slugs:
    rec = addresses.get(slug)
    if rec is None:
        continue
    if rec.get("status") in ("pass", "needs-human-review", "context-insufficient"):
        continue
    attempts = rec.get("attempts", 0)
    sigs = rec.get("recentFailureSignatures", [])

    escalate_reason = None
    if attempts >= ESC_ATTEMPTS_IDENTICAL and len(sigs) >= ESC_SIGNATURE_REPEATS:
        last_n = sigs[-ESC_SIGNATURE_REPEATS:]
        if len(set(last_n)) == 1:
            escalate_reason = (
                f"{attempts} attempts, last {ESC_SIGNATURE_REPEATS} failures "
                f"signature-identical: {last_n[0]}"
            )
    if escalate_reason is None and attempts >= ESC_ATTEMPTS_HARD:
        escalate_reason = (
            f"{attempts} consecutive same-signature attempts exceeded hard ceiling "
            f"{ESC_ATTEMPTS_HARD} — likely at MVP plateau (recent sigs: {sigs[-3:]})"
        )

    if escalate_reason:
        rec["status"] = "needs-human-review"
        rec["reason"] = ESC_PREFIX + escalate_reason
        if head:
            rec["escalatedAtCommit"] = head
        mutated = True
        sys.stderr.write(f"PIPELINE {slug}: ESCALATED → needs-human-review ({escalate_reason})\n")

if mutated:
    write_state()

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
        f"last sigs={rec.get('recentFailureSignatures', [])[-3:]}). "
        f"Clears automatically on the next commit.\n"
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
     "src/pipeline/synthesis/sliced-tiles.ts (OSM masking / band anchoring). "
     "NOTE: a sudden IoU collapse with low provenance confidence usually means "
     "an OSM Overpass outage degraded the context — check prov_mean before editing code"),
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
    ("palette",
     "src/gen/color-blocks.ts WALL_CLUSTERS / roof maps, "
     "src/blocks/known-blocks.ts (registry the gate validates against)"),
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
    "color":    "src/gen/color-blocks.ts WALL_CLUSTERS (cluster colours must match "
                "how textures RENDER, not catalog names), "
                "src/pipeline/export/photogrammetry-recolor.ts (per-face segmentation), "
                "src/pipeline/fusion/reconcile.ts:reconcileWallPalette + reconcileRoofPalette",
    "features": "src/pipeline/export/voxel.ts:applyMaterialOverlay (window/cornice/plinth "
                "overlay — the dominant fenestration signal), "
                "src/pipeline/synthesis/features.ts (BRep window grid), "
                "src/pipeline/fusion/reconcile.ts:reconcileWindowGrid + reconcileCornice",
    "massing":  "src/pipeline/synthesis/parametric.ts:synthesizeParametric "
                "(floor count, wall heights), "
                "src/pipeline/synthesis/brep.ts:buildRoofShape (ridge orientation), "
                "src/pipeline/synthesis/router.ts routing decision. "
                "NOTE: check output/polygon-overrides.json first — a wrong footprint "
                "override reads as a massing failure but is a DATA fix",
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
    prov = (rec.get("provenance") or {}).get("meanConfidence")

    lines = [
        f"PIPELINE: {len(blocking['fail-objective'])} golden(s) fail objective gates "
        f"(worst: {worst}, {attempts} attempts).",
        f"  failures: {'; '.join(failures[:3]) if failures else 'unknown'}",
    ]
    if iou is not None:
        lines.append(f"  footprint IoU={iou:.2f}  height error={(h_err or 0)*100:.0f}%")
    if prov is not None and prov < 0.6:
        lines.append(
            f"  provenance meanConfidence={prov:.2f} — LOW. The context feeding this "
            f"build was degraded (likely an OSM/Overpass outage). Re-run the build "
            f"before changing any code."
        )

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
        f"and not pipeline-fixable, say so explicitly — after {ESC_ATTEMPTS_IDENTICAL} "
        "signature-identical attempts the escalator stops the loop automatically."
    )
    block("\n".join(lines))

# ── Priority 2: fail-consensus (BLOCK) ────────────────────────────────────
if blocking["fail-consensus"]:
    # Two very different sub-cases:
    #   A) Consensus RAN and scored low — prescribe a dimension-targeted fix.
    #   B) consensus is null — the scorer never ran for this build (no VLM
    #      credential in the build's environment). Rebuilding reproduces the
    #      identical report, so this must NOT block: it is the exact loop that
    #      burned 282 rebuilds across the goldens. Report it and allow stop.
    #      scripts/iterate-ranking.ts:isBlockedOnConsensus encodes the same rule.
    ran = [s for s in blocking["fail-consensus"] if addresses[s].get("consensus") is not None]
    unwired = [s for s in blocking["fail-consensus"] if addresses[s].get("consensus") is None]

    if ran:
        worst = sorted(ran, key=lambda s: (-addresses[s].get("attempts", 0), s))[0]
        rec = addresses[worst]
        cons = rec.get("consensus") or {}
        attempts = rec.get("attempts", 0)

        # Worst dimension across the 3 model slots
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
        block("\n".join(lines))

    if unwired:
        sys.stderr.write(
            f"PIPELINE: {len(unwired)} golden(s) at fail-consensus with consensus=null "
            f"({', '.join(unwired)}) — the VLM scorer did not run for those builds.\n"
            f"  Objective gates pass; rebuilding without a VLM credential in the "
            f"environment reproduces the identical report, so the loop does not block "
            f"on these. Ensure GEMINI_API_KEY is exported, then: "
            f"bun scripts/iterate.ts --only {unwired[0]}\n"
        )

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
