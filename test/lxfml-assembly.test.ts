import { describe, expect, it } from 'vitest';
import {
  applyMove, assembleLxfml, findAssemblyMoves, quatToMatrix, readPartOrigins, seatingOf,
} from '../web/src/engine/lxfml-assembly.js';

/**
 * LEGO's instruction LXFML can store each sub-build where it is BUILT rather
 * than where it ends up, so a set reads as several structures standing apart —
 * 76417 Gringotts exported as scattered blobs because of it. The placement is
 * in `<Explode>`, whose frame pair carries whole sub-builds as well as the
 * small per-part lifts that make it easy to overlook.
 *
 * The guard that matters is SEATING: a move is applied only when the group it
 * carries comes to rest on the model. Without it an exploded view — a group
 * lifted into thin air for a diagram — would be mistaken for an assembly step
 * and would wreck a model that was fine. Every refusal below is load-bearing.
 */

/** An LXFML with `parts` at given origins, and an Explode carrying some of them. */
function lxfml(parts: Array<{ ref: string; at: [number, number, number] }>, explodes: string[]): string {
  const bricks = parts.map(p => `
    <Brick refID="${p.ref}" designID="3001">
      <Part refID="${p.ref}" designID="3001" materials="1">
        <Bone refID="${p.ref}" transformation="1,0,0,0,1,0,0,0,1,${p.at.join(',')}"/>
      </Part>
    </Brick>`).join('');
  return `<?xml version="1.0"?><LXFML><Bricks>${bricks}</Bricks><BuildingInstruction>${explodes.join('')}</BuildingInstruction></LXFML>`;
}

const explode = (refId: string, from: number[], to: number[], refs: string[], rot = '0,0,0,1', erot = '0,0,0,1'): string =>
  `<Explode refID="${refId}" position="${from.join(',')}" rotation="${rot}" explosionPosition="${to.join(',')}" explosionRotation="${erot}"><Parts partRefs="${refs.join(',')}"/></Explode>`;

/** A 12-part block sitting on the ground, and a 12-part block parked 100 away. */
function laidOutModel(): { xml: string; parked: string[] } {
  const parts: Array<{ ref: string; at: [number, number, number] }> = [];
  for (let i = 0; i < 12; i++) parts.push({ ref: `${i}`, at: [i % 4, Math.floor(i / 4) * 2, 0] });
  const parked: string[] = [];
  for (let i = 0; i < 12; i++) {
    const ref = `${100 + i}`;
    parked.push(ref);
    parts.push({ ref, at: [100 + (i % 4), Math.floor(i / 4) * 2, 0] });
  }
  return { xml: '', parked, ...{ xml: lxfml(parts, []) } };
}

describe('findAssemblyMoves', () => {
  it('reads the frame pair and the parts a move carries', () => {
    const { xml, parked } = laidOutModel();
    const withMove = xml.replace('</LXFML>', `<BuildingInstruction>${explode('7', [100, 0, 0], [0, 4, 0], parked)}</BuildingInstruction></LXFML>`);
    const moves = findAssemblyMoves(withMove, { minParts: 10, minDistanceUnits: 15 });
    expect(moves).toHaveLength(1);
    expect(moves[0]!.refId).toBe('7');
    expect(moves[0]!.parts).toHaveLength(12);
    expect(moves[0]!.distance).toBeCloseTo(Math.hypot(100, 4), 6);
  });

  it('ignores the small per-part lifts that make up most of the file', () => {
    const { xml, parked } = laidOutModel();
    const tiny = xml.replace('</LXFML>', `<BuildingInstruction>${explode('9', [0, 0, 0], [0, 2, 0], parked)}</BuildingInstruction></LXFML>`);
    expect(findAssemblyMoves(tiny, { minParts: 10, minDistanceUnits: 15 })).toHaveLength(0);
  });

  it('keeps one copy when the file repeats a move per step or view', () => {
    const { xml, parked } = laidOutModel();
    const twice = xml.replace('</LXFML>',
      `<BuildingInstruction>${explode('7', [100, 0, 0], [0, 4, 0], parked)}${explode('8', [100, 0, 0], [0, 4, 0], parked)}</BuildingInstruction></LXFML>`);
    expect(findAssemblyMoves(twice, { minParts: 10, minDistanceUnits: 15 })).toHaveLength(1);
  });
});

