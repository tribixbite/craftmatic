/**
 * A08 (BIZ-05): facade grammars. A9's `FeatureSpec`s on a volume's walls become openings (window and arch intents), relief
 * (buttresses, cornices, pinnacles) and trim in the `IntentLattice`, and the X-10 bricker still builds one connected model.
 */
import { describe, expect, it } from 'vitest';
import { brickLattice } from '../web/src/brickgen/bricker/index.js';
import { buildGrammarLattice } from '../web/src/brickgen/grammar/index.js';
import type { FeatureSet, FeatureSpec, IntentLattice, Massing, MassVolume, Vec2m } from '../web/src/brickgen/types.js';
import { isClean } from '../web/src/brickgen/verify/index.js';
import { openingRule, styleKeyOf } from '../web/src/brickgen/grammar/rules.js';

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

/** Cells of a role at plate `p`, as `x,z` strings (lattice coordinates). */
function cellsOf(l: IntentLattice, role: string, p0: number, p1: number): Set<string> {
  const [W, , D] = l.dims;
  const out = new Set<string>();
  for (let p = p0; p < p1; p++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const v = l.cells[(p * D + z) * W + x]!;
    if (v && l.labels[v - 1]!.role === role) out.add(`${x},${z}`);
  }
  return out;
}

describe('brickgen-grammar-facade heads and styles', () => {
  const VOLUME = body(rect(0, 0, 30, 8), 12);
  const win = feature('window', { atM: [15, 3, 0], sizeM: [5, 8, 0.4] });
  const withEra = (era: string | undefined, f: FeatureSpec[]): { lattice: IntentLattice; clean: boolean } => {
    const { lattice } = buildGrammarLattice(massingOf([VOLUME]), { features: f, style: { ...STYLE, ...(era ? { era } : {}) } });
    return { lattice, clean: isClean(brickLattice(lattice).report) };
  };

  it('the style decides the head: gothic points it, classical rounds it, default leaves a plain rectangle', () => {
    const cells = (era?: string): number => openings(withEra(era, [win]).lattice, 'window').reduce((n, o) => n + o.cells, 0);
    const [gothic, classical, plain] = [cells('gothic'), cells('classical'), cells(undefined)];
    expect(plain).toBe(5 * 20);
    expect(classical).toBeLessThan(plain);
    expect(gothic).toBeLessThan(classical); // a pointed head loses more of its corners than a round one
  });

  it('every head keeps the requested bounding box and stays one component', () => {
    for (const era of ['gothic', 'classical', undefined]) {
      const r = withEra(era, [win]);
      const o = openings(r.lattice, 'window');
      expect(o).toHaveLength(1);
      expect(o[0]!.w).toBe(5);
      expect(Math.abs(o[0]!.h - 20)).toBeLessThanOrEqual(1);
      expect(r.clean).toBe(true);
    }
  });

  it('a rose window is a disc of open cells with vertical mullions, about pi r^2 in area, and the wall stays one piece', () => {
    const rose = feature('rose', { atM: [15, 3, 0], sizeM: [9, 9, 0.8] });
    const r = build([VOLUME], [rose]);
    const o = openings(r.lattice, 'window');
    const area = o.reduce((n, k) => n + k.cells, 0);
    const bars = cellsOf(r.lattice, 'wall', 0, 400);
    expect(o.length).toBeGreaterThanOrEqual(2); // the mullions split the disc
    expect(o.reduce((m, k) => Math.max(m, k.w), 0)).toBeLessThanOrEqual(9);
    const ideal = Math.PI * 4.5 * 4.5 * 2.5; // pi r^2 in studs^2 x plates per stud^2... cells are stud x plate
    expect(area).toBeGreaterThan(0.55 * ideal);
    expect(area).toBeLessThan(1.0 * ideal);
    expect(bars.size).toBeGreaterThan(0);
    expect(r.clean).toBe(true);
  });

  it('a portal at ground level is an opening from the floor up, wide as asked, in a pointed head for a gothic style', () => {
    const portal = feature('portal', { atM: [10, 0, 0], sizeM: [6, 9, 1.5] });
    const { lattice } = buildGrammarLattice(massingOf([VOLUME]), { features: [portal], style: { ...STYLE, era: 'gothic' } });
    const o = openings(lattice, 'window');
    expect(o).toHaveLength(1);
    expect(o[0]!.w).toBe(6);
    expect(Math.abs(o[0]!.h - 22)).toBeLessThanOrEqual(1);
    expect(isClean(brickLattice(lattice).report)).toBe(true);
  });

  it('a run of 12 narrow arcade openings keeps a pier between neighbours even when the spacing is tighter than the width', () => {
    const arcade = feature('arcade', { atM: [15, 3, 0], sizeM: [2, 5, 0.5], count: 12, spacingM: 2.2 });
    const r = build([VOLUME], [arcade]);
    const o = openings(r.lattice, 'window');
    expect(o.length).toBeGreaterThanOrEqual(10);
    expect(r.clean).toBe(true);
  });
});

