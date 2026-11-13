# Wave 6 brief: added to `docs/plans/implementer-brief.md` for every Wave-6 agent (2026-11-13)

Waves 1-5 are merged into `main` and pushed. The user's decisions are in `docs/plans/README.md` section 5 (ANSWERED
rows, including the 2026-11-13 ones: the custom-sculpted figure, landmark detail by size, the side rule). The current
state and open findings are in TASKS-BUSINESS.md: "WAVE 5 MERGED" and "WAVE 6 PLAN".

Commit signature: your own model. The failing first run must be pasted into your report: that is a merge condition.
Run `git check-ignore -v` on new non-code files. Paid-pack design sources go in the PRIVATE repo
`C:/git/craftmatic-designs` (commit on a branch named like your worktree, never push); never in the public repo.

## File ownership

| Package | Owns |
|---|---|
| RB (release build passes Microsoft's validator) | `web/src/engine/marketplace/*`, `scripts/_marketplace_pack.ts`, `web/src/release/prepare*`, `scripts/release.ts`, the X-02 profile's file emission in `playable-addon.ts` (pack icon, which text files ship, provenance/diagnostics JSON) |
| LSCALE (landmark detail by size) | `web/src/brickgen/massing/scale.ts`, `web/src/brickgen/bricker/*` scale hooks, a new `web/src/brickgen/levels/*`, the wand's size suggestion in `bedrock-placement-pack.ts` (coordinate with RB: RB does not touch placement) |
| MQ2 (landmark massing) | `web/src/brickgen/site/*`, `web/src/brickgen/massing/*` except `scale.ts`, `web/src/brickgen/grammar/*` |
| RIDE2 (water-slide tower, stunt arena) | `web/src/engine/rides/*`, the slide ride in `bedrock-rides.ts`, vehicle-course pieces in new files |
| DEV (Pixel round) | no source files; device evidence under `output/device-round-2026-11-13-pixel/` |

## Nobody touches these
- `ldraw-directives.ts`, `ldraw-parser.ts`, `ldraw-geometry.ts`;
- `minifig-rig.ts`, until the user picks FIG3's figure;
- `cockpit-seat.ts`;
- `REQUIREMENTS.md` and `TASKS-BUSINESS.md`.

## The pack contract
RB, LSCALE and RIDE2 change shipped packs. Dev packs stay byte-identical apart from the stamp unless a change is
intended and proven: build favourites before and after into NEW folders, and run `--scenario=regressions` with packs
named as the registry expects.
