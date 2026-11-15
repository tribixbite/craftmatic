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
