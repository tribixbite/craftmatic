/**
 * A08 (BIZ-05): facade grammars. A9's `FeatureSpec`s on a volume's walls become openings (window and arch intents), relief
 * (buttresses, cornices, pinnacles) and trim in the `IntentLattice`, and the X-10 bricker still builds one connected model.
 */
import { describe, expect, it } from 'vitest';
import { brickLattice } from '../web/src/brickgen/bricker/index.js';
import { buildGrammarLattice } from '../web/src/brickgen/grammar/index.js';
import type { FeatureSet, FeatureSpec, IntentLattice, Massing, MassVolume, Vec2m } from '../web/src/brickgen/types.js';
import { isClean } from '../web/src/brickgen/verify/index.js';

const STYLE = { wallColour: 71, trimColour: 70, roofColour: 72, accentColours: [] };
const rect = (x0: number, z0: number, x1: number, z1: number): Vec2m[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

function massingOf(volumes: MassVolume[]): Massing {
  let w = 0, d = 0, h = 0;
  for (const v of volumes) { for (const [x, z] of v.outer) { w = Math.max(w, x); d = Math.max(d, z); } h = Math.max(h, v.topM + 20); }
  return { volumes, scale: { studsPerMetre: 1, platesPerMetre: 2.5, reason: 'test' }, boundsM: [[0, 0, 0], [w + 8, h, d + 8]] };
}
const body = (outer: Vec2m[], topM: number): MassVolume => ({ id: 'a', outer, holes: [], baseM: 0, topM, roof: { shape: 'flat' }, role: 'body' });
const feature = (kind: FeatureSpec['kind'], over: Partial<FeatureSpec>): FeatureSpec =>
  ({ kind, volume: 'a', edge: 0, atM: [0, 0, 0], sizeM: [1, 1, 0.5], confidence: 0.9, sources: ['t'], ...over });

function build(volumes: MassVolume[], features: FeatureSpec[]): { lattice: IntentLattice; clean: boolean; notes: string[]; parts: number } {
  const { lattice, notes } = buildGrammarLattice(massingOf(volumes), { features, style: STYLE } satisfies FeatureSet);
  const r = brickLattice(lattice);
  return { lattice, clean: isClean(r.report), notes, parts: r.plan.elements.length };
}

/** Connected groups (6-neighbourhood) of cells whose label has `role`, each with its bounding box in studs / plates. */
function openings(l: IntentLattice, role: string): Array<{ w: number; h: number; d: number; cells: number }> {
  const [W, H, D] = l.dims;
  const seen = new Uint8Array(l.cells.length);
  const roleAt = (i: number): boolean => l.cells[i] !== 0 && l.labels[l.cells[i]! - 1]!.role === role;
  const out: Array<{ w: number; h: number; d: number; cells: number }> = [];
  for (let s = 0; s < l.cells.length; s++) {
    if (seen[s] || !roleAt(s)) continue;
    const stack = [s]; seen[s] = 1;
    let x0 = W, x1 = -1, p0 = H, p1 = -1, z0 = D, z1 = -1, n = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W, z = Math.floor(i / W) % D, p = Math.floor(i / (W * D));
      n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); p0 = Math.min(p0, p); p1 = Math.max(p1, p); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      for (const [dx, dp, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const nx = x + dx, np = p + dp, nz = z + dz;
        if (nx < 0 || np < 0 || nz < 0 || nx >= W || np >= H || nz >= D) continue;
        const j = (np * D + nz) * W + nx;
        if (!seen[j] && roleAt(j)) { seen[j] = 1; stack.push(j); }
      }
    }
    out.push({ w: x1 - x0 + 1, h: p1 - p0 + 1, d: z1 - z0 + 1, cells: n });
  }
  return out;
}

describe('brickgen-grammar-facade openings', () => {
  // A 30 x 8 stud body 12 m high; edge 0 runs along x on the north side (z = 0).
  const VOLUME = body(rect(0, 0, 30, 8), 12);

  it('a 3-bay facade with lancet windows leaves 3 openings of the requested size and stays one component', () => {
    // Three lancets 3 m wide and 8 m (20 plates) tall, 10 m apart, standing 3 m up.
    const lancet = feature('lancet', { atM: [15, 3, 0], sizeM: [3, 8, 0.6], count: 3, spacingM: 10 });
    const r = build([VOLUME], [lancet]);
    const o = openings(r.lattice, 'window');
    expect(o).toHaveLength(3);
    for (const k of o) {
      expect(Math.abs(k.w - 3)).toBeLessThanOrEqual(1);
      expect(Math.abs(k.h - 20)).toBeLessThanOrEqual(1);
    }
    expect(r.clean).toBe(true);
  });
});
