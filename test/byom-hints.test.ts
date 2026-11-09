/**
 * B03 (BIZ-31): a creator tells the converter what is a vehicle, a door or a seat with `ByomHints`;
 * the hints are validated, resolved over the model's own parts and applied in explicit mode, where
 * no title or set number decides anything. The pipeline cases run the REAL shared pipeline over a
 * small MPD whose parts are box stand-ins (no library, no network); `byom-hints-corpus.test.ts`
 * does the same over a real OMR file where the local library exists.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseLDrawDocument, type ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { runSchemPipeline, type SchemWorkerInput } from '../web/src/engine/schem-pipeline.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import type { PackProfile } from '../web/src/engine/pack-profile.js';
import {
  ByomHintsError, byomHintsPathFor, parseByomHints, resolveByomHints, type ByomHints,
} from '../web/src/engine/byom/hints.js';
import { FIXED_STAMP, PARTS, box6, seedBoxParts, text, unzipAll } from './pack-profile-support.js';

const EXPLICIT: PackProfile = { flags: { explicitOnly: true } };

/** A landscape (plates and a few columns) beside a ten-part vehicle sub-model named "Speeder". */
const MPD = [
  '0 FILE main.mpd', '0 Name: main.mpd',
  '1 16 0 0 0 1 0 0 0 1 0 0 0 1 landscape.ldr',
  '1 16 0 0 0 1 0 0 0 1 0 0 0 1 Speeder.ldr',
  '0 FILE landscape.ldr',
  ...[[-60, -60], [-60, 60], [60, -60], [60, 60]].map(([x, z]) => `1 8 ${x} -8 ${z} 1 0 0 0 1 0 0 0 1 3958.dat`),
  ...[[-40, -40], [0, -40], [40, -40], [-40, 40], [0, 40], [40, 40]].map(([x, z]) => `1 72 ${x} -32 ${z} 1 0 0 0 1 0 0 0 1 3003.dat`),
  '0 FILE Speeder.ldr',
  '1 4 200 -8 0 1 0 0 0 1 0 0 0 1 3032.dat',
  ...[160, 200, 240].flatMap(x => [-20, 20].map(z => `1 4 ${x} -32 ${z} 1 0 0 0 1 0 0 0 1 3003.dat`)),
  ...[-20, 20].map(z => `1 1 200 -56 ${z} 1 0 0 0 1 0 0 0 1 3003.dat`),
  '1 1 240 -56 0 1 0 0 0 1 0 0 0 1 3039.dat',
].join('\n');

const bricksOf = (): ParsedBrick[] => parseLDrawDocument(MPD).bricks;
const hints = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Speeder Demo', namespace: 'demo_speeder',
  components: [{ select: { submodel: 'Speeder' }, kind: 'plane' }], ...over,
});
const parsed = (raw: unknown): ByomHints => {
  const r = parseByomHints(raw);
  if (!r.ok) throw new Error(`expected valid hints: ${r.errors.join(' | ')}`);
  return r.hints;
};
const errorsOf = (raw: unknown): string[] => { const r = parseByomHints(raw); return r.ok ? [] : r.errors; };

