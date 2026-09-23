import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import type { LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.js';
import { detectCoasterAssemblies } from '../web/src/engine/coaster-assemblies.js';
import { indexedTryOrder, type IndexModel } from '../web/src/engine/lego-sources.js';

/**
 * Test the source the SITE loads, not a path a test found convenient.
 *
 * The auto-pick is `indexedTryOrder(models, catalogParts)[0]`. Every 10261 test
 * pinned `IOModel2V2/10261.ldr`, which that order ranks FIFTH; the real first
 * pick is `LDR/10261 Roller Coaster.mpd`, whose embedded `<set> - <mould>.dat`
 * parts defeated detection. So the suite was green on a source users never get
 * while the export they do get shipped a fabricated cart and no minifigs
 * (`ce50c838`). A green corpus test is worth nothing if it exercises a source
 * the picker would not choose.
 */
const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const INDEX = 'C:/git/clego/lego-models-index.json';
const CORPUS = 'C:/git/clego/lego_sets';
const HAVE = existsSync(LDRAW_ROOT) && existsSync(INDEX) && existsSync(CORPUS);

interface IndexEntry { models?: IndexModel[]; parts?: number; catalogParts?: number }
interface ModelsIndex { sets: Record<string, IndexEntry> }

/** Parsed once: the index is ~4.6 MB and every lookup would otherwise re-read it. */
let cachedIndex: Record<string, IndexEntry> | null = null;
const setsOfIndex = (): Record<string, IndexEntry> =>
  (cachedIndex ??= (JSON.parse(readFileSync(INDEX, 'utf8')) as ModelsIndex).sets);

/** The path the picker would load for a set, exactly as the LEGO tab resolves it. */
function firstPick(set: string): string {
  const entry = setsOfIndex()[set];
  if (!entry?.models?.length) throw new Error(`no index entry with models for ${set}`);
  const order = indexedTryOrder(entry.models, entry.catalogParts ?? entry.parts);
  return `${CORPUS}/${entry.models[order[0]!]!.path}`;
}

async function detect(file: string) {
  setLDrawRoot(LDRAW_ROOT);
  const doc = parseLDrawDocument(readFileSync(file, 'utf8'));
  const provider = createPartGeometryProvider({ document: doc });
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(doc.bricks.map(b => b.part))].map(async part => {
    meshes.set(part, await provider.getPartMesh(part));
  }));
  const tracks = extractCoasterTrackRoutes(doc.bricks, {
    isGeometryAvailable: (_id, b) => (meshes.get(b.part)?.triangles.length ?? 0) > 0,
  });
  return detectCoasterAssemblies(doc.bricks, meshes, tracks);
}

describe.skipIf(!HAVE)('the coaster sets detect cars on the source the picker chooses', () => {
  // Kept in sync deliberately: if the index promotes a different source for one
  // of these sets, this states which file the assertion below actually ran on.
  it('resolves 10261 and 31084 to their MPD sources and 10303 to its LDR', () => {
    expect(firstPick('10261')).toContain('LDR/10261 Roller Coaster.mpd');
    expect(firstPick('31084')).toContain('LDR/31084 Pirate Roller Coaster');
    expect(firstPick('10303')).toContain('IOModel2V2/10303.ldr');
  });

  it('10261: the first pick yields the set\'s own cars, not a fabricated cart', async () => {
    const result = await detect(firstPick('10261'));
    const ride = result.cars.filter(car => car.route);
    expect(ride.length).toBeGreaterThanOrEqual(6);
    expect(result.trains.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  // 31084 is a SECOND coaster whose first pick embeds its parts the same way:
  // its 26021 chassis and 24869 wheels are placed as `31084 - <mould>.dat` with
  // stub descriptions, so it shipped the same grey cart until `ce50c838`.
  it('31084 Pirate Roller Coaster: the first pick yields its three-car train', async () => {
    const result = await detect(firstPick('31084'));
    const ride = result.cars.filter(car => car.route);
    expect(ride.length).toBeGreaterThanOrEqual(3);
    expect(result.trains.length).toBeGreaterThanOrEqual(1);
    expect(result.trains[0]!.carIds.length).toBe(3);
    expect(result.trains[0]!.routeClosed).toBe(true);
  }, 120_000);
});
