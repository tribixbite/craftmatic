# Wave 5 brief: added to `docs/plans/implementer-brief.md` for every Wave-5 agent (2026-11-12)

Waves 1-4 are merged into `main`. The user's answers to every open question are in `docs/plans/README.md` section 5,
under "ANSWERED by the user 2026-11-12". Read them: they set the brand, the figure direction, the landmark list, the
show-stoppers, the sampler and the device rules.

Commit signature: YOUR OWN model ("— Sonnet 5.5", "— Fable 5.1", "— Opus 5.5"). Never Co-Authored-By, never the word
"Claude". The failing first run must be pasted into your report: that is a merge condition. Run `git check-ignore -v`
on every new non-code file.

Design sources that are part of a PAID pack go into the PRIVATE repo `C:/git/craftmatic-designs` (GitHub
`tribixbite/craftmatic-designs`), never into the public `craftmatic` repo. Commit there on a branch named like your
worktree, and do not push; the orchestrator pushes. Test fixtures that must run on CI may stay in the public repo only
if they are not a product design (small synthetic or generic pieces).

## File ownership

| Package | Owns |
|---|---|
| F01c (figure) | new humanoid candidates in `test/fixtures/figures/` and `web/src/engine/figure-brickling.ts` |
| T02-fix | `bedrock-placement-pack.ts`, `web/src/engine/pack-text/*`, the BrickWand/form strings |
| SV (side view) | `cockpit-seat.ts` and its tests (branch from `main`; `gen-side-1109` holds the side rule to re-apply) |
| RIDE (drop tower + sky swing) | `bedrock-rides.ts` and new ride modules (`web/src/engine/rides/*`) |
| SPIRE (grammar polish) | `web/src/brickgen/grammar/*` |
| C04 (coaster zones) | `bedrock-coaster.ts`, `coaster-zones.ts` (new) |
| L00 (landmark inputs) | `test/fixtures/osm/` (OSM data, ODbL attribution) and the private designs repo's `landmarks/` |
| MCT | `scripts/release-mctools.ts`, `package.json`/`bun.lock` for the validator's pins only |

## Nobody touches these
- `ldraw-directives.ts`, `ldraw-parser.ts`, `ldraw-geometry.ts`;
- `minifig-rig.ts`, until the user approves F01c's figure;
- `REQUIREMENTS.md` and `TASKS-BUSINESS.md`.

## The pack contract
T02-fix, SV, RIDE and C04 change shipped packs. Dev packs stay byte-identical apart from the stamp unless a change is
intended, and an intended change is proven with favourites built before and after into NEW folders plus
`--scenario=regressions` (packs named as the registry expects, e.g. `10788-gabbys-dollhouse.mcaddon`).
