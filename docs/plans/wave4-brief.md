# Wave 4 brief: added to `docs/plans/implementer-brief.md` for every Wave-4 agent (2026-11-09)

Waves 1-3 are merged into `main`. TASKS-BUSINESS.md "WAVE 3 MERGED" and "NEXT (wave 4)" hold the findings this wave acts on.

Each package is defined by:
- its row in `docs/plans/README.md` section 2, where one exists;
- the source plan;
- the goal written in your prompt.

The failing first run must be pasted into your report: that is a merge condition. Run `git check-ignore -v` on every new non-code file.

## File ownership

| Package | Owns |
|---|---|
| MQ (massing quality) | `web/src/brickgen/site/*`, `web/src/brickgen/massing/*`, `web/src/brickgen/bricker/plain-massing.ts` |
| A07+A08 (grammars) | `web/src/brickgen/grammar/*` (new): roofs, facades, the A09 features turned into intents |
| L (mesh -> bricks) | `web/src/engine/legolize/*`, `web/src/brickgen/vocab/*` (vocabulary additions and moved-name aliases), `scripts/_vendor_ldraw_vocab.ts`, `test/fixtures/ldraw-vocab/` |
| C02 (coaster into a pack) | `schem-pipeline.ts`, `bedrock-coaster.ts`, the ONE `playable-addon.ts` hook, `coaster-*.ts` except `coaster-design.ts` and `coaster-track-mesh.ts` (import those) |
| T02 (marketplace sim scenario) | `web/src/sim/**` and `scripts/sim.ts` |
| D-08b (release finish) | `scripts/release.ts`, `web/src/release/prepare*`, `release/*` data |

## Nobody touches these
- `cockpit-seat.ts` and `scene-vehicles.ts`.
- `ldraw-directives.ts`, `ldraw-parser.ts` and `ldraw-geometry.ts`.
- `minifig-rig.ts` (F02 waits on U4).
- `REQUIREMENTS.md` and `TASKS-BUSINESS.md`.

## The pack contract applies to C02 and T02
Dev packs must stay byte-identical apart from the stamp, unless a change is intended and proven. Check it on favourites built before and after into NEW folders, and run `--scenario=regressions` with packs named as the regression registry expects (e.g. `10788-gabbys-dollhouse.mcaddon`).