describe('brickgen-grammar-facade relief', () => {
  const VOLUME = body(rect(0, 0, 30, 8), 12);
  const pad = 4;

  it('a buttress stands out of the wall on the ground, is stepped back towards its top, and the model stays one piece', () => {
    const b = feature('buttress', { atM: [15, 0, 0], sizeM: [2, 12, 3] });
    const r = build([VOLUME], [b]);
    const outside = cellsOf(r.lattice, 'wall', 2, 40);
    // Edge 0 is the north wall (z = 0): relief outside it has lattice z < pad.
    const out = [...outside].filter(c => Number(c.split(',')[1]) < pad);
    expect(out.length).toBeGreaterThan(0);
    const depthAt = (p: number): number => { const [W, , D] = r.lattice.dims; let d = 0; for (let z = pad - 1; z >= 0; z--) { if (r.lattice.cells[(p * D + z) * W + pad + 15]) d++; else break; } return d; };
    expect(depthAt(5)).toBe(3);
    expect(depthAt(Math.round(12 * 2.5) + 1)).toBeLessThan(3);
    expect(r.clean).toBe(true);
  });

  it('a cornice is one trim course that projects a stud, a balustrade is every other stud of it', () => {
    const cornice = feature('cornice', { atM: [15, 11, 0], sizeM: [20, 1, 0.8] });
    const bal = feature('balustrade', { atM: [15, 8, 0], sizeM: [20, 1.5, 0.5] });
    const r = build([VOLUME], [cornice, bal]);
    const trim = cellsOf(r.lattice, 'trim', 0, 60);
    const outside = [...trim].filter(c => Number(c.split(',')[1]) < pad);
    expect(outside.length).toBeGreaterThanOrEqual(20);
    // Balustrade cells at plate 22: alternate columns only.
    const [W, , D] = r.lattice.dims;
    const row = Array.from({ length: 20 }, (_, i) => (r.lattice.cells[(22 * D + (pad - 1)) * W + pad + 5 + i] ? 1 : 0));
    expect(row.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10);
    expect(row.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(8);
    expect(r.clean).toBe(true);
  });

  it('a battlement raises merlons on every other stud of the wall top', () => {
    const bat = feature('battlement', { atM: [15, 12, 0], sizeM: [20, 1, 0.6] });
    const r = build([VOLUME], [bat]);
    const topP = Math.round(12 * 2.5) + 2;
    const [W, , D] = r.lattice.dims;
    const merlons = Array.from({ length: 20 }, (_, i) => (r.lattice.cells[(topP * D + pad) * W + pad + 5 + i] ? 1 : 0));
    expect(merlons.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(9);
    expect(merlons.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(11);
    expect(r.clean).toBe(true);
  });

  it('a pinnacle is a shaft capped with a cone part', () => {
    const pin = feature('pinnacle', { atM: [4, 11, 0], sizeM: [2, 6, 2] });
    const { lattice } = buildGrammarLattice(massingOf([VOLUME]), { features: [pin], style: STYLE });
    const r = brickLattice(lattice);
    expect(r.plan.elements.some(e => ['3942c.dat', '4589.dat', '272.dat'].includes(e.part))).toBe(true);
    expect(isClean(r.report)).toBe(true);
  });

  it('a flying buttress is a pier and an open strut climbing to the wall it braces', () => {
    const nave = body(rect(0, 0, 40, 10), 20);
    const strip: MassVolume = { id: 'fb', outer: rect(15, 10, 16, 22), holes: [], baseM: 0, topM: 16, roof: { shape: 'shed', pitchDeg: 88 }, role: 'body' };
    const fb: FeatureSpec = { kind: 'flying-buttress', volume: 'fb', atM: [15.5, 16, 16], sizeM: [12, 8, 1], confidence: 0.55, sources: ['t'] };
    const { lattice, stats } = buildGrammarLattice(massingOf([nave, strip]), { features: [fb], style: STYLE });
    expect(stats.facade.byKind['flying-buttress']).toBe(1);
    const col = (z: number): number => { const [W, H, D] = lattice.dims; let n = 0; for (let p = 0; p < H; p++) if (lattice.cells[(p * D + pad + z) * W + pad + 15]) n++; return n; };
    expect(col(21)).toBeGreaterThan(col(15)); // the pier end is solid to the ground, the middle of the strut is thin
    expect(isClean(brickLattice(lattice).report)).toBe(true);
  });

  it('a chimney is a box on the volume top, a clock a disc of accent colour that cuts no hole', () => {
    const chimney = feature('chimney', { edge: undefined as unknown as number, atM: [10, 12, 4], sizeM: [2, 4, 2] });
    delete (chimney as { edge?: number }).edge;
    const clock = feature('clock', { atM: [15, 5, 0], sizeM: [4, 4, 0.3] });
    const r = build([VOLUME], [chimney, clock]);
    expect(openings(r.lattice, 'window')).toHaveLength(0);
    expect(columnTopAt(r.lattice, pad + 10, pad + 4)).toBeGreaterThan(Math.round(12 * 2.5) + 2 + 5);
    expect(r.clean).toBe(true);
  });
});

/** Highest filled plate of one stud column. */
function columnTopAt(l: IntentLattice, x: number, z: number): number {
  const [W, H, D] = l.dims;
  for (let p = H - 1; p >= 0; p--) if (l.cells[(p * D + z) * W + x]) return p;
  return -1;
}

describe('brickgen-grammar-facade rules and bookkeeping', () => {
  const VOLUME = body(rect(0, 0, 30, 8), 12);

  it('feature kinds with no grammar yet are counted as skipped and named in the notes, never dropped silently', () => {
    const r = buildGrammarLattice(massingOf([VOLUME]), { features: [feature('cable', {}), feature('lattice', {})], style: STYLE });
    expect(r.stats.facade.skipped).toBe(2);
    expect(r.notes.join(' ')).toMatch(/not built.*cable/);
  });

  it('a feature on a wall hidden inside another volume is skipped without error', () => {
    // The 10 x 10 annexe overlaps the east end of the body: its west wall is cleared by the taller body.
    const annex: MassVolume = { id: 'b', outer: rect(25, 0, 35, 8), holes: [], baseM: 0, topM: 6, roof: { shape: 'flat' }, role: 'body' };
    const hidden = feature('window', { volume: 'b', edge: 3, atM: [4, 2, 0], sizeM: [2, 3, 0.3] });
    const r = buildGrammarLattice(massingOf([VOLUME, annex]), { features: [hidden], style: STYLE });
    expect(r.stats.facade.openings + r.stats.facade.skipped).toBe(1);
  });

  it('the rule tables are data: era strings map to styles and each style gives each opening kind a head', () => {
    expect(styleKeyOf('Gothic revival')).toBe('gothic');
    expect(styleKeyOf('baroque')).toBe('classical');
    expect(styleKeyOf(undefined)).toBe('default');
    expect(openingRule('gothic', 'lancet').head).toBe('pointed');
    expect(openingRule('classical', 'window').head).toBe('round');
    expect(openingRule('default', 'window').head).toBe('flat');
  });

  it('the same input gives the same lattice, cell for cell', () => {
    const f = [feature('lancet', { atM: [15, 3, 0], sizeM: [3, 8, 0.6], count: 3, spacingM: 10 }), feature('buttress', { atM: [5, 0, 0], sizeM: [2, 12, 3] })];
    const a = buildGrammarLattice(massingOf([VOLUME]), { features: f, style: STYLE });
    const b = buildGrammarLattice(massingOf([VOLUME]), { features: f, style: STYLE });
    expect(Buffer.from(a.lattice.cells.buffer).equals(Buffer.from(b.lattice.cells.buffer))).toBe(true);
  });
});
