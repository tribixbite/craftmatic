# UI architecture proposal — three.js currency, framework choice, overhaul plan (2026-09-09)

Prepared for the "complete UI overhaul" decision. Every current-state claim was
verified in-repo on this date; currency claims are sourced at the bottom.

## 1. Current state (measured, not remembered)

- **Framework: none.** The web app is vanilla TypeScript + Vite 7 (`vite ^7.3.1`),
  one root `package.json`, no react/svelte/lit/solid anywhere in deps. UI =
  **39 hand-wired DOM modules** in `web/src/ui/` plus a 956-line `main.ts` that
  wires tabs, menus and the download dropdown by hand.
- **Scale of the hand-wiring:** `lego.ts` alone is 2,398 lines with **98**
  `getElementById`/`querySelector` call sites; `import.ts` has 73; the app total
  is several hundred. State lives in module-level `let`s + `localStorage`
  (settings), with cross-module coordination by exported functions and shared
  DOM ids.
- **Documented UI pain from this repo's own history** (CLAUDE.md + the
  2026-09-08 audit): the `[hidden]` vs `display:flex` trap (bit three separate
  features); a duplicate `#mc-set-res` id when two tabs mount the same panel
  (worked around with scoped queries; labels still focus the wrong element);
  hand-positioned overlays (the export banner measures `#nav`'s bottom); the
  PWA service worker serving stale modules; status text as the only feedback
  channel, silently clobbered until `currentSourceWarning` was invented.
- **three.js: `^0.172.0` (r172, Dec 2024-era), pinned deliberately** — the
  2026-08-29 note says "three r172 kept (bottlenecks app-level)", which was
  true for the perf work then. Upstream is now at **r186** (r184 in April 2026,
  r186 since), i.e. **14 releases of drift**.
- **The viewer is framework-independent and must stay so**: `viewer/ldraw/`
  (2,411-line viewer.ts + parts/materials/audit modules) touches no UI
  framework, owns its render loop, and carries a season of hard-won calibration
  (NeutralToneMapping, specular 0.45, dark studio env, instancing, on-demand
  rendering, edge LOD). It is the crown jewel; nothing here proposes touching
  its internals.

## 2. three.js — upgrade, on its own track

**Recommendation: upgrade r172 → current (r186) as a dedicated, gated pass,
decoupled from any UI work. Do NOT adopt WebGPURenderer in this pass.**

- Why upgrade at all: 14 releases of drift compounds — every future bugfix,
  security note or addon improvement lands further away; the CommonJS build is
  deprecated upstream (we're pure ESM — unaffected today, a sign of direction);
  staying current is cheap NOW and expensive later.
- Why not WebGPU yet: `WebGPURenderer` has been production-ready since ~r171
  and is where upstream momentum is (TSL, node materials) — but our renderer's
  *look* is pixel-calibrated against box art on the WebGL path. A WebGPU port
  re-opens every calibration (tone mapping, SAO, env, fat-line shaders) for
  a benefit our GPU-bound profile hasn't asked for. Revisit only with the
  visual-fixture suite as the gate and a measured reason (e.g. mobile perf).
- What to test in the upgrade (all addon-land, where breakage concentrates):
  `LineSegments2` fat lines (the global edge overlay), `SAOPass`/`EffectComposer`
  (post chain), InstancedMesh + instanceColor behavior, `toCreasedNormals`,
  GLTF/OBJ/STL exporters. Known migration items in range: `Object3D.dispose()`
  added (harmless; custom types should call `super.dispose()`),
  `BufferGeometryUtils.toTrianglesDrawMode` mutates in place, misc renames per
  the migration guide.
- **Gates already exist and make this safe**: the pinned-camera visual-fixture
  script (10316 headgear / 71043 joints / OMR + SNOT controls), the perf
  baseline doc, and prod-smoke. Run all three before/after; pixel-compare the
  fixtures. Budget: ~a day of agent work, most of it verification.

## 3. Framework — the Svelte question, answered honestly

**Recommendation: Svelte 5 (runes), introduced as islands under a strangler
pattern. Not a big-bang rewrite.**

Why Svelte 5 over the alternatives considered:

| option | verdict | reasoning |
|---|---|---|
| **Stay vanilla + a small reactive store** | Rejected as the end-state, adopted as step 0 | Fixes state sprawl cheapest, but leaves 39 modules of hand-wired DOM, the id-collision class, and every popover/banner hand-built. The overhaul the user wants (slick, modern, mobile-first) would be hand-rolled again. |
| **Lit (web components)** | Rejected | Incremental like islands, but app-scale shared state and templating DX are weaker; shadow-DOM styling friction fights a global design-token system; ecosystem thin for app shells. |
| **SolidJS** | Rejected | Slight raw-update edge is irrelevant here (our hot path is the GPU + worker pipeline, not DOM diffing); ecosystem ~¼ of Svelte's; no in-house patterns. |
| **Svelte 5** | **Adopted** | Compiler-first = tiny runtime cost (right for a perf-sensitive page sharing a thread with a 3D viewer); runes give fine-grained reactivity that maps 1:1 onto our settings/status/diagnostics state; mature 2026 ecosystem (shadcn-svelte, Skeleton, bits-ui) accelerates the dark-mode design system; first-class Vite plugin; the toolchain here already carries Svelte patterns (svelte-app / svelte-filter-spa skills), and it's TS-native per the user's stack preferences. |

Two Svelte-specific cautions, stated up front: SvelteKit is NOT proposed (this
is a Vite SPA + PWA; adding a meta-framework buys routing/SSR we don't need and
risks the service-worker setup), and islands must own their DOM subtrees
exclusively — mixed hand-wiring inside an island recreates the current class of
bugs with worse debuggability.

## 4. Migration architecture (strangler, shippable at every step)

- **Step 0 — contracts before components.** Extract a typed `ViewerBus`
  (events out: load progress/status/diagnostics/pick/contact-report; commands
  in: load/explode/step/view) and a `settingsStore` (runes, localStorage-backed,
  replacing scattered module `let`s). The viewer and engine expose/consume ONLY
  these. No visual change; kills the shared-DOM-id coupling at the root.
- **Step 1 — first islands: the controls cluster.** MC-settings popover,
  export-progress banner, diagnostics download, contact-check status — small,
  recently-touched, high-bug-density surfaces (the duplicate-id bug lives
  here). Two of them are already isolated modules with clean APIs. Mounted as
  Svelte components inside the existing layout; `schem-settings-panel.ts` and
  `export-progress.ts` retire.
- **Step 2 — the LEGO tab shell** (the flagship): search/results/cards/source
  picker/status panel as components over `lego-sources` + catalog engines;
  `lego.ts` shrinks to orchestration over the bus. This is where the visual
  overhaul lands (tokens, mobile layout), because it's the tab users live in.
- **Step 3 — remaining tabs** (Upload, Gallery, Generate, Import cluster,
  Comparison/Map/Tiles) in descending traffic order; `main.ts` becomes a thin
  mount registry + tab router.
- **Step 4 — design system**: CSS custom-property tokens (dark-first, the
  existing palette formalized), one component kit adopted selectively
  (shadcn-svelte), motion/micro-interactions pass, mobile breakpoint audit.
- **Does NOT migrate**: `viewer/ldraw/*` internals, `engine/*` (pure logic +
  workers), the schem worker pipeline, the PWA/service-worker setup (verify
  vite-plugin behavior unchanged after the Svelte plugin lands), `index.html`'s
  app shell beyond mount points.

## 5. Cost / risk / order

| stage | cost | risk | gate |
|---|---|---|---|
| three r172→r186 | ~1 day | Medium (addon drift) | visual fixtures pixel-diff + perf baseline + prod smoke |
| Step 0 contracts | ~1-2 days | Low | typecheck + suite; zero visual change |
| Step 1 islands | ~1-2 days | Low | the settings/banner tests already written |
| Step 2 LEGO shell | ~3-5 days | Medium (flagship surface) | fixtures + mobile screenshots + suite |
| Step 3 tabs | ~1 wk spread | Low, incremental | per-tab smoke |
| Step 4 design system | continuous | Low | screenshot review |

Order: three.js upgrade first (isolated, gated, unblocks staying current),
then 0→1→2→3 with 4 threaded through 2-3. The app ships green at every stage;
any stage can pause indefinitely without stranding the codebase half-migrated
(islands coexist with vanilla modules by design).

**Anti-goals (binding):** no viewer rewrite; no renderer-look changes outside
the gated three upgrade; no WebGPU in this arc; no SvelteKit/SSR; no PWA
regression; no big-bang — a tab converts only when its island is at parity.

## Sources
- [three.js releases](https://github.com/mrdoob/three.js/releases) · [r186](https://github.com/mrdoob/three.js/releases/tag/r186) · [Migration guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide) · [What's new in three.js 2026](https://www.utsubo.com/blog/threejs-2026-what-changed)
- [Svelte vs SolidJS 2026 comparisons](https://www.pkgpulse.com/guides/solidjs-vs-svelte-5-vs-react-reactivity-2026) · [Svelte 5 runes guide](https://www.pkgpulse.com/guides/svelte-5-runes-complete-guide-2026) · [Bundle/DX comparison](https://arc.dev/employer-blog/svelte-vs-vue-vs-solidjs/)
