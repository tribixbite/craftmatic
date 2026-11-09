/**
 * B03 (BIZ-31) over a REAL model file: OMR 75892 (`Car.ldr` beside `Wind Tunnel.ldr` and `Pilot.ldr`)
 * with `test/fixtures/byom/75892-1.byom.json`, built in explicit mode through the shared pipeline against
 * the local LDraw library. Skipped where the corpus is absent (CI); the box-part cases in
 * `byom-hints.test.ts` run everywhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLDrawDocument, embeddedPartTexts } from '../web/src/engine/ldraw-parser.js';
import { seedDatTexts, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.js';
import { parseByomHints, resolveByomHints } from '../web/src/engine/byom/hints.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { FIXED_STAMP, text, unzipAll } from './pack-profile-support.js';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const MODEL = 'C:/git/clego/lego_sets/OMR/75892-1.mpd';
const HINTS = 'test/fixtures/byom/75892-1.byom.json';
const HAVE_CORPUS = existsSync(LDRAW_ROOT) && existsSync(MODEL);

describe.skipIf(!HAVE_CORPUS)('byom-hints-corpus :: OMR 75892 with its hints file', () => {
  it('ships exactly the car, nose and seat count the hints say, and nothing the title or set number would add', async () => {
    setLDrawRoot(LDRAW_ROOT);
    const doc = parseLDrawDocument(readFileSync(MODEL, 'utf8'));
    seedDatTexts(embeddedPartTexts(doc));
    const parsed = parseByomHints(JSON.parse(readFileSync(HINTS, 'utf8')));
    if (!parsed.ok) throw new Error(parsed.errors.join(' | '));
    const resolved = resolveByomHints(parsed.hints, doc.bricks);
    expect(resolved.ok).toBe(true);
    const run = async (byomHints?: typeof parsed.hints): Promise<Map<string, Uint8Array>> => {
      const r = await runSchemPipeline({
        source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
        format: 'mcaddon', packStem: 'TunnelDemo', packLabel: 'Tunnel Demo', profile: 'default', lightFill: false, shapes: false,
        vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced', modelScale: 1, pipelineStamp: FIXED_STAMP, sourceProvenance: null,
        packProfile: { flags: { explicitOnly: true } }, ...(byomHints ? { byomHints } : {}),
      });
      return unzipAll(r.bytes!);
    };
    const diagnostics = (files: Map<string, Uint8Array>): any => JSON.parse(text(files.get([...files.keys()].find(n => n.endsWith('craftmatic-diagnostics.json'))!)!));
    const entityNames = (files: Map<string, Uint8Array>): string[] => [...files.keys()].filter(n => n.includes('_BP/entities/')).map(n => n.slice(n.lastIndexOf('/') + 1));

    // Control: with no hint, explicit mode still lets the GEOMETRY finders (scene-vehicles.ts) name a car, but no
    // title, set number or hint: its nose is measured, never the creator's.
    const bare = await run();
    const bareDiag = diagnostics(bare);
    const bareCar = Object.keys(bareDiag.entities).find(k => /_car_\d+$/.test(k));
    if (bareCar) expect(bareDiag.entities[bareCar].facing.source).not.toBe('explicit');

    const files = await run(parsed.hints);
    const cars = entityNames(files).filter(n => /_car_1\.json$/.test(n));
    expect(cars).toHaveLength(1);
    const entity = JSON.parse(text(files.get([...files.keys()].find(n => n.endsWith(`_BP/entities/${cars[0]}`))!)!));
    expect(entity['minecraft:entity'].components['minecraft:rideable'].seat_count).toBe(2);
    const facing = diagnostics(files).entities[Object.keys(diagnostics(files).entities).find(k => k.endsWith('_car_1'))!].facing;
    expect(facing).toMatchObject({ nose: '-z', source: 'explicit' });
    expect(text(files.get([...files.keys()].find(n => n.endsWith('scripts/vehicles.js'))!)!)).toMatch(/"mode":\s*"car"/);
  }, 300_000);
});
