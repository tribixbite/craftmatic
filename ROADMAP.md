# Craftmatic — Roadmap & Vision

This is the strategic hand-off: where the project should go, why, and the
discipline to get there. `CLAUDE.md` covers *how the code works today*; this
covers *what to build next and why it matters*. Read both.

> **North star:** Make LEGO buildable **from anything, and into anything** —
> with a guarantee that what comes out is **physically real and buildable**.
>
> The codebase isn't a viewer with six features. It's the latent organs of one
> thing: a **universal LEGO pipeline**. Treat it that way.

---

## Guiding principles (the whole game at any time budget)

1. **Stay user-pulled, not cleverness-pushed.** The biggest risk is building a
   flawless cathedral nobody walks into. Cautionary tale from the repo's own
   history: hours went into a full LDCad snap-connectivity engine that elegantly
   *proved a negative* already answered by a single screenshot
   (`scripts/ldcad_connectivity.py` header documents this). It felt like
   progress; it was self-indulgence. Before deep work, ask: *who is pulling for
   this, and how will I know it landed?*
2. **Durability before ambition.** A legacy that bit-rots isn't one. The renderer
   has a long "hard-won — do not regress" list (see CLAUDE.md) guarded by
   **nothing**. Earn the right to build the frontier by making the basics
   unbreakable first.
3. **Verify, don't vibe.** Back claims with measurements/visuals. State limits.
   (See memory `feedback-honesty-and-rigor`.)
4. **The emotional core is why it exists:** LEGO is about making things with your
   hands and sharing them. A kid who lost their instructions. A builder who wants
   their MOC turned into shareable steps. A generation that lives in both LEGO
   and Minecraft. Every roadmap item should lower the wall between *imagining* a
   build and *holding* one.

---

## NEAR-TERM — the next ~100 hours (do these first, roughly ranked)

These make the *current, already-excellent* thing durable and actually usable.
The rendering is already box-art quality — **more material/lighting tweaks are
diminishing returns; resist them.**

> ⚠️ Several items below are inferred — **verify the current state before
> committing hours** (do tests exist? is prod healthy? does mobile work?).

1. **Protect what's built — tests & CI (~25h). [highest leverage]**
   - Golden-image **visual-regression** for ~10 reference models (headless render
     → PNG, perceptual diff) so the renderer invariants can't silently break.
   - **Unit tests for the four file loaders** with real fixtures: AES `.io`
     decrypt, `.lxf` per-part alignment math (#108), `.mpd`/MPD step counting,
     color maps. These are intricate and currently unguarded.
   - **Fix the pre-existing TS errors** in `web/src/ui/*` and gate
     `tsc --noEmit` + tests in CI. Right now the build doesn't type-gate, so one
     careless commit can undo a week of careful work.
2. **Close the user loop end-to-end (~30h).**
   - Walk the path a *non-expert* hits adversarially: land → search a set →
     auto-load → view → export. Fix the failure modes: set not in OMR, a part
     that won't resolve, confusing errors, blank-screen-while-loading.
   - Clear empty/error/loading states. The engine underneath doesn't matter if
     the on-ramp loses people.
3. **Make it work on a phone (~15h).** The owner tests from a phone, and 27M-tri
   UCS models melt mobile GPUs. Touch controls, a triangle/LOD budget for big
   sets, responsive layout. This is reach.
4. **Treat the Minecraft bridge as first-class (~15h).** It's half the project's
   identity and the genuinely *distinctive* thing. Voxel fidelity, the
   layer-by-layer build guide, schematic accuracy, export UX.
5. **Prod reliability/observability (~10h).** The `/ldraw-parts` proxy was once a
   *silent* prod gap (deployed app had no geometry, nobody knew). Add a smoke
   test that catches "prod renders nothing," basic error reporting, a deploy
   checklist.
6. **Hand-off (~5h).** README + CLAUDE.md good enough that a stranger can run,
   test, and deploy. So it outlives whoever's typing.

**If you only do one: #1.** The best gift to a project you won't maintain is the
safety net that lets the next person change it without fear.

---

## LONG-TERM — the ~10,000-hour roadmap (the platform)

Commit to **one thesis** and build toward it relentlessly. Three layers:

### Layer 1 — The core: a physically-valid model representation
Not triangles in space — **geometry + connectivity + stability**. This is where
this session's connectivity work stops being a rabbit hole and becomes the
foundation. Fuse the two existing halves into one real verifier:
- Geometry-contact audit (`web/src/viewer/ldraw/connectivity-audit.ts`).
- LDCad snap engine (`scripts/ldcad_connectivity.py`).
- → A **hybrid certifier**: does every piece connect/clutch, will it stand, is it
  buildable in a sensible order? "Everyone can render bricks; almost nobody can
  *prove a model is real*." **This verifier is the moat.**

### Layer 2 — Input: from anything
- Official files (done), **photo of a built set**, **lost instruction PDF** (the
  `reconstruct_from_pdf.py` / DBIX pipeline already gestures at this),
  a Minecraft build, and — the frontier bet — a **text/image prompt**.
- **Generative LEGO**: a model that *designs* builds, with the Layer-1 verifier
  as a **hard gate** so it can only emit builds that physically exist and
  connect. Generate freely, verify rigorously. Genuinely novel, genuinely hard,
  and a fitting thing to leave behind: not "imagine a castle," but "imagine a
  castle a child could actually build, piece by piece, that won't fall over."

### Layer 3 — Output: into anything
- Beautiful render (done) · **auto-generated step-by-step instructions** (the
  real killer app for LEGO software) · costed part list via the BrickLink BFF
  integration that's already half-wired · Minecraft · 3D-print · AR-on-the-table.
- The bridge in every direction.

### Sequencing & the discipline at scale
10,000 hours is *exactly* enough rope to build a perfect cathedral no one enters.
So:
- **Front-load validation brutally.** Get the universal pipeline + instruction
  generation into real builders' hands inside the **first ~500 hours**. Watch
  what pulls. Let *that* — not a sense of what's clever — direct the other 9,500.
- Don't skip the near-term floor; the frontier stands on it.
- Each layer ships and gets used before the next is deepened.

---

## Assets already in place (build on these, don't rebuild)
- **Universal format ingestion:** MPD/LDR, Studio `.io` (ZipCrypto **and**
  WinZip-AES), LDD `.lxf` (with per-part origin alignment), OMR, BrickLink BFF
  inventory. (`web/src/engine/*`)
- **Faithful, fast renderer:** global instancing, on-demand rendering, static
  shadows, calibrated color/lighting. (`web/src/viewer/ldraw/*`)
- **Voxelizer → Minecraft** (`.schem`/`.litematic`) + layer guide.
- **Exporters:** GLB/OBJ/STL/.schem/.litematic/CSV BOM.
- **Connectivity/physics seeds:** geometry-contact audit + complete LDCad snap
  engine + the LDCad shadow library (`C:/git/clego/ldcad`).
- **Reconstruction seeds:** `reconstruct_from_pdf.py`, DBIX/LXFML pipeline (in
  the clego reference project).

## Anti-goals (where NOT to spend the hours)
- More renderer micro-polish / material tweaks (diminishing returns; it's already
  box-art quality).
- Deeper *verification of already-answered questions* (the connectivity-floater
  question is settled: 21063 connected, 71043 no floaters).
- Any large build with no identified user pulling for it.
