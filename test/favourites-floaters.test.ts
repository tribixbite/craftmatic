/**
 * A-08 (audit 2026-11-15, VIEW-02 / PROC-19), per favourite: the loose pieces a pack leaves out
 * (`withoutStrayFragments`) are exactly the reviewed list in `test/fixtures/favourites-stray-drops.json` - every part
 * id with its count - so a change that starts dropping a real part of a model, or stops dropping the alternate build
 * beside 77092, fails here. The list was reviewed piece by piece (output/audit-1115 A-08 report): rows of loose
 * accessories, 77092's `_sm01` alternate-build parts, 76457's wands, single tiles and studs on the grass; no piece
 * of 30 parts or more and no piece holding a torso or a head is ever on it. Sources are the index's first picks
 * read as the CLI reads them (LXF 71043 is not covered here). Skipped where the corpus is absent (CI).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { withoutBuildTools } from '../web/src/engine/build-tools.js';
import { STRAY_MAX_PARTS, withoutStrayFragments } from '../web/src/engine/stray-fragments.js';
import { FAVOURITES } from '../scripts/favourite-sets.js';
import { HAVE_FAVOURITES_CORPUS, STUDIO_LDRAW_ROOT, baseplatesUncarried, loadFavouriteSource } from './favourites-corpus-support.js';

type Drops = Record<string, { parts: number; pieces: number; ids: Record<string, number> }>;

describe.skipIf(!HAVE_FAVOURITES_CORPUS)('favourites-floaters :: what each favourite pack leaves out as loose source debris', () => {
  let want: Drops;
  beforeAll(() => {
    setLDrawRoot(STUDIO_LDRAW_ROOT);
    want = JSON.parse(readFileSync('test/fixtures/favourites-stray-drops.json', 'utf8')) as Drops;
  });

  it('drops exactly the reviewed loose pieces of every favourite, and none of 30 parts or more', async () => {
    const got: Drops = {};
    for (const set of FAVOURITES) {
      const source = await loadFavouriteSource(set);
      if (!source) continue;
      const bricks = withoutBuildTools(source.doc.bricks).bricks;
      const { report } = await withoutStrayFragments(bricks, createPartGeometryProvider({ embedded: source.embedded }));
      for (const piece of report.pieces) expect(piece.parts.length, `${set} piece`).toBeLessThan(STRAY_MAX_PARTS);
      if (!report.parts) continue;
      const ids: Record<string, number> = {};
      for (const piece of report.pieces) for (const id of piece.parts) ids[id] = (ids[id] ?? 0) + 1;
      got[set] = { parts: report.parts, pieces: report.pieces.length, ids: Object.fromEntries(Object.entries(ids).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
    }
    expect(got).toEqual(want);
  }, 900_000);

  it('every baseplate a favourite places carries the model: 100 or more parts stand on its top (A-09, 76457)', async () => {
    // 76457's three 16 x 32 plates lay beside the village with 15, 1 and 13 parts on them (clego dbix_align row
    // 2748 -> 95.dat applied forward); applied inverse they carry 139, 154 and 137. The lightest plate of any
    // favourite carries 137.
    const light: string[] = [];
    for (const set of FAVOURITES) {
      const source = await loadFavouriteSource(set);
      if (!source) continue;
      for (const plate of await baseplatesUncarried(source, createPartGeometryProvider({ embedded: source.embedded }))) {
        if (plate.standing < 100) light.push(`${set} ${plate.part} at ${plate.at.map(Math.round).join(',')}: ${plate.standing}`);
      }
    }
    expect(light).toEqual([]);
  }, 900_000);
});
