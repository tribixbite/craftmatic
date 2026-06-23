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

## NEAR-TERM — status as of 2026-06-23 (most of the original floor is built)

The original near-term list (tests/CI, user loop, MC bridge, prod reliability,
hand-off) is **largely DONE** — see the strikethroughs. The rendering is box-art
quality; **resist more material/lighting tweaks.** What actually remains:

1. ~~**Protect what's built — tests & CI.**~~ ✅ **DONE.** Offline, deterministic
   test net for every loader + the voxelizer + schem round-trip + LSynth + lxf
   alignment math (`test/*.test.ts`, ~1031 tests); CI gates `typecheck` +
   `typecheck:web` (whole `web/` tree type-clean) + tests + build. Golden-image
   visual regression was de-risked into **geometry-level regression**
   (`ldraw-geometry.test.ts`) — GPU-free, guards the same invariants. *True
   pixel golden-image is still absent* (low priority; headless-WebGL-in-CI is
   flaky — only revisit if a shading regression slips through).
2. ~~**Close the user loop.**~~ ✅ Largely done: relevance search ranking,
   source-quality gating (DBIX skip / vision "approximate" / incomplete-model
   note), clear error/empty states (adversarial walkthrough passed),
   layer/step slider, honest `.lxf` caveat.
3. **Mobile LOD budget — the one near-term item still open (~10h).** The mobile
   *profile* exists (pixel-ratio cap, 1024² shadows, SAO off, preserveDrawingBuffer
   off). What's missing: a **triangle/LOD budget** so a 27M-tri UCS Falcon/ISD
   doesn't melt a phone GPU (skip stud interiors / sub-pixel primitives, or a
   distance LOD). The owner tests on a phone → real pull. **Highest near-term
   priority now.**
4. ~~**Minecraft bridge first-class.**~~ ✅ Strong: voxel fidelity **validated
   across 20 varied large sets** (export→import round-trips perfect through both
   importers; 0 unmapped colours; primitive-leak bug fixed); STL/OBJ at real mm
   scale; layer-by-layer build guide exposed; `.schem`/`.litematic` validated.
   Remaining polish: a UI control for the Accurate-vs-Cubic scale tradeoff is
   present but tall models (Eiffel 384 in Accurate) could auto-suggest Cubic.
5. ~~**Prod reliability/observability.**~~ ✅ `prod-smoke.yml` runs post-deploy +
   daily, catching "deployed app renders nothing" (the historic `/ldraw-parts`
   gap). Deploy is FF-to-main; CI-mirror clean-tree check before each push.
6. ~~**Hand-off.**~~ ✅ CLAUDE.md is comprehensive + current.

**Next, in order:** (a) mobile LOD budget [#3]; (b) begin the **Layer-1
verifier** (below) — the actual moat; (c) **instruction generation** (Layer 3,
the killer app). Connectivity tools exist but are **dev-only** (`window.__ldrawViewer.auditConnectivity`)
— surfacing + fusing them into the hybrid certifier is the bridge from
near-term to the long-term thesis.

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