describe('byom-hints :: parse', () => {
  it('fills the defaults and keeps what the creator wrote', () => {
    const h = parsed(hints({ components: [{ select: { submodel: 'Speeder' }, kind: 'plane', facing: '-x', seats: 2 }] }));
    expect(h).toMatchObject({ title: 'Speeder Demo', namespace: 'demo_speeder', features: [], scale: 'auto', figures: 'keep', doors: 'detect', seats: 'detect' });
    expect(h.components).toEqual([{ select: { submodel: 'Speeder' }, kind: 'plane', facing: '-x', seats: 2 }]);
  });

  it('refuses a malformed namespace, an empty title and an unknown key, naming each', () => {
    expect(errorsOf(hints({ namespace: 'Demo-Speeder' }))).toEqual([expect.stringMatching(/namespace.*\[a-z0-9_\]\{3,32\}/)]);
    expect(errorsOf(hints({ title: '  ' }))).toEqual([expect.stringMatching(/title/)]);
    expect(errorsOf(hints({ component: [] }))).toEqual([expect.stringMatching(/unknown key "component"/)]);
    expect(errorsOf('nope')).toEqual([expect.stringMatching(/must be a JSON object/)]);
  });

  it('refuses a bad kind, facing, seat count or selector, one message per fault with its path', () => {
    const bad = (c: Record<string, unknown>): string[] => errorsOf(hints({ components: [{ select: { submodel: 'Speeder' }, kind: 'plane', ...c }] }));
    expect(bad({ kind: 'spaceship' })).toEqual([expect.stringMatching(/components\[0\]\.kind.*spaceship/)]);
    expect(bad({ facing: 'north' })).toEqual([expect.stringMatching(/components\[0\]\.facing.*north/)]);
    expect(bad({ seats: 3 })).toEqual([expect.stringMatching(/components\[0\]\.seats.*1, 2 or 4/)]);
    expect(bad({ select: {} })).toEqual([expect.stringMatching(/components\[0\]\.select.*exactly one of/)]);
    expect(bad({ select: { box: [[0, 0, 0], [-1, 5, 5]] } })).toEqual([expect.stringMatching(/components\[0\]\.select\.box.*min/)]);
    expect(bad({ select: { brickIndices: [1.5] } })).toEqual([expect.stringMatching(/components\[0\]\.select\.brickIndices/)]);
  });

  it('says plainly which kinds the converter cannot build yet instead of dropping them', () => {
    const kind = (k: string): string[] => errorsOf(hints({ components: [{ select: { submodel: 'Speeder' }, kind: k }] }));
    expect(kind('coaster-car')).toEqual([expect.stringMatching(/coaster-car.*not supported yet/)]);
    expect(kind('flyer')).toEqual([expect.stringMatching(/flyer.*not supported yet/)]);
    expect(errorsOf(hints({ figures: 'brick-figure' }))).toEqual([expect.stringMatching(/brick-figure.*not supported yet/)]);
  });

  it('validates the mesh-model features it only carries (applied by the legolizer)', () => {
    expect(parsed(hints({ features: [{ kind: 'door', at: [0, 0, 0], yaw: 90 }] })).features).toHaveLength(1);
    expect(errorsOf(hints({ features: [{ kind: 'sofa', at: [0, 0, 0], yaw: 0 }] }))).toEqual([expect.stringMatching(/features\[0\]\.kind/)]);
    expect(errorsOf(hints({ features: [{ kind: 'door', at: [0, 0], yaw: 0 }] }))).toEqual([expect.stringMatching(/features\[0\]\.at/)]);
  });

  it('finds a hints file beside the model by its stem', () => {
    expect(byomHintsPathFor('C:/models/Speeder.mpd')).toBe('C:/models/Speeder.byom.json');
    expect(byomHintsPathFor('C:\\models\\my.model.ldr')).toBe('C:\\models\\my.model.byom.json');
    expect(byomHintsPathFor('Speeder')).toBe('Speeder.byom.json');
  });
});

describe('byom-hints :: resolve', () => {
  it('an unresolved selector is an error naming it and listing what the file has', () => {
    const r = resolveByomHints(parsed(hints({ components: [{ select: { submodel: 'Cruiser' }, kind: 'plane' }] })), bricksOf());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/components\[0\].*submodel "Cruiser".*no placements/);
      expect(r.errors[0]).toMatch(/landscape.*speeder/i);
    }
  });

  it('resolves a sub-model by name (case, path and extension insensitive), an index list and a box', () => {
    const bricks = bricksOf();
    const speeder = bricks.filter(b => b.sourcePath?.includes('speeder.ldr'));
    expect(speeder).toHaveLength(10);
    const sel = (select: unknown): number => {
      const r = resolveByomHints(parsed(hints({ components: [{ select, kind: 'car' }] })), bricks);
      if (!r.ok) throw new Error(r.errors.join(' | '));
      return r.resolved.components[0]!.bricks.length;
    };
    expect(sel({ submodel: 'speeder' })).toBe(10);
    expect(sel({ submodel: 'SPEEDER.LDR' })).toBe(10);
    expect(sel({ brickIndices: [0, 1, 2] })).toBe(3);
    expect(sel({ box: [[100, -100, -50], [300, 0, 50]] })).toBe(10);
  });

  it('refuses a selector that matches nothing, an index past the end and one brick in two components', () => {
    const bricks = bricksOf();
    const errs = (components: unknown[]): string[] => { const r = resolveByomHints(parsed(hints({ components })), bricks); return r.ok ? [] : r.errors; };
    expect(errs([{ select: { box: [[5000, 0, 0], [5100, 10, 10]] }, kind: 'car' }])).toEqual([expect.stringMatching(/components\[0\].*box.*no placements/)]);
    expect(errs([{ select: { brickIndices: [0, 9999] }, kind: 'car' }])).toEqual([expect.stringMatching(/brickIndices.*9999.*only/)]);
    expect(errs([{ select: { submodel: 'Speeder' }, kind: 'car' }, { select: { box: [[100, -100, -50], [300, 0, 50]] }, kind: 'boat' }]))
      .toEqual([expect.stringMatching(/components\[1\].*already.*components\[0\]/)]);
  });
});

