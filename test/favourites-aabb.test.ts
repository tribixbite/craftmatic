/**
 * A-07 (audit 2026-11-15, PROC-19 / LEGO-xx): every part a favourite places either resolves to real geometry or is
 * on a REVIEWED list with the reason it cannot (`test/fixtures/favourites-aabb-allowlist.json`). A part with no
 * geometry ships as its dims-table bounding box (`ldraw-entity-compiler.ts`, "no geometry resolved"), which is how
 * 76269's hinge plates, 42172's shock absorbers and 910049's chest lid shipped as grey slabs.
 *
 * The list is EXACT both ways: a new boxed id fails, and an id that starts resolving must leave the list, so the
 * list is always the true residue. Resolution runs the export's own provider (`createPartGeometryProvider`) over the
 * index's first pick with that source's embedded sections and `.io` CustomParts, against the local Studio library and
 * `ldraw_ref/` (vitest sets `CRAFTMATIC_LDRAW_REF`), with the mirror off - the same answer a CLI build gets.
 * Skipped where the corpus is absent (CI).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { FAVOURITES } from '../scripts/favourite-sets.js';
import { HAVE_FAVOURITES_CORPUS, STUDIO_LDRAW_ROOT, loadFavouriteSource } from './favourites-corpus-support.js';

const ALLOWLIST = 'test/fixtures/favourites-aabb-allowlist.json';

/** `{ set: { partId: reason } }`: the reviewed parts of each favourite that ship as a box, each with why. */
type Allowlist = Record<string, Record<string, string>>;

describe.skipIf(!HAVE_FAVOURITES_CORPUS)('favourites-aabb :: no favourite ships a bounding box the review has not accepted', () => {
  let allow: Allowlist;
  beforeAll(() => {
    setLDrawRoot(STUDIO_LDRAW_ROOT);
    allow = JSON.parse(readFileSync(ALLOWLIST, 'utf8')) as Allowlist;
  });

  it('every boxed part id of every favourite equals the reviewed allowlist, and every listed id has a reason', async () => {
    const got: Record<string, string[]> = {};
    const want: Record<string, string[]> = {};
    for (const set of FAVOURITES) {
      const source = await loadFavouriteSource(set);
      if (!source) continue; // LXF (71043): parsed only through the DOM shim; it has no boxed parts on the sweep.
      const provider = createPartGeometryProvider({ embedded: source.embedded });
      const ids = [...new Set(source.doc.bricks.map(b => b.part))];
      const boxed: string[] = [];
      for (const id of ids) if ((await provider.getPartMesh(id)) === null) boxed.push(id);
      const listed = allow[set] ?? {};
      for (const [id, reason] of Object.entries(listed)) expect(reason.trim().length, `${set} ${id} needs a reason`).toBeGreaterThan(10);
      if (boxed.length || Object.keys(listed).length) {
        got[set] = boxed.sort();
        want[set] = Object.keys(listed).sort();
      }
    }
    expect(got).toEqual(want);
  }, 900_000);
});
