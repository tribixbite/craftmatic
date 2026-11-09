# Wave 2 brief: added to `docs/plans/implementer-brief.md` for every Wave-2 agent (2026-11-09)

Wave 1 is merged into `main`: D-03, X-01, X-06, X-08, X-11, B29, B01, X-04 and C01. See TASKS-BUSINESS.md "WAVE 1 ALL
MERGED" for the follow-ups found in review.

There is no per-package paste-ready brief for Wave 2. Your package is defined by:
- its row in `docs/plans/README.md` section 2 (goal, files, first failing test, acceptance, dependencies);
- the matching work package in the source plan (`business-A-original-packs.md`, `business-B-byom-converter.md` or
  `business-D-free-releases.md`), which has the detail;
- the review notes in `docs/plans/business-review.md`.

Where the README row and the source plan disagree, the README row wins.

## Files owned by OTHER Wave-2 agents (do not edit them; if you must, stop and report instead)

| Package | Owns |
|---|---|
| X-02 -> X-17 (one agent) | `web/src/engine/playable-addon.ts`, `schem-pipeline.ts`, `playable-components.ts`, and the label-heuristic call sites |
| X-03 | the post-pass rewriter's new files |
| X-05 | `pack-text/` |
| X-09 | the lattice verifier (`web/src/brickgen/verify/*`) |
| A05 | massing (`web/src/brickgen/site/*`, `massing/*`) and `web/tsconfig.json` |
| X-12 | the metrics harness; it reads `web/src/sim/render/rasterizer.ts` but does not edit it |
| B09 | mesh format readers |
| B15 | `tools/photo3d/` |
| F01 | the figure study (new files only) |
| C03 | coaster rail geometry (new files; NOT `bedrock-coaster.ts`) |

Wave-1 modules (`web/src/brickgen/{types,vocab,colour,emit}`, `web/src/release/*`, `web/src/engine/legolize/*`,
`byom/*`, `part-source.ts`, `coaster-design.ts`) may be IMPORTED. Edit one only for a bug fix that your test
proves; name the edit in your report.

## Nobody touches these
- `cockpit-seat.ts` and `scene-vehicles.ts`: branch `gen-side-1109` is waiting on the user.
- `ldraw-directives.ts` and `ldraw-parser.ts`: X-08's; ask in your report if you need a meta.
- `ldraw-geometry.ts`: X-04's.
- `REQUIREMENTS.md` and `TASKS-BUSINESS.md`: the orchestrator's.

Branches `gen-seat4-veh` and `gen-view-veh` are build-only and are never merged; ignore them.
