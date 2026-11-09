/**
 * Reads what the bricker needs to know about an OFFICIAL LDraw part from its
 * geometry: footprint, body height, the envelope occupancy mask and the
 * stud / anti-stud cells.
 *
 * Nothing here is hand-measured. The part's `.dat` and every subfile and
 * primitive it reaches are flattened into triangles (studs kept aside as
 * placements), and the answers are derived from those triangles. That keeps the
 * vocabulary honest when a part is revised upstream: regenerate and diff.
 *
 * Frame: LDU, LDraw's own axes (y down). The part origin is whatever the part
 * file says; `PartAnalysis.frame` records where the body sits against it so the
 * writer can place any part by its body, never by assuming an origin.
 */

/** Resolves a normalised file name (lower-case, `/` separators, e.g. `s/3001s01.dat`) to its text. */
export type PartSource = (name: string) => string | undefined;

/** Stud primitives whose geometry is a stud on TOP of the body (kept out of the envelope). */
const TOP_STUD = /^stud(2|2a|2s|2s2)?\.dat$/;
/** A logo stud carries the LEGO logo: never legal in our vocabulary. */
const LOGO_STUD = /^stud\d*[a-z]*-logo\d*\.dat$/;

type Mat = readonly number[]; // 12: [tx, ty, tz, a, b, c, d, e, f, g, h, i]

const IDENTITY: Mat = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];

/** `parent * child`, both as (translation, row-major 3x3). */
function compose(p: Mat, c: Mat): Mat {
  const [px, py, pz, a, b, cc, d, e, f, g, h, i] = p as [number, number, number, number, number, number, number, number, number, number, number, number];
  const [cx, cy, cz, A, B, C, D, E, F, G, H, I] = c as [number, number, number, number, number, number, number, number, number, number, number, number];
  return [
    px + a * cx + b * cy + cc * cz, py + d * cx + e * cy + f * cz, pz + g * cx + h * cy + i * cz,
    a * A + b * D + cc * G, a * B + b * E + cc * H, a * C + b * F + cc * I,
    d * A + e * D + f * G, d * B + e * E + f * H, d * C + e * F + f * I,
    g * A + h * D + i * G, g * B + h * E + i * H, g * C + h * F + i * I,
  ];
}

function apply(m: Mat, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! + m[3]! * x + m[4]! * y + m[5]! * z,
    m[1]! + m[6]! * x + m[7]! * y + m[8]! * z,
    m[2]! + m[9]! * x + m[10]! * y + m[11]! * z,
  ];
}

/** A stud primitive placed by the part: where, and whether it points up (-y). */
export interface StudPlacement { x: number; y: number; z: number; up: boolean }

/** A part flattened to triangles (non-stud geometry only) and stud placements. */
export interface FlatPart {
  /** 9 numbers per triangle (three xyz points), LDU. */
  tris: number[];
  studs: StudPlacement[];
  /** Every file reached, normalised names, including stud primitives. */
  reached: Set<string>;
  /** Reached files that carry a logo (must be empty for a legal part). */
  logoFiles: string[];
  /** Names the source could not resolve. */
  missing: string[];
}

/** Normalise a type-1 reference: lower case, forward slashes. */
export function normaliseRef(name: string): string {
  return name.trim().toLowerCase().replace(/\\/g, '/');
}

/**
 * Flatten a part. `partName` is e.g. `3001.dat`.
 * Recursion is bounded; a primitive reached twice is parsed twice (cheap enough
 * for a vocabulary of ~100 parts, and it keeps the code stateless).
 */
export function flattenPart(partName: string, source: PartSource): FlatPart {
  const out: FlatPart = { tris: [], studs: [], reached: new Set(), logoFiles: [], missing: [] };
  const walk = (name: string, m: Mat, depth: number): void => {
    if (depth > 24) return;
    const text = source(name);
    out.reached.add(name);
    if (LOGO_STUD.test(name.split('/').pop()!)) out.logoFiles.push(name);
    if (text === undefined) { out.missing.push(name); return; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const t = line.split(/\s+/);
      const type = t[0];
      if (type === '0') {
        // Meta lines carry no geometry; winding (BFC) is irrelevant to coverage.
        continue;
      }
      if (type === '1' && t.length >= 15) {
        const n = t.slice(1).map(Number);
        const child = normaliseRef(t.slice(14).join(' '));
        const local: Mat = [n[1]!, n[2]!, n[3]!, n[4]!, n[5]!, n[6]!, n[7]!, n[8]!, n[9]!, n[10]!, n[11]!, n[12]!];
        const world = compose(m, local);
        const base = child.split('/').pop()!;
        if (TOP_STUD.test(base) || LOGO_STUD.test(base)) {
          out.reached.add(child);
          if (LOGO_STUD.test(base)) out.logoFiles.push(child);
          // A stud's own axis is -y; `e` is the y-to-y coefficient of the world matrix.
          out.studs.push({ x: world[0]!, y: world[1]!, z: world[2]!, up: world[7]! > 0.9 });
          continue;
        }
        walk(child, world, depth + 1);
      } else if (type === '3' && t.length >= 11) {
        const v = t.slice(2, 11).map(Number);
        for (let k = 0; k < 9; k += 3) out.tris.push(...apply(m, v[k]!, v[k + 1]!, v[k + 2]!));
      } else if (type === '4' && t.length >= 14) {
        const v = t.slice(2, 14).map(Number);
        const p = [0, 3, 6, 9].map(k => apply(m, v[k]!, v[k + 1]!, v[k + 2]!));
        out.tris.push(...p[0]!, ...p[1]!, ...p[2]!, ...p[0]!, ...p[2]!, ...p[3]!);
      }
    }
  };
  walk(normaliseRef(partName), IDENTITY, 0);
  return out;
}

