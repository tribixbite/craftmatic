import { readFileSync } from 'node:fs';
import { indexedTryOrder, type IndexModel } from '../web/src/engine/lego-sources.ts';

/**
 * The QA populations the sweeps and audits run over: the user's 40 favourite
 * sets (the priority population) and the five Gabby's Dollhouse sets added
 * 2026-09-26 (mini-doll scale, scene boats, rides).
 */
export const FAVOURITES: readonly string[] = [
  '10261', '10303', '10326', '10337', '10341', '10354', '10365', '11371', '11374',
  '21061', '21063', '21318', '21360', '31141', '41395', '41703', '41732', '42172',
  '42639', '42652', '42663', '42670', '43267', '60380', '60446', '71040', '71043',
  '75397', '76269', '76286', '76417', '76419', '76435', '76457', '77092', '80049',
  '910004', '910032', '910047', '910049',
];

export const GABBY_SETS: readonly string[] = ['10796', '10797', '10788', '10786', '11204'];

/**
 * The label the LEGO tab exports a set under (`ui/lego.ts`: `${name} (${set_num})`). It is not cosmetic: the
 * vehicle classifier and the display scale read the title, and a pack's uuid follows it, so a QA build labelled
 * with the bare number is a DIFFERENT pack from the one a user gets (audit 2026-11-15 A-01: five favourite
 * vehicles shipped static that way). A set with no indexed name keeps its number.
 */
export function legoTabLabel(set: string, name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} (${set}-1)` : set;
}

/**
 * The file stem device rounds name a pack by, and the regression set's `newStem`: `<set>-<words of the name>`,
 * lower case, punctuation dropped inside words (`X-wing` -> `xwing`, `Gabby's` -> `gabbys`).
 */
export function packStem(set: string, name: string | undefined): string {
  const words = (name ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/).filter(Boolean);
  return words.length ? `${set}-${words.join('-')}` : set;
}

/** A doorway's verdict as the passability walk gives it (`interactive-walk.ts` `Verdict`). */
export type DoorwayVerdict = 'OK' | 'ONE-WAY' | 'SMALL' | 'FAIL' | 'NO-APPROACH' | 'SEALED' | 'STEP';

/** One doorway the walk does not call OK, with its verdict. */
export interface NotOkDoorway { label: string; verdict: DoorwayVerdict }

/**
 * What a recorded list says of one set's not-OK doorways (`ceilingCheck`): `unlisted` are doorways not OK now that
 * the record does not explain (the gate fails: a new one, or a recorded one whose verdict changed), `nowOk` are
 * recorded doorways that are OK now (the record must shrink with them: the ceiling only goes down).
 */
export interface CeilingCheck { unlisted: NotOkDoorway[]; nowOk: string[] }

/**
 * Check a set's doorways that are not OK against its recorded explanations (`record`: label -> `<verdict>: why`).
 * A doorway is explained only by a row naming the same verdict, so a SEALED door that turns ONE-WAY is reviewed again.
 */
export function ceilingCheck(record: Readonly<Record<string, string>> | undefined, notOk: readonly NotOkDoorway[]): CeilingCheck {
  const rows = record ?? {};
  const unlisted = notOk.filter(d => !rows[d.label]?.startsWith(`${d.verdict}:`));
  const nowOk = Object.keys(rows).filter(label => !notOk.some(d => d.label === label));
  return { unlisted, nowOk };
}

/**
 * The favourites' doorways that are NOT walkable at 100 % (turn 0), each with its verdict and why, as
 * `bun scripts/_ix_sealed_causes.ts <packs> <geometry> --drawn --sizes=100` attributes it (audit 2026-11-15 A-11,
 * favsweep-4e5963dc). `bun scripts/_ix_sweep_report.ts <dir> --ceilings` fails on a not-OK doorway this record does
 * not explain and on a recorded one that is OK now (delete its row: the list only shrinks). `model:solid`: drawn
 * geometry (furniture, a wall, a railing) a block out on one side where a minifig - one stud deep - still stands and
 * the 0.6-wide player does not; `model:route`: a way exists a block out but not through the opening; `model:drop`:
 * nothing drawn to stand on there.
 */