/** Build the MPD through the real pipeline, in explicit mode (as a BYOM export is). */
async function build(h: Record<string, unknown> | undefined, over: Partial<SchemWorkerInput> = {}): Promise<{ files: Map<string, Uint8Array>; components: string[]; warnings: string[] }> {
  seedBoxParts({ '3039': ['0 Slope Brick 45  2 x  2', ...box6(-20, 20, 0, 24, -30, 10)].join('\n') });
  const result = await runSchemPipeline({
    source: { kind: 'bricks', bricks: bricksOf(), colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
    format: 'mcaddon', packStem: 'SpeederDemo', packLabel: 'Speeder Demo', profile: 'default', lightFill: false, shapes: false,
    vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced', modelScale: 1,
    pipelineStamp: FIXED_STAMP, sourceProvenance: null, packProfile: EXPLICIT,
    ...(h ? { byomHints: parsed(h) } : {}), ...over,
  });
  return { files: await unzipAll(result.bytes!), components: result.mcpack?.components ?? [], warnings: result.mcpack?.warnings ?? [] };
}
/** The pack's component report names a vehicle `<label> (car|plane|boat)`; the shell and figures use other kinds. */
const isVehicle = (c: string): boolean => /\((car|plane|boat)\)$/.test(c);
const entity = (files: Map<string, Uint8Array>, suffix: string): any => {
  const name = [...files.keys()].find(n => n.includes('_BP/entities/') && n.endsWith(suffix));
  return name ? JSON.parse(text(files.get(name)!)) : undefined;
};
const vehiclesScript = (files: Map<string, Uint8Array>): string => text(files.get([...files.keys()].find(n => n.endsWith('scripts/vehicles.js'))!) ?? new Uint8Array());

describe('byom-hints :: the pipeline applies them', () => {
  it('the sub-model "Speeder" hinted plane ships as a scripted flyer', async () => {
    // Control: in explicit mode the same model with no hint stays static, whatever its title and sub-model names say.
    const none = await build(undefined);
    expect(none.components.filter(isVehicle)).toEqual([]);
    const b = await build(hints());
    expect(b.components.filter(isVehicle)).toEqual(['Speeder Demo (plane)']);
    // The hovering word in the title/sub-model name ("Speeder") must not turn the hinted plane into a hover craft.
    expect(vehiclesScript(b.files)).toMatch(/"mode":\s*"plane"/);
    expect(vehiclesScript(b.files)).not.toMatch(/"mode":\s*"hover"/);
    expect(entity(b.files, '_plane_1.json')['minecraft:entity'].components['minecraft:type_family'].family).toContain('plane');
  }, 180_000);

  it('a hinted hover craft is hull geometry that floats, a hinted boat does not hover', async () => {
    const hover = await build(hints({ title: 'Quiet Barge', components: [{ select: { submodel: 'Speeder' }, kind: 'hover' }] }));
    expect(vehiclesScript(hover.files)).toMatch(/"mode":\s*"hover"/);
    const boat = await build(hints({ title: 'Hover Barge', components: [{ select: { submodel: 'Speeder' }, kind: 'boat' }] }));
    expect(vehiclesScript(boat.files)).toMatch(/"mode":\s*"boat"/);
    expect(vehiclesScript(boat.files)).not.toMatch(/"mode":\s*"hover"/);
  }, 240_000);

  it('a hinted car ships the seat count the hint says', async () => {
    const car = (seats?: number) => build(hints({ components: [{ select: { submodel: 'Speeder' }, kind: 'car', ...(seats ? { seats } : {}) }] }));
    const two = await car(2), four = await car(4);
    const seatCount = (b: Awaited<ReturnType<typeof build>>): number => entity(b.files, '_car_1.json')['minecraft:entity'].components['minecraft:rideable'].seat_count;
    expect(seatCount(two)).toBe(2);
    expect(seatCount(four)).toBe(4);
  }, 240_000);

  it('a nose the hint gives is the nose the vehicle ships with, over the one it would have measured', async () => {
    const nose = async (facing: string | undefined): Promise<{ nose: string; source: string }> => {
      const b = await build(hints({ components: [{ select: { submodel: 'Speeder' }, kind: 'car', ...(facing ? { facing } : {}) }] }));
      const diag = JSON.parse(text(b.files.get([...b.files.keys()].find(n => n.endsWith('craftmatic-diagnostics.json'))!)!));
      return diag.entities[Object.keys(diag.entities).find(k => k.endsWith('_car_1'))!].facing;
    };
    expect(await nose('+x')).toMatchObject({ nose: '+x', source: 'explicit' });
    expect(await nose('-z')).toMatchObject({ nose: '-z', source: 'explicit' });
    // Control: with no nose hint the compiler measures it, so the hint is what made the difference.
    expect((await nose(undefined)).source).not.toBe('explicit');
  }, 240_000);

  it('an unresolved selector stops the export with the error naming it', async () => {
    await expect(build(hints({ components: [{ select: { submodel: 'Cruiser' }, kind: 'plane' }] }))).rejects.toThrow(ByomHintsError);
    await expect(build(hints({ components: [{ select: { submodel: 'Cruiser' }, kind: 'plane' }] }))).rejects.toThrow(/submodel "Cruiser"/);
  }, 120_000);

  it('hints without explicit mode are refused: a title could still decide beside them', async () => {
    await expect(build(hints(), { packProfile: undefined })).rejects.toThrow(/explicit mode.*explicitOnly/);
  }, 120_000);
});

describe('byom-hints :: the creator decides what is a door and a seat', () => {
  /** The landscape with a door and a seat in each of two sub-models, "Front" and "Back". */
  const ROOMS = [
    MPD.replace('1 16 0 0 0 1 0 0 0 1 0 0 0 1 Speeder.ldr', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 Front.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 Back.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 Speeder.ldr'),
    '0 FILE Front.ldr', '1 4 -40 -8 -40 1 0 0 0 1 0 0 0 1 60623.dat', '1 4 40 -8 -40 1 0 0 0 1 0 0 0 1 4079.dat',
    '0 FILE Back.ldr', '1 4 -40 -8 40 1 0 0 0 1 0 0 0 1 60623.dat', '1 4 40 -8 40 1 0 0 0 1 0 0 0 1 4079.dat',
  ].join('\n');
  const EXTRA = {
    '60623': ['0 Door  1 x  4 x  6 with 4 Panes and Stud Handle', ...box6(-4, 67, 3, 137, -3, 3)].join('\n'),
    '4079': ['0 Minifig Seat  2 x  2', ...box6(-20, 20, -40, 8, -20, 25)].join('\n'),
  };
  /** What the pack's own interactivity report says it found, by class (door / seat). */
  const found = async (extra: Record<string, unknown>): Promise<Record<string, number>> => {
    seedBoxParts({ ...EXTRA, '3039': PARTS['3039']! });
    const result = await runSchemPipeline({
      source: { kind: 'bricks', bricks: parseLDrawDocument(ROOMS).bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
      format: 'mcaddon', packStem: 'Rooms', packLabel: 'Rooms', profile: 'default', lightFill: false, shapes: false, vehicleMode: 'auto', vehicleFacing: 'auto',
      entityQuality: 'balanced', modelScale: 1, pipelineStamp: FIXED_STAMP, sourceProvenance: null, packProfile: EXPLICIT, byomHints: parsed(hints({ components: [], ...extra })),
    });
    const files = await unzipAll(result.bytes!);
    const diag = JSON.parse(text(files.get([...files.keys()].find(n => n.endsWith('craftmatic-diagnostics.json'))!)!));
    return diag.interactivity.found;
  };

  it('with no rule the detectors find the door and the seat in both rooms (control)', async () => {
    expect(await found({})).toEqual({ door: 2, seat: 2 });
  }, 120_000);

  it('the rule "none" ships no door and no seat', async () => {
    expect(await found({ doors: 'none', seats: 'none' })).toEqual({});
  }, 120_000);

  it('a selector rule ships only the doors and seats on the selected parts', async () => {
    expect(await found({ doors: { select: { submodel: 'Front' } }, seats: { select: { submodel: 'Back' } } })).toEqual({ door: 1, seat: 1 });
    expect(await found({ doors: { select: { submodel: 'Back' } }, seats: 'none' })).toEqual({ door: 1 });
  }, 120_000);

  it('a rule whose selector matches nothing is refused naming it', async () => {
    await expect(found({ doors: { select: { submodel: 'Attic' } } })).rejects.toThrow(/doors\.select: submodel "Attic" matches no placements/);
  }, 120_000);
});

describe('byom-hints :: figures', () => {
  it('"figures": "none" keeps the source figures as bricks instead of spawning them', async () => {
    const entities = async (figures: 'keep' | 'none'): Promise<number> => {
      seedBoxParts();
      const result = await runSchemPipeline({
        source: { kind: 'bricks', bricks: parseLDrawDocument(readFileSync('test/fixtures/nimbus-fixture.ldr', 'utf8')).bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
        format: 'mcaddon', packStem: 'Nimbus', packLabel: 'Cloud Scene', profile: 'default', lightFill: false, shapes: false, vehicleMode: 'auto', vehicleFacing: 'auto',
        entityQuality: 'balanced', modelScale: 1, pipelineStamp: FIXED_STAMP, sourceProvenance: null, packProfile: EXPLICIT, byomHints: parsed(hints({ components: [], figures })),
      });
      return [...(await unzipAll(result.bytes!)).keys()].filter(n => n.includes('_BP/entities/')).length;
    };
    const keep = await entities('keep'), none = await entities('none');
    expect(none).toBeLessThan(keep);
  }, 120_000);
});