/** How the envelope of a part is read from its triangles. */
export type OccupancyMode =
  /** Everything between the top surface and the bottom is solid (bricks, plates, slopes, rounds). */
  | 'envelope'
  /** Even-odd crossings: voids under a crown stay empty (arches, windows, doors, fences, brackets). */
  | 'parity';

/** Where the body sits against the part's own origin, LDU. */
export interface BodyFrame {
  /** Body bounding-box centre in x and z. */
  centreX: number;
  centreZ: number;
  /** LDraw y of the body's top (studs excluded) and bottom. */
  topY: number;
  bottomY: number;
}

export interface PartAnalysis {
  footprint: [number, number];
  heightPlates: number;
  frame: BodyFrame;
  /** One byte per cell, `occupancyIndex` order. */
  occupancy: Uint8Array;
  /** True when every cell is occupied (a plain cuboid envelope). */
  full: boolean;
  studsTop: Array<[number, number]>;
  antiStudsBottom: Array<[number, number]>;
}

/** Index of cell (x, z) on plate `layer` (0 = lowest) of a footprint `fx` wide in x, `fz` in z. */
export function occupancyIndex(fx: number, fz: number, x: number, z: number, layer: number): number {
  return x + fx * (z + fz * layer);
}

const STUD = 20;
const PLATE = 8;
/** Sub-cell sample offsets (fractions of a stud) for the envelope reading; skewed so no ray runs along an edge. */
const SAMPLES = [-0.31, 0.003, 0.317];

/** y of the ray (vertical, at x/z) through a triangle, or null when it misses. */
function hitY(tris: number[], k: number, x: number, z: number): number | null {
  const ax = tris[k]!, ay = tris[k + 1]!, az = tris[k + 2]!;
  const bx = tris[k + 3]!, by = tris[k + 4]!, bz = tris[k + 5]!;
  const cx = tris[k + 6]!, cy = tris[k + 7]!, cz = tris[k + 8]!;
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-9) return null; // vertical in projection
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < 0 || l2 < 0 || l3 < 0) return null;
  return l1 * ay + l2 * by + l3 * cy;
}

/** Every y at which the vertical line at (x, z) crosses a triangle, ascending (top first, y is down). */
function crossings(tris: number[], x: number, z: number): number[] {
  const ys: number[] = [];
  for (let k = 0; k < tris.length; k += 9) {
    const y = hitY(tris, k, x, z);
    if (y !== null) ys.push(y);
  }
  return ys.sort((a, b) => a - b);
}

