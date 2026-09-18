# Craftmatic — Project Guide

Minecraft schematic toolkit **and** an LDraw (LEGO) 3D viewer, web UI in `web/`
(Vite + TypeScript + Three.js). This guide and the linked topic docs are the version-controlled source of
truth for architecture + hard-won conventions. Keep it current; do not keep
durable project knowledge only in private/agent memory.

## Topic guides — read when relevant

Load the relevant guide before working on its pipeline. Keep detailed findings
and conventions there; keep this file as the short project entry point.

- **PDF reconstruction:** [pipeline guide](docs/pdf-pipeline-guide.md) — PDF-only input, zero runtime VLM, extraction/placement experiments, accuracy limits, and test harnesses.
- **Minecraft exports:** [pipeline guide](docs/minecraft-pipeline-guide.md) — shared export worker, voxelization, resolution, palettes, schematic/litematic and Bedrock structures.
- **Bedrock playable add-ons:** [add-on guide](docs/bedrock-addon-guide.md) — entity geometry, vehicle controls/cameras, pack constraints, and Pixel QA.
- **LEGO/LDraw rendering:** [renderer guide](docs/lego-renderer-guide.md) — architecture, imports, rendering, colors, mesh metadata, contact checks, and download UI.
- **LEGO models and parts:** [source guide](docs/lego-sources-guide.md) — dev/prod libraries, source-quality gates, index schema, offline data, and source freshness.
- **Testing:** [testing guide](docs/testing-guide.md) — offline suites, manual validation gates, and browser-automation caveats.
- **Deployment:** [deployment guide](docs/deployment-guide.md) — supported host, Cloudflare Worker routes, and pending deployment requirements.

> **Where to go next** → see **[ROADMAP.md](ROADMAP.md)**: the near-term (~100h)
> priorities (tests/CI first, then the user on-ramp, mobile, MC bridge,
> reliability) and the long-term (~10k h) vision — a universal LEGO pipeline:
> buildable *from* anything, *into* anything, with a physical-validity verifier
> as the moat. Read it before planning large work; it also lists the anti-goals
> (don't micro-polish the renderer; don't re-verify settled questions).

## Dev / commands

- Dev server: `bun dev:web` (port 4000). Add `--host` to expose on LAN (phone testing at the box's LAN IP:4000).
- Typecheck: root is `bun run typecheck` (`tsc --noEmit`, the `src/` tree); the whole `web/` tree is `bun run typecheck:web` (`tsc --noEmit -p web/tsconfig.json`). **Both run in CI** (ci.yml + deploy.yml) so a careless edit can't silently compile-break. The `web` tree is currently type-clean — keep it that way (the old ~34 `ui/*` errors were fixed; the app still *builds* via Vite/esbuild without type-gating, but CI now gates it).
- Build: `bun run build:web`. Tests: **`bun run test`** (vitest — 1,634 passing,
  26 skipped as of 2026-09-17). **Not bare `bun test`**: that runs Bun's own
  runner, which globs the whole tree including copied apps under `output/`
  (2,755 tests, 74 failures that are not this code) and takes 16 minutes.
  See the [testing guide](docs/testing-guide.md) for suites and manual gates.
- Use **Chrome** for browser testing, not Edge.

## Key tabs

Generate · Import · Upload · Gallery · Comparison · Map · Tiles · **LEGO**

## Gotchas

- **PWA service worker** caches all modules and serves stale code. If changes
  don't take effect: unregister SW + clear caches, then hard reload. (See the
  snippet history; `navigator.serviceWorker.getRegistrations()...` + `caches.keys()...`.)
- **`[hidden]` + `display:flex` trap**: rows with `class="lego-scale-row"` (which
  sets `display:flex`) override the `hidden` attribute. Toggle `style.display`,
  not just `.hidden` (bit the help overlay AND the step/explode rows).
- LDraw Y is down; the viewer handles the handedness. Model-aware F/B/L/R
  orientation is derived from the longest horizontal axis + brick mass.

## Autonomous improvement loop

`scripts/renderer-improve-loop.mjs` is a Stop hook (in `.claude/settings.json`) that, when `.claude/improve-loop-state.json` has `"active": true`, blocks stop + re-injects a "find/implement/validate/commit the next improvement" directive (50-pass cap). Currently `active:false`. Re-arm: set `active:true, pass:0`.