describe('applyMove', () => {
  it('rotates about the move\'s own frame, then translates', () => {
    // A quarter turn about Y: the offset +X from the frame becomes -Z.
    const q = Math.SQRT1_2;
    const move = {
      refId: '1', parts: [], fromPos: [0, 0, 0] as [number, number, number], toPos: [10, 0, 0] as [number, number, number],
      fromRot: [0, 0, 0, 1] as [number, number, number, number], toRot: [0, q, 0, q] as [number, number, number, number], distance: 10,
    };
    const out = applyMove(move, [1, 0, 0]);
    expect(out[0]).toBeCloseTo(10, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(-1, 6);
  });

  it('builds a rotation matrix from a quaternion', () => {
    expect(quatToMatrix([0, 0, 0, 1])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });
});

describe('seatingOf and assembleLxfml', () => {
  it('applies a move that lands the group ON the model', () => {
    const { xml, parked } = laidOutModel();
    // The standing block tops out at y = 4; bring the parked one to rest there.
    const doc = xml.replace('</LXFML>', `<BuildingInstruction>${explode('7', [100, 0, 0], [0, 6, 0], parked)}</BuildingInstruction></LXFML>`);
    const result = assembleLxfml(doc, { minParts: 10, minDistanceUnits: 15, seatToleranceUnits: 2 });
    expect(result.applied).toHaveLength(1);
    const after = readPartOrigins(result.xml);
    // Everything now stands over the original footprint, not 100 away.
    const xs = [...after.values()].map(p => p[0]);
    expect(Math.max(...xs)).toBeLessThan(10);
    // ...and the XML still parses back to the same number of parts.
    expect(after.size).toBe(24);
  });

  it('REFUSES a move that leaves the group in thin air — an exploded view', () => {
    const { xml, parked } = laidOutModel();
    // Same group, carried high above everything: a diagram, not an assembly.
    const doc = xml.replace('</LXFML>', `<BuildingInstruction>${explode('7', [100, 0, 0], [0, 80, 0], parked)}</BuildingInstruction></LXFML>`);
    const result = assembleLxfml(doc, { minParts: 10, minDistanceUnits: 15, seatToleranceUnits: 2 });
    expect(result.applied).toHaveLength(0);
    expect(result.notes.join(' ')).toMatch(/refused/);
    expect(result.xml).toBe(doc);
  });

  it('REFUSES a move that lands over nothing at all', () => {
    const { xml, parked } = laidOutModel();
    const doc = xml.replace('</LXFML>', `<BuildingInstruction>${explode('7', [100, 0, 0], [500, 0, 0], parked)}</BuildingInstruction></LXFML>`);
    const result = assembleLxfml(doc, { minParts: 10, minDistanceUnits: 15 });
    expect(result.applied).toHaveLength(0);
    expect(result.notes.join(' ')).toMatch(/lands over nothing/);
  });

  it('places a sub-build ONCE, however many entries the file gives it', () => {
    // Every Explode frame is written against the ORIGINAL positions, so taking
    // a second one compounds two absolute transforms and throws the group off.
    const { xml, parked } = laidOutModel();
    const doc = xml.replace('</LXFML>',
      `<BuildingInstruction>${explode('7', [100, 0, 0], [0, 6, 0], parked)}${explode('8', [100, 0, 0], [0, 7, 0], parked)}</BuildingInstruction></LXFML>`);
    const result = assembleLxfml(doc, { minParts: 10, minDistanceUnits: 15, seatToleranceUnits: 2 });
    expect(result.applied).toHaveLength(1);
  });

  it('leaves a file with no candidate moves untouched', () => {
    const { xml } = laidOutModel();
    const result = assembleLxfml(xml);
    expect(result.applied).toHaveLength(0);
    expect(result.xml).toBe(xml);
    expect(result.notes.join(' ')).toMatch(/no candidate/);
  });

  it('measures the gap it would leave, so a near miss is visible', () => {
    const { xml, parked } = laidOutModel();
    const doc = xml.replace('</LXFML>', `<BuildingInstruction>${explode('7', [100, 0, 0], [0, 20, 0], parked)}</BuildingInstruction></LXFML>`);
    const move = findAssemblyMoves(doc, { minParts: 10, minDistanceUnits: 15 })[0]!;
    const seat = seatingOf(move, readPartOrigins(doc), { seatToleranceUnits: 2 });
    expect(seat.seats).toBe(false);
    expect(seat.overlaps).toBe(true);
    expect(seat.gapUnits).toBeGreaterThan(2);
  });
});

// ── Part orientations follow their group (76417, where the corpus exists) ────
// The bone's nine rotation values are stored COLUMN-major. A move must turn
// each part as R' = M.R; applying M to the stored values scattered 76417's
// bank on the device (2026-09-24). Relative orientation between any two parts
// of a rigid group is preserved only by the right convention.
import { existsSync, readFileSync } from 'node:fs';
const GRINGOTTS = 'C:/git/clego/lego_sets/DBIX/76417/VX1035766_sm01.lxfml';
describe('assembled parts keep their orientation relative to their group', () => {
  it.skipIf(!existsSync(GRINGOTTS))('76417: every moved pair keeps its relative rotation', () => {
    const xml = readFileSync(GRINGOTTS, 'utf8');
    const out = assembleLxfml(xml).xml;
    const rots = (text: string): Map<string, number[]> => {
      const m = new Map<string, number[]>();
      for (const p of text.matchAll(/<Part\b[^>]*\brefID="(\d+)"[^>]*>[\s\S]*?transformation="([^"]*)"/g)) {
        const v = p[2]!.split(',').map(Number);
        // column-major storage -> row-major R
        m.set(p[1]!, [v[0]!, v[3]!, v[6]!, v[1]!, v[4]!, v[7]!, v[2]!, v[5]!, v[8]!]);
      }
      return m;
    };
    const before = rots(xml), after = rots(out);
    // One rigid group: the 2,946-part bank move.
    const bank = findAssemblyMoves(xml).filter(m => m.parts.length > 2000).sort((a, b) => b.parts.length - a.parts.length)[0]!;
    const moved = bank.parts.filter(k => before.has(k) && after.has(k));
    expect(moved.length).toBeGreaterThan(2000);
    const rel = (a: number[], b: number[]): number[] => {
      // a^T . b
      const out: number[] = [];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out.push(a[i]! * b[j]! + a[3 + i]! * b[3 + j]! + a[6 + i]! * b[6 + j]!);
      return out;
    };
    const anchor = moved[0]!;
    let worst = 0;
    for (const k of moved.slice(1, 400)) {
      const r0 = rel(before.get(anchor)!, before.get(k)!), r1 = rel(after.get(anchor)!, after.get(k)!);
      for (let i = 0; i < 9; i++) worst = Math.max(worst, Math.abs(r0[i]! - r1[i]!));
    }
    expect(worst).toBeLessThan(1e-6);
  });
});