/** Read a flattened part. Throws when it has no body geometry. */
export function analysePart(flat: FlatPart, mode: OccupancyMode): PartAnalysis {
  const { tris } = flat;
  if (tris.length === 0) throw new Error('part has no body geometry');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < tris.length; k += 3) {
    minX = Math.min(minX, tris[k]!); maxX = Math.max(maxX, tris[k]!);
    minY = Math.min(minY, tris[k + 1]!); maxY = Math.max(maxY, tris[k + 1]!);
    minZ = Math.min(minZ, tris[k + 2]!); maxZ = Math.max(maxZ, tris[k + 2]!);
  }
  const fx = Math.max(1, Math.ceil((maxX - minX - 1) / STUD));
  const fz = Math.max(1, Math.ceil((maxZ - minZ - 1) / STUD));
  // A few parts carry a lip a few LDU above their last full plate (a door frame's hinge
  // lugs): count whole plates, tolerating up to 1.5 LDU of rounding either side.
  const heightPlates = Math.max(1, Math.floor((maxY - minY + 1.5) / PLATE));
  const frame: BodyFrame = { centreX: (minX + maxX) / 2, centreZ: (minZ + maxZ) / 2, topY: minY, bottomY: maxY };

  const cellX = (i: number): number => frame.centreX + (i - (fx - 1) / 2) * STUD;
  const cellZ = (j: number): number => frame.centreZ + (j - (fz - 1) / 2) * STUD;

  const occupancy = new Uint8Array(fx * fz * heightPlates);
  for (let j = 0; j < fz; j++) {
    for (let i = 0; i < fx; i++) {
      // Per layer: how many of the 9 samples are solid at the layer's mid height.
      const solid = new Array<number>(heightPlates).fill(0);
      for (const sx of SAMPLES) {
        for (const sz of SAMPLES) {
          const ys = crossings(tris, cellX(i) + sx * STUD, cellZ(j) + sz * STUD);
          if (ys.length === 0) continue;
          for (let layer = 0; layer < heightPlates; layer++) {
            const midY = frame.bottomY - (layer + 0.5) * PLATE;
            if (mode === 'envelope') {
              if (midY > ys[0]!) solid[layer]!++;
            } else {
              // Even-odd: an odd number of surfaces ABOVE (smaller y) means inside.
              const above = ys.filter(y => y < midY).length;
              if (above % 2 === 1) solid[layer]!++;
            }
          }
        }
      }
      for (let layer = 0; layer < heightPlates; layer++) {
        if (solid[layer]! >= 5) occupancy[occupancyIndex(fx, fz, i, j, layer)] = 1;
      }
    }
  }

  const cellOf = (x: number, z: number): [number, number] | null => {
    const i = Math.floor((x - (frame.centreX - (fx * STUD) / 2)) / STUD);
    const j = Math.floor((z - (frame.centreZ - (fz * STUD) / 2)) / STUD);
    return i >= 0 && i < fx && j >= 0 && j < fz ? [i, j] : null;
  };
  const studKeys = new Set<string>();
  for (const s of flat.studs) {
    if (!s.up) continue;
    const c = cellOf(s.x, s.z);
    if (c) studKeys.add(`${c[0]},${c[1]}`);
  }
  const studsTop = sortCells(studKeys);

  // Anti-stud: from below, the first surface under the cell sits more than 2 LDU
  // above the part's bottom, i.e. the underside is recessed there.
  const antiKeys = new Set<string>();
  for (let j = 0; j < fz; j++) {
    for (let i = 0; i < fx; i++) {
      // Any of the nine samples seeing a recess counts: a tube standing in the cell centre
      // (1x1 round brick) must not hide the cavity around it.
      for (const sx of SAMPLES) {
        for (const sz of SAMPLES) {
          const ys = crossings(tris, cellX(i) + sx * STUD, cellZ(j) + sz * STUD);
          if (ys.length > 0 && frame.bottomY - ys[ys.length - 1]! > 2) antiKeys.add(`${i},${j}`);
        }
      }
    }
  }

  return {
    footprint: [fx, fz],
    heightPlates,
    frame,
    occupancy,
    full: occupancy.every(v => v === 1),
    studsTop,
    antiStudsBottom: sortCells(antiKeys),
  };
}

function sortCells(keys: Set<string>): Array<[number, number]> {
  return [...keys]
    .map(k => k.split(',').map(Number) as [number, number])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** Read the `0 Author:` and `0 !LICENSE` lines of a part file. */
export function readHeader(text: string): { title: string; author: string; licence: string; org: string } {
  const lines = text.split(/\r?\n/);
  const find = (re: RegExp): string => {
    for (const l of lines) { const m = re.exec(l); if (m) return m[1]!.trim(); }
    return '';
  };
  return {
    title: (lines[0] ?? '').replace(/^0\s*/, '').trim(),
    author: find(/^0\s+Author:\s*(.*)$/),
    licence: find(/^0\s+!LICENSE\s+(.*)$/),
    org: find(/^0\s+!LDRAW_ORG\s+(.*)$/),
  };
}

/**
 * Every file a part needs to be drawn: the part, its subfiles and primitives, and
 * the stud primitives (which `flattenPart` records but does not open). Used to
 * vendor the vocabulary and to prove the vendored copy is complete.
 * `missing` lists references the source could not resolve.
 */
export function reachableFiles(partName: string, source: PartSource): { files: Set<string>; missing: string[] } {
  const files = new Set<string>();
  const missing: string[] = [];
  const walk = (name: string, depth: number): void => {
    if (depth > 24 || files.has(name)) return;
    files.add(name);
    const text = source(name);
    if (text === undefined) { missing.push(name); return; }
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trim().split(/\s+/);
      if (t[0] === '1' && t.length >= 15) walk(normaliseRef(t.slice(14).join(' ')), depth + 1);
    }
  };
  walk(normaliseRef(partName), 0);
  return { files, missing };
}
