# Wave 3 brief: added to `docs/plans/implementer-brief.md` for every Wave-3 agent (2026-11-09)

Waves 1 and 2 are merged into `main`. TASKS-BUSINESS.md lists the follow-ups found in review.

Each package is defined by:
- its row in `docs/plans/README.md` section 2;
- the matching work package in the source plan;
- `docs/plans/business-review.md`.

The README row wins where they disagree. The failing first run must be pasted into your report: that is a merge condition.

## File ownership (do not edit another agent's files; if you must, stop and report)

| Package | Owns |
|---|---|
| X-10 | the bricker (`web/src/brickgen/bricker/*`) |
| X-07 | `pack-check.ts` (the TS port of `_mcaddon_check.py`, new file) and its tests |
| M03 | `collider-form.ts`, `addon-walk.ts`, the sim's collider READER, own brick blocks, and the ONE `playable-addon.ts` hook for them (X-02 is merged) |
| M07 | `bedrock-placement-pack.ts` (air-only placement, prompt, undo) |
| M14 | `web/src/sim/**` except M03's collider reader: read the namespace from the pack |
| B03 | `schem-pipeline.ts` and the BYOM hints module (C02 waits for B03) |
| A09 | `web/src/brickgen/features/*` (tags, licensed-photo annotation sidecars, mesh slices) |
| D-08 | `scripts/release.ts` (`prepare`, stages flagged until their deps land) and `web/src/release/prepare*` |
| D-09 | `release/channels/*.json` and the one channel bundle generator |
| V-02 (follow-up) | `web/src/engine/legolize/metrics.ts` and its tests: a TRUTH lattice from each brick's own footprint cells |

## Nobody touches these
- `cockpit-seat.ts` and `scene-vehicles.ts` (`gen-side-1109` waits on the user).
- `ldraw-directives.ts` and `ldraw-parser.ts` (X-08's).
- `ldraw-geometry.ts` (X-04's).
- `bedrock-coaster.ts` (C02, later).
- `minifig-rig.ts` (F02, which waits on U4).
- `REQUIREMENTS.md` and `TASKS-BUSINESS.md` (the orchestrator's).

## The pack contract: a change to any shipped pack must be proven
M03, M07 and M14 change what packs do on a device. Each must show that its change keeps the device-proven behaviour:
- `bun scripts/sim.ts <packs> --scenario=regressions` on the favourites' packs;
- the relevant `_walk_line.ts` routes and the `_ix_passability.ts` results;

each compared before and after.
