/**
 * A-13 (audit 2026-11-15, FIG-05 / PROC-19), per favourite: every torso in the source is accounted for - a walking
 * figure, or kept in the build's geometry for a REVIEWED reason (posed past 30 degrees, a one-colour statue with a
 * standard head, a part-less fragment, a two-part baby) - and the counts equal
 * `test/fixtures/favourites-figures.json`, where each kept class carries its explanation. A figure the classifier
 * starts to miss, or a statue it starts to walk, fails here. Measured with the export's own scene-actor pass
 * (`discoverSceneActors` / `groupFigures` / `figureRole`) over the index's first picks; LXF 71043 is not covered.
 * Skipped where the corpus is absent (CI).
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { withoutBuildTools } from '../web/src/engine/build-tools.js';
import { figureRole, groupFigures, isTorso } from '../web/src/engine/ldraw-entity-compiler.js';
import { discoverSceneActors } from '../web/src/engine/bedrock-scene-actors.js';
import { assembleMinifig } from '../web/src/engine/minifig-rig.js';
import { FAVOURITES } from '../scripts/favourite-sets.js';
import { HAVE_FAVOURITES_CORPUS, STUDIO_LDRAW_ROOT, loadFavouriteSource } from './favourites-corpus-support.js';

type Kept = { count: number; why: string };
type Row = { torsos: number; walking: number; posed?: Kept; statue?: Kept; partial?: Kept; small?: Kept };

describe.skipIf(!HAVE_FAVOURITES_CORPUS)('favourites-figures :: every torso walks or is kept for a reviewed reason', () => {
  let want: Record<string, Row>;
  beforeAll(() => {
    setLDrawRoot(STUDIO_LDRAW_ROOT);
    want = JSON.parse(readFileSync('test/fixtures/favourites-figures.json', 'utf8')) as Record<string, Row>;
  });

  it('torsos == walking + posed + statue + partial + small for every favourite, each kept class as reviewed', async () => {
    const got: Record<string, { torsos: number; walking: number; posed: number; statue: number; partial: number; small: number }> = {};
    const expected: typeof got = {};
    for (const set of FAVOURITES) {
      const source = await loadFavouriteSource(set);
      if (!source) continue;
      const bricks = withoutBuildTools(source.doc.bricks).bricks;
      const actors = await discoverSceneActors(bricks, createPartGeometryProvider({ embedded: source.embedded }));
      const m = actors.meshes;
      const row = { torsos: bricks.filter(b => isTorso(b.part, m.get(b.part)?.description ?? '')).length, walking: actors.figures.length, posed: actors.posedFigures.length, statue: 0, partial: 0, small: 0 };
      for (const g of groupFigures(bricks, m)) {
        if (g.parts.length < 3) { row.small++; continue; }
        const role = figureRole(g.parts.map(i => bricks[i]!), m);
        if (role !== 'npc') row[role]++;
      }
      expect(row.walking + row.posed + row.statue + row.partial + row.small, `${set}: a torso went nowhere`).toBe(row.torsos);
      got[set] = row;
      const w = want[set];
      expect(w, `${set} has no reviewed row`).toBeDefined();
      for (const k of ['posed', 'statue', 'partial', 'small'] as const) if (w?.[k]) expect(w[k]!.why.length, `${set} ${k} needs a reason`).toBeGreaterThan(20);
      expected[set] = { torsos: w!.torsos, walking: w!.walking, posed: w!.posed?.count ?? 0, statue: w!.statue?.count ?? 0, partial: w!.partial?.count ?? 0, small: w!.small?.count ?? 0 };
    }
    expect(got).toEqual(expected);
  }, 900_000);

  it('10316 Rivendell walks every figure on its own legs or robe: the rig synthesises no lower body (PROC-20)', async () => {
    // The Mecabricks source is the set's Council display: Frodo and Bilbo sit on headlamp bricks, Elrond and Gandalf on
    // a bracket and a slope, their real 16709 legs and 36036 robes in a row beside the model. Walking, the rig gave
    // them plain synthesised legs (full-height hobbits, robeless elves) until clego geograde/seated_alt_swap.py.
    const source = await loadFavouriteSource('10316');
    expect(source, '10316 first pick').not.toBeNull();
    const bricks = withoutBuildTools(source!.doc.bricks).bricks;
    const actors = await discoverSceneActors(bricks, createPartGeometryProvider({ embedded: source!.embedded }));
    const lower = new Set(['hips', 'right leg', 'left leg', 'legs']);
    const synthesised = actors.figures
      .map(f => ({ at: f.centreLdu.map(Math.round).join(','), parts: assembleMinifig(f.bricks, actors.meshes).synthesized.filter(s => lower.has(s)) }))
      .filter(f => f.parts.length);
    expect(actors.figures.length).toBe(15);
    expect(synthesised).toEqual([]);
  }, 300_000);
});
