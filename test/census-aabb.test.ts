/**
 * Generality census (2026-11-16, PROC-19 / VIEW-03): the non-favourite sets whose packs shipped parts as bounding
 * boxes resolve every part that has a mould, and what is left is a REVIEWED residue with the reason each id has none
 * (`test/fixtures/census-aabb-allowlist.json`). The favourites' own list is `favourites-aabb.test.ts`; this is the
 * same check over the census sets the gates `gengate-6fa0afa6` and `gengate2-cda5f7b9` reported boxed placements for.
 *
 * The list is EXACT both ways, as the favourites' is: a newly boxed id fails, and an id that starts resolving must
 * leave the list. Resolution is the export's own provider over the index's first pick (`loadFavouriteSource` reads
 * any indexed set), with the mirror off. Skipped where the corpus is absent (CI).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { HAVE_FAVOURITES_CORPUS, STUDIO_LDRAW_ROOT, loadFavouriteSource } from './favourites-corpus-support.js';

const ALLOWLIST = 'test/fixtures/census-aabb-allowlist.json';
/** The census sets whose packs carried boxed placements (both census gates' content sections). */
const CENSUS_SETS = ['8097', '70615', '2504', '910035', '72006', '70420', '2507', '77072', '5524'] as const;

describe.skipIf(!HAVE_FAVOURITES_CORPUS)('census-aabb :: a census set ships a bounding box only for a reviewed mould-less id', () => {
  let allow: Record<string, Record<string, string>>;
  beforeAll(() => {
    setLDrawRoot(STUDIO_LDRAW_ROOT);
    allow = JSON.parse(readFileSync(ALLOWLIST, 'utf8')) as Record<string, Record<string, string>>;
  });

  it('every boxed part id of every census set equals the reviewed allowlist, and every listed id has a reason', async () => {
    const got: Record<string, string[]> = {};
    const want: Record<string, string[]> = {};
    for (const set of CENSUS_SETS) {
      const source = await loadFavouriteSource(set);
      expect(source, `${set}: first pick readable`).not.toBeNull();
      const provider = createPartGeometryProvider({ embedded: source!.embedded });
      const boxed: string[] = [];
      for (const id of new Set(source!.doc.bricks.map(b => b.part))) if ((await provider.getPartMesh(id)) === null) boxed.push(id);
      const listed = allow[set] ?? {};
      for (const [id, reason] of Object.entries(listed)) expect(reason.trim().length, `${set} ${id} needs a reason`).toBeGreaterThan(10);
      got[set] = boxed.sort();
      want[set] = Object.keys(listed).sort();
    }
    expect(got).toEqual(want);
  }, 900_000);
});
