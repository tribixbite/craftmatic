import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coasterTrackProfile, extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.js';
import {
  applyMeasuredBound, buildLxfPlacements,
  validatePartAlign, validateMeasuredAlign, validateTable,
  type LxfPartRecord, type LxfAlignmentTable, type LxfMeasuredTable,
} from '../web/src/engine/lxf-parser.js';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';

/**
 * 76417 Gringotts ships a vault-cart rail of nine pieces and routed NONE of
 * them, for two compounding reasons that both look like "the set has no track".
 *
 * The file names the curve `bl_80566.dat` — BrickLink's copy of design 80566,
 * same part, different mesh and different origin — so `partStem` gave
 * `bl_80566`, no profile matched, and seven of the nine pieces were invisible
 * to routing. And design 80566 has no LDD→LDraw alignment row, so each
 * quarter of a spiral carries a different rotation and the missing `R·e`
 * displaced every one of them differently.
 *
 * Fixing only the first leaves the pieces visible and still unjoined, which is
 * why both halves are pinned here.
 */

describe('BrickLink frame aliases', () => {
  it('resolves bl_80566 to the 80566 profile', () => {
    const p = coasterTrackProfile('bl_80566.dat');
    expect(p, 'bl_80566 must find the 80566 profile').toBeDefined();
    expect(p!.partId).toBe('80566');
  });

  it('shifts the samples into the BrickLink mesh frame', () => {
    // Both DATs bound 274.0 x 98.0 x 274.0 LDU, so the two frames differ by a
    // pure translation; the alias must apply it or the running line is sampled
    // in the wrong place and nothing joins.
    const plain = coasterTrackProfile('80566.dat')!;
    const alias = coasterTrackProfile('bl_80566.dat')!;
    expect(alias.samples).toHaveLength(plain.samples.length);
    const delta = [0, 1, 2].map(i => alias.samples[0]![i]! - plain.samples[0]![i]!);
    expect(delta[0]).toBeCloseTo(-137, 3);
    expect(delta[1]).toBeCloseTo(-80, 3);
    expect(delta[2]).toBeCloseTo(-420.634, 3);
    // The shift is rigid: every sample moves by the same vector.
    for (let i = 0; i < plain.samples.length; i++) {
      for (let a = 0; a < 3; a++) {
        expect(alias.samples[i]![a]! - plain.samples[i]![a]!).toBeCloseTo(delta[a]!, 6);
      }
    }
  });

  it('leaves an unknown id unresolved', () => {
    expect(coasterTrackProfile('bl_99999.dat')).toBeUndefined();
    expect(coasterTrackProfile('3001.dat')).toBeUndefined();
  });
});

describe.skipIf(!existsSync('web/public/ldd-part-map.json'))('the shipped part map', () => {
  it('carries the coaster moulds Studio names only in ldraw_lxfv56.xml', () => {
    // `ldraw.xml` names none of these; `ldraw_lxfv56.xml` names all five, and
    // gen-ldd-part-map.py fills from it. Without them a coaster built from an
    // LXFML places each piece at its raw LDD origin, and since the pieces of a
    // spiral all carry different rotations the run stops being a run.
    const map = JSON.parse(readFileSync('web/public/ldd-part-map.json', 'utf8')) as Record<string, unknown[]>;
    const entries = (map['entries'] ?? map) as Record<string, unknown[]>;
    const meas = JSON.parse(readFileSync('web/public/ldd-measured-align.json', 'utf8')) as Record<string, unknown>;
    const measEntries = (meas['entries'] ?? meas) as Record<string, unknown>;
    // Either table may carry it — the generator deliberately leaves a design
    // the learner already measured (80562) alone rather than overriding a vote
    // over real sets with an authored row.
    for (const design of ['25059', '26560', '26561', '80562', '80566']) {
      expect(
        entries[design] ?? measEntries[design],
        `${design} must be covered by the part map or the measured table`,
      ).toBeDefined();
    }
    // 80566's Studio row names bl_80566.dat, which the viewer cannot draw; the
    // generator re-expresses it on the upstream part.
    expect(entries['80566']![0]).toBe('80566.dat');
  });
});

/**
 * The end-to-end gate. Skipped where the reference corpus is absent; the
 * condition is evaluated at collection time, so it is a plain `existsSync`.
 */
const LXFML = 'C:/git/clego/lego_sets/DBIX/76417/VX1035766_sm01.lxfml';
const PART_MAP = 'web/public/ldd-part-map.json';
describe.skipIf(!existsSync(LXFML) || !existsSync(PART_MAP))('76417 Gringotts vault rail', () => {
  it('routes its nine pieces as one run', () => {
    const table = validateTable(
      JSON.parse(readFileSync(PART_MAP, 'utf8')), PART_MAP, validatePartAlign,
    ) as LxfAlignmentTable;
    const measured = applyMeasuredBound(validateTable(
      JSON.parse(readFileSync('web/public/ldd-measured-align.json', 'utf8')),
      'web/public/ldd-measured-align.json', validateMeasuredAlign,
    ) as LxfMeasuredTable);

    const xml = readFileSync(LXFML, 'latin1');
    const attr = (h: string, n: string): string | undefined => new RegExp(`\\b${n}="([^"]*)"`).exec(h)?.[1];
    const records: LxfPartRecord[] = [];
    for (const brick of xml.matchAll(/<Brick\b([^>]*)>([\s\S]*?)<\/Brick>/g)) {
      const brickDesign = attr(brick[1] ?? '', 'designID');
      for (const part of (brick[2] ?? '').matchAll(/<Part\b([^>]*)>([\s\S]*?)<\/Part>|<Part\b([^>]*)\/>/g)) {
        const head = part[1] ?? part[3] ?? '';
        const bones = [...(part[2] ?? '').matchAll(/<Bone\b([^>]*?)\/?>/g)];
        records.push({
          designID: (attr(head, 'designID') ?? brickDesign ?? '3001').split(';')[0]!.trim(),
          materialId: parseInt((attr(head, 'materials') ?? '').split(',')[0]!, 10) || 194,
          transformation: attr(bones[0]?.[1] ?? '', 'transformation') ?? '',
          boneCount: bones.length,
        });
      }
    }
    const { bricks } = buildLxfPlacements(records, table, measured);
    const track = bricks.filter(b => coasterTrackProfile(b.part));
    expect(track, 'the rail is 7 curves + 1 straight + 1 landing').toHaveLength(9);

    const { routes } = extractCoasterTrackRoutes(bricks);
    expect(routes, 'all nine pieces must form ONE run').toHaveLength(1);
    let length = 0;
    const points = routes[0]!.points ?? [];
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(
        points[i]![0] - points[i - 1]![0],
        points[i]![1] - points[i - 1]![1],
        points[i]![2] - points[i - 1]![2],
      );
    }
    // 154.8 studs measured; the run is open at both free ends by design.
    expect(length / 20).toBeGreaterThan(150);
    expect(length / 20).toBeLessThan(160);
  });
});

describe('the parser still reads a plain model', () => {
  it('parses a type-1 line naming a BrickLink part', () => {
    const bricks = parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 bl_80566.dat');
    expect(bricks).toHaveLength(1);
    expect(bricks[0]!.part).toBe('bl_80566.dat');
  });
});
