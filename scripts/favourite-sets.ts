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
};

/** A tap target's label that names a doorway leaf (a door, a gate, a garage door). */
export const DOOR_LABEL = /^(door|gate|garage door)\b/i;

/**
 * The walked approaches (`bun scripts/sim.ts <packs> --walk --sizes=100`, scenarios `place-100-*`) to a DOOR the
 * child does not reach on foot where the MODEL draws a route (`TapReach.byModel` false: the pack's colliders take
 * it), counted as distinct door labels per favourite (audit 2026-11-15 A-20, favsweep-4e5963dc). `--door-ceilings`
 * fails a favourite above its number and asks for the number to come down when it is below: the ceiling only goes
 * down. A favourite not listed has a ceiling of 0. The model's own (an upper floor no drawn stair reaches) are not
 * counted. TODO(walk-attribution): each of these is a lead to triage, not a proven pack bug - at 11371's front the
 * drawn route steps onto a plate whose collider cell is 0.49 higher (a taller part in the same 1-block cell).
 */
export const FAVOURITE_DOOR_ROUTES_PACK_AT_100: Readonly<Record<string, number>> = {
  '10326': 1, // Door 4
  '11371': 2, // Doors 2 and 4: the front plate's collider cell is 0.49 over the drawn plate (a taller part in the cell)
  '42670': 1, // Door 3
  '71040': 1, // Door 1
};

/** A favourite's count against its ceiling: `over` fails the gate, `under` asks for the ceiling to come down. */
export function doorRouteCeiling(set: string, count: number): { ceiling: number; over: boolean; under: boolean } {
  const ceiling = FAVOURITE_DOOR_ROUTES_PACK_AT_100[set] ?? 0;
  return { ceiling, over: count > ceiling, under: count < ceiling };
}