export const FAVOURITE_DOORWAYS_NOT_OK_AT_100: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '10326': { 'Door 6': 'SEALED: model:route - the drawn model offers no way through from the + side' },
  '11371': { 'Door 8': 'SEALED: model:solid - drawn geometry a block inside the - side, 5.8 blocks up' },
  '21318': { 'Door 2': 'SEALED: model:solid - furniture a stud inside the - side (opens at 200 % with the doorway carve)' },
  '42663': { 'Door 1': 'SEALED: model:solid - drawn geometry on the - side; the model is passed only by leaving the doorway sideways' },
  '42670': {
    'Garage door 1': 'SEALED: model:solid - the garage opens onto drawn geometry on the + side',
    'Door 3': 'SEALED: model:solid - drawn geometry a block out on the + side, 1.3 blocks up',
  },
  '71040': { 'Door 1': 'SEALED: model:solid - drawn geometry on both sides of the castle door' },
  '71043': {
    'Door 1': 'NO-APPROACH: model:drop - microscale: nothing drawn to stand on at either side at 100 %',
    'Door 2': 'NO-APPROACH: model:drop - microscale: nothing drawn to stand on at either side at 100 %',
  },
  '75397': { 'Gate 1': 'SEALED: model:route - the drawn model offers no way through from the - side' },
  '76417': { 'Gate 1': 'SEALED: model:route - the gate opens 17 blocks over the grass, no drawn way down' },
  '80049': { 'Gate 1': 'SEALED: model:solid - drawn geometry a block out on the + side; still the model\'s at 200 % (model:route)' },
  '910004': {
    'Door 2': 'SEALED: model:solid - drawn geometry a block out on the - side, 3.4 blocks up',
    'Door 3': 'SEALED: model:solid - an alcove: the model is passed only by leaving the doorway sideways',
    'Door 4': 'SEALED: model:solid - drawn geometry a block out on the - side',
    'Door 5': 'SEALED: model:solid - drawn geometry a block out on the - side, 4 blocks up',
  },
  '910049': { 'Gate 1': 'SEALED: model:route - the drawn model offers no way through from the - side' },
  // TODO(clearance-tight-910032): the PACK's, not the model's - cells (2,0,5) and (2,0,6) hold a floor plate and
  // furniture details a few sixteenths wide, yet ship full 0..15 colliders that clearance never proposed to trim; the
  // drawn model lets the player through (`wide:OK`). Open until clearance trims sparse furniture cells.
  '910032': { 'Door 4': 'SEALED: collider:tight - OUR colliders: full 0..15 cells over sparse furniture geometry seal the - side (TODO)' },
};

/** A tap target's label that names a doorway leaf (a door, a gate, a garage door). */
export const DOOR_LABEL = /^(door|gate|garage door)\b/i;

/**
 * The walked approaches (`bun scripts/sim.ts <packs> --walk --sizes=100`, scenarios `place-100-*`) to a DOOR the
 * child does not reach on foot where the MODEL draws a route (`TapReach.byModel` false: the pack's colliders take
 * it), counted as distinct door labels per favourite (audit 2026-11-15 A-20, favsweep-4e5963dc). `--door-ceilings`
 * fails a favourite above its number and asks for the number to come down when it is below: the ceiling only goes
 * down. A favourite not listed has a ceiling of 0. The model's own (an upper floor no drawn stair reaches) are not
 * counted. Triaged 2026-11-15 (audit-doors2, `TapReach.blame` names the edge): 10326 Door 4 was the sim's own - the
 * drawn route walked through the closed leaf to a tap spot behind it (the model route now treats closed leaves as
 * drawn, ceiling 0). TODO(walk-attribution): the three left are the pack's and open -
 *   11371 Doors 2 and 4: a lamp post 1/16 block square in the corner of grid cell (20, 1..3, 5) ships as a quarter-
 *     block x-band the cell's whole length (the form kit has bands only, no corner shapes); with a 3/16 post's band in
 *     the next cell the 0.6-wide player no longer fits the 0.5-block gap the drawn route walks;
 *   42670 Door 3: a threshold stair's treads (grid (7..9, 0..1, 3), no geometry) stand across the ground route
 *     along the facade the drawn route takes (a tread run's side is a wall);
 *   71040 Door 1: the drawn route passes 0.1 block inside the box of an overhang's layer (grid (3, 1, 9), x 8..16
 *     sixteenths, refused `walkable-top`); the colliders are exactly that box, so this one is within the part-box vs
 *     drawn-cube tolerance, not a trim clearance missed.
 */
export const FAVOURITE_DOOR_ROUTES_PACK_AT_100: Readonly<Record<string, number>> = {
  '11371': 2, // Doors 2 and 4: a corner post's band (no corner forms in the kit)
  '42670': 1, // Door 3: a threshold stair across the ground route
  '71040': 1, // Door 1: an overhang's layer box 0.1 inside the drawn route
};

/** A favourite's count against its ceiling: `over` fails the gate, `under` asks for the ceiling to come down. */
export function doorRouteCeiling(set: string, count: number): { ceiling: number; over: boolean; under: boolean } {
  const ceiling = FAVOURITE_DOOR_ROUTES_PACK_AT_100[set] ?? 0;
  return { ceiling, over: count > ceiling, under: count < ceiling };
}

/** The models index and the corpus the favourites are exported from (clego). */
export const MODELS_INDEX = 'C:/git/clego/lego-models-index.json';
export const CORPUS_ROOT = 'C:/git/clego/lego_sets';

/** One set's entry in the models index (the fields the sweeps read). */
export interface IndexedSet { name?: string; models?: IndexModel[]; parts?: number; catalogParts?: number }

/** Every set in the models index, keyed by set number. */
export function readModelsIndex(path: string = MODELS_INDEX): Record<string, IndexedSet> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { sets: Record<string, IndexedSet> }).sets;
}

/**
 * The source the LEGO tab's picker loads first for `set` (`indexedTryOrder`'s first pick), as a corpus path, or
 * null when the index has no model for it. The sweep and the face census both build from it.
 */
export function firstPickSource(entry: IndexedSet | undefined): { model: IndexModel; file: string } | null {
  if (!entry?.models?.length) return null;
  const model = entry.models[indexedTryOrder(entry.models, entry.catalogParts ?? entry.parts)[0]!]!;
  return { model, file: `${CORPUS_ROOT}/${model.path}` };
}
