/**
 * Shared builders for the PackProfile tests (X-02, X-17): the nimbus stand-in
 * (`test/fixtures/nimbus-fixture.ldr`, a real LDraw model with a flyer, a ride
 * and a figure) through the REAL shared pipeline with its parts SEEDED as
 * boxes, so no library and no network are needed and CI runs it.
 */
import { readFileSync } from 'node:fs';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { seedDatTexts } from '../web/src/engine/ldraw-geometry.js';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.js';
import type { PackProfile } from '../web/src/engine/pack-profile.js';
import type { PipelineStamp } from '../web/src/engine/pipeline-version.js';
import { createHash } from 'node:crypto';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';

/** A fixed, stamped pipeline identity, so a build differs only by what the test changes. */
export const FIXED_STAMP: PipelineStamp = {
  kind: 'stamped', hash: '0123456789ab', files: 40, commit: '1b74f4ee', date: '2026-09-21', head: '1b74f4ee', headDate: '2026-09-21',
  dirty: false, dirtyFiles: [], treeDirty: false, shallow: false, computedAt: '2026-09-21T14:30:59.000Z',
};

const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
/** Box stand-ins at the library's own extents (the same table test/nimbus-fixture.test.ts seeds). */
const PARTS: Record<string, string> = {
  '3958': ['0 Plate  6 x  6', ...box6(-60, 60, 0, 8, -60, 60)].join('\n'),
  '3003': ['0 Brick  2 x  2', ...box6(-20, 20, 0, 24, -20, 20)].join('\n'),
  '3004': ['0 Brick  1 x  2', ...box6(-20, 20, 0, 24, -10, 10)].join('\n'),
  '3039': ['0 Slope Brick 45  2 x  2', ...box6(-20, 20, 0, 24, -30, 10)].join('\n'),
  '3032': ['0 Plate  4 x  6', ...box6(-60, 60, 0, 8, -40, 40)].join('\n'),
  '3021': ['0 Plate  2 x  3', ...box6(-30, 30, 0, 8, -20, 20)].join('\n'),
  '54200': ['0 Slope Brick 31  1 x  1 x  0.667', ...box6(-10, 10, -15.6, 0, -10, 10)].join('\n'),
  '3020': ['0 Plate  2 x  4', ...box6(-40, 40, 0, 8, -20, 20)].join('\n'),
  '3024': ['0 Plate  1 x  1', ...box6(-10, 10, 0, 8, -10, 10)].join('\n'),
  '30374': ['0 Bar  4L Lightsaber Blade', ...box6(-4, 4, 0, 80, -4, 4)].join('\n'),
  '973': ['0 Minifig Torso', ...box6(-19, 19, -12, 32, -10, 10)].join('\n'),
  '3626c': ['0 Minifig Head with Closed Hollow Stud', ...box6(-13, 13, 0, 24, -13, 13)].join('\n'),
  '3901': ['0 Minifig Hair Male', ...box6(-15, 15, -7, 17, -15, 16)].join('\n'),
  '3815': ['0 Minifig Hips', ...box6(-18, 18, -11, 21, -10, 10)].join('\n'),
  '3816': ['0 Minifig Leg Right', ...box6(-19.5, -1.5, -9, 28, -11, 9)].join('\n'),
  '3817': ['0 Minifig Leg Left', ...box6(1.5, 19.5, -9, 28, -11, 9)].join('\n'),
  '3818': ['0 Minifig Arm Right', ...box6(-8, 8, -4, 22, -6, 6)].join('\n'),
  '3819': ['0 Minifig Arm Left', ...box6(-8, 8, -4, 22, -6, 6)].join('\n'),
  '3820': ['0 Minifig Hand', ...box6(-6, 6, -4, 10, -6, 6)].join('\n'),
};

export const NIMBUS_LABEL = 'Dragon Ball: Shenron & Goku (11390-1)';
export const NIMBUS_STEM = 'DragonBallShenron';

/** Build the stand-in pack; `packProfile` is the only thing a profile test varies. */
export async function buildNimbusPack(packProfile?: PackProfile, label = NIMBUS_LABEL): Promise<Uint8Array> {
  seedDatTexts(Object.entries(PARTS).map(([id, t]) => [`${id}.dat`, t] as const));
  const doc = parseLDrawDocument(readFileSync('test/fixtures/nimbus-fixture.ldr', 'utf8'));
  const result = await runSchemPipeline({
    source: { kind: 'bricks', bricks: doc.bricks, colorSpace: 'ldraw', options: { cellLDU: LDU_PER_BLOCK, maxDim: 700 } },
    format: 'mcaddon', packStem: NIMBUS_STEM, packLabel: label, profile: 'default', lightFill: false, shapes: false,
    vehicleMode: 'auto', vehicleFacing: 'auto', entityQuality: 'balanced', modelScale: 1,
    pipelineStamp: FIXED_STAMP, sourceProvenance: null,
    ...(packProfile ? { packProfile } : {}),
  });
  return result.bytes!;
}

const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Every entry of an archive: name -> bytes. */
export async function unzipAll(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const buffer = toBuffer(bytes);
  const out = new Map<string, Uint8Array>();
  for (const name of listZipEntries(buffer)) out.set(name, new Uint8Array(await extractFile(buffer, name)));
  return out;
}

/** name -> sha256/12 of the content, the form the golden file stores. */
export async function contentHashes(bytes: Uint8Array): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, data] of [...(await unzipAll(bytes))].sort(([a], [b]) => (a < b ? -1 : 1))) out[name] = createHash('sha256').update(data).digest('hex').slice(0, 12);
  return out;
}

export const text = (data: Uint8Array): string => new TextDecoder().decode(data);
