#!/usr/bin/env bun
/**
 * THROWAWAY PROBE (no shipped code changed) — measures three proposals against
 * the geometry the exporter actually emits.
 *
 *   bun scripts/_probe-geo-audit.ts <extracted-pack-dir|...>
 *
 * Reads the RP of an EXTRACTED `.mcaddon` (unzip it first) and, for every
 * entity geometry file:
 *
 *  Q1 FACES  of every axis-aligned cube face, the share fully covered by
 *            coplanar, face-adjacent OPAQUE material (so never visible from
 *            outside), plus the per-cube distribution (>=1, >=3, 6 hidden).
 *  Q1 CUBES  cubes with all six faces covered that nonetheless SHIPPED (i.e.
 *            `cullHiddenCuboids` missed them), and cubes strictly inside one
 *            larger single cube.
 *  Q1 MERGE  `mergeAlignedCuboids` (the shipped pass) re-run on the shipped
 *            set — should find ~nothing — and the same pass with every colour
 *            forced equal, which is the merge box UV forbids.
 *  Q1 BYTES  the shipped box-UV cube form against the per-face-UV form with
 *            all six faces and with the hidden faces omitted.
 *  Q2 LAYOUT entities, geometries per entity, cubes per geometry, render
 *            controllers, and whether any set ships more than one shell actor.
 *
 * Frames: a cube's `origin`/`size` in a `.geo.json` are absolute model units;
 * a bone's `rotation` turns its cubes about the bone `pivot`. Cubes in an
 * unrotated bone with no `rotation` of their own are exactly axis-aligned
 * ("AA") and are the only ones a coplanar face test can speak about. Rotated
 * cubes are counted separately and, in the `+rotAABB` variant, contribute
 * their world AABB as an occluder — an OVER-estimate of their solid, so that
 * variant brackets the hidden-face share from above.
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { mergeAlignedCuboids, cullHiddenCuboids, BEDROCK_UNITS_PER_LDU } from '../web/src/engine/ldraw-entity-compiler.ts';

type Vec3 = [number, number, number];

interface Cube {
  min: Vec3; max: Vec3;
  colorId: number; translucent: boolean;
  bone: string; geoIndex: number;
  aa: boolean;             // axis-aligned in model space
  studFacet: boolean;      // part of a fanned stud (any facet, including k=0)
  bytes: number;           // bytes of the shipped JSON form
  faceHidden?: boolean[];  // [+x,-x,+y,-y,+z,-z]
}

const EPS = 0.02;
const k = (v: number): number => Math.round(v * 100);

// ── Euler helpers (ZYX, degrees) for a rotated bone's world AABB ──────────────
const deg = Math.PI / 180;
function rotateZYX(p: Vec3, r: Vec3): Vec3 {
  const [rx, ry, rz] = [r[0] * deg, r[1] * deg, r[2] * deg];
  let [x, y, z] = p;
  // Rx
  let t = y * Math.cos(rx) - z * Math.sin(rx); z = y * Math.sin(rx) + z * Math.cos(rx); y = t;
  // Ry
  t = x * Math.cos(ry) + z * Math.sin(ry); z = -x * Math.sin(ry) + z * Math.cos(ry); x = t;
  // Rz
  t = x * Math.cos(rz) - y * Math.sin(rz); y = x * Math.sin(rz) + y * Math.cos(rz); x = t;
  return [x, y, z];
}

// ── 2-D full-coverage test: is `rect` fully covered by the union of `rects`? ──
function fullyCovered(rect: [number, number, number, number], rects: Array<[number, number, number, number]>): boolean {
  if (!rects.length) return false;
  const xs = new Set<number>([rect[0], rect[2]]);
  const ys = new Set<number>([rect[1], rect[3]]);
  for (const r of rects) {
    if (r[0] > rect[0] && r[0] < rect[2]) xs.add(r[0]);
    if (r[2] > rect[0] && r[2] < rect[2]) xs.add(r[2]);
    if (r[1] > rect[1] && r[1] < rect[3]) ys.add(r[1]);
    if (r[3] > rect[1] && r[3] < rect[3]) ys.add(r[3]);
  }
  const X = [...xs].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b);
  for (let i = 0; i + 1 < X.length; i++) {
    for (let j = 0; j + 1 < Y.length; j++) {
      const cx = (X[i]! + X[i + 1]!) / 2, cy = (Y[j]! + Y[j + 1]!) / 2;
      let hit = false;
      for (const r of rects) if (cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3]) { hit = true; break; }
      if (!hit) return false;
    }
  }
  return true;
}

// ── Load one entity's cubes from a .geo.json ──────────────────────────────────
interface Entity {
  id: string; file: string; bytes: number;
  geoCount: number; cubesPerGeo: number[]; bonesPerGeo: number[];
  controllers: number; colours: number; translucentGeos: number;
  cubes: Cube[];
}

function colourOfGeometry(rp: string, entityId: string, geoIds: string[]): { colorKeyOf: Map<string, string>; translucentOf: Map<string, boolean>; controllers: number } {
  const colorKeyOf = new Map<string, string>(), translucentOf = new Map<string, boolean>();
  let controllers = 0;
  const ePath = join(rp, 'entity', `${entityId}.entity.json`);
  const rPath = join(rp, 'render_controllers', `${entityId}.render_controllers.json`);
  if (!existsSync(ePath) || !existsSync(rPath)) return { colorKeyOf, translucentOf, controllers };
  const ce = JSON.parse(readFileSync(ePath, 'utf8'))['minecraft:client_entity'].description;
  const rc = JSON.parse(readFileSync(rPath, 'utf8')).render_controllers as Record<string, { geometry: string; materials: Array<Record<string, string>>; textures: string[] }>;
  controllers = Object.keys(rc).length;
  for (const ctrl of Object.values(rc)) {
    const key = ctrl.geometry.replace(/^Geometry\./, '');
    const geoId = (ce.geometry as Record<string, string>)[key];
    if (!geoId) continue;
    const texKey = (ctrl.textures[0] ?? 'Texture.default').replace(/^Texture\./, '');
    const texPath = (ce.textures as Record<string, string>)[texKey] ?? '';
    colorKeyOf.set(geoId, basename(texPath));
    translucentOf.set(geoId, Object.values(ctrl.materials[0] ?? {})[0] === 'Material.blend');
  }
  void geoIds;
  return { colorKeyOf, translucentOf, controllers };
}

function loadEntity(rp: string, file: string): Entity {
  const path = join(rp, 'models', 'entity', file);
  const raw = readFileSync(path, 'utf8');
  const doc = JSON.parse(raw);
  const geos = doc['minecraft:geometry'] as Array<{ description: { identifier: string }; bones: Array<{ name: string; parent?: string; pivot: Vec3; rotation?: Vec3; cubes?: Array<{ origin: Vec3; size: Vec3; rotation?: Vec3; pivot?: Vec3; uv: unknown }> }> }>;
  const id = file.replace(/\.geo\.json$/, '');
  const { colorKeyOf, translucentOf, controllers } = colourOfGeometry(rp, id, geos.map(g => g.description.identifier));
  // Distinct texture files = distinct colours actually bound.
  const colourIds = new Map<string, number>();
  const cubes: Cube[] = [];
  const cubesPerGeo: number[] = [], bonesPerGeo: number[] = [];
  let translucentGeos = 0;
  geos.forEach((g, gi) => {
    const geoId = g.description.identifier;
    const texName = colorKeyOf.get(geoId) ?? `unknown_${gi}`;
    if (!colourIds.has(texName)) colourIds.set(texName, colourIds.size);
    const colorId = colourIds.get(texName)!;
    const translucent = translucentOf.get(geoId) ?? false;
    if (translucent) translucentGeos++;
    const boneRot = new Map<string, Vec3 | undefined>(), bonePivot = new Map<string, Vec3>(), boneParent = new Map<string, string | undefined>();
    for (const b of g.bones) { boneRot.set(b.name, b.rotation); bonePivot.set(b.name, b.pivot); boneParent.set(b.name, b.parent); }
    const chainRotated = (name: string): boolean => {
      for (let n: string | undefined = name; n; n = boneParent.get(n)) if (boneRot.get(n)) return true;
      return false;
    };
    let nCubes = 0;
    for (const b of g.bones) {
      const rotatedBone = chainRotated(b.name);
      for (const c of b.cubes ?? []) {
        nCubes++;
        const aa = !rotatedBone && !c.rotation;
        let min: Vec3 = [...c.origin] as Vec3;
        let max: Vec3 = [c.origin[0] + c.size[0], c.origin[1] + c.size[1], c.origin[2] + c.size[2]];
        if (!aa) {
          // World AABB: rotate the 8 corners about the cube pivot (stud facet)
          // and/or the bone pivot. Over-estimates the solid on purpose.
          const corners: Vec3[] = [];
          for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push([x, y, z]);
          let pts = corners;
          if (c.rotation && c.pivot) {
            const p = c.pivot;
            pts = pts.map(q => { const r = rotateZYX([q[0] - p[0], q[1] - p[1], q[2] - p[2]], c.rotation!); return [r[0] + p[0], r[1] + p[1], r[2] + p[2]] as Vec3; });
          }
          for (let n: string | undefined = b.name; n; n = boneParent.get(n)) {
            const r = boneRot.get(n); if (!r) continue;
            const p = bonePivot.get(n)!;
            pts = pts.map(q => { const t = rotateZYX([q[0] - p[0], q[1] - p[1], q[2] - p[2]], r); return [t[0] + p[0], t[1] + p[1], t[2] + p[2]] as Vec3; });
          }
          min = [Infinity, Infinity, Infinity]; max = [-Infinity, -Infinity, -Infinity];
          for (const q of pts) for (let i = 0; i < 3; i++) { if (q[i]! < min[i]!) min[i] = q[i]!; if (q[i]! > max[i]!) max[i] = q[i]!; }
        }
        cubes.push({
          min, max, colorId, translucent, bone: b.name, geoIndex: gi, aa, studFacet: false,
          bytes: JSON.stringify(c).length,
        });
      }
      // count bones per geometry below
    }
    cubesPerGeo.push(nCubes);
    bonesPerGeo.push(g.bones.length);
  });
  // A fanned stud emits `facets` boxes with IDENTICAL origin+size, one of them
  // unrotated (k = 0). Mark every cube whose RAW origin+size is shared with a
  // rotated cube: the compiler never merges a stud, so nor may this probe.
  const rawSig = (o: Vec3, s: Vec3): string => `${k(o[0])},${k(o[1])},${k(o[2])},${k(o[0] + s[0])},${k(o[1] + s[1])},${k(o[2] + s[2])}`;
  const rotSigsByGeo = new Map<number, Set<string>>();
  geos.forEach((g, gi) => {
    const s = new Set<string>();
    for (const b of g.bones) for (const c of b.cubes ?? []) if (c.rotation) s.add(rawSig(c.origin, c.size));
    rotSigsByGeo.set(gi, s);
  });
  {
    let idx = 0;
    geos.forEach((g, gi) => {
      const rotSigs = rotSigsByGeo.get(gi)!;
      for (const b of g.bones) for (const c of b.cubes ?? []) {
        if (rotSigs.has(rawSig(c.origin, c.size))) cubes[idx]!.studFacet = true;
        idx++;
      }
    });
  }
  return { id, file, bytes: raw.length, geoCount: geos.length, cubesPerGeo, bonesPerGeo, controllers, colours: colourIds.size, translucentGeos, cubes };
}

// ── Face-coverage analysis ────────────────────────────────────────────────────
const BUCKET = 48;
interface PlaneIndex { map: Map<string, Array<[number, number, number, number]>> }

function buildPlaneIndex(occ: Cube[]): Record<string, PlaneIndex> {
  // For face +axis of a cube at plane p we need occluders whose MIN on that
  // axis is p; for -axis, whose MAX is p.
  const idx: Record<string, PlaneIndex> = {};
  for (const side of ['x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max']) idx[side] = { map: new Map() };
  for (const c of occ) {
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3, v = (a + 2) % 3;
      const rect: [number, number, number, number] = [c.min[u]!, c.min[v]!, c.max[u]!, c.max[v]!];
      for (const [side, plane] of [[`${'xyz'[a]}-min`, c.min[a]!], [`${'xyz'[a]}-max`, c.max[a]!]] as Array<[string, number]>) {
        const m = idx[side]!.map;
        for (let bu = Math.floor(rect[0] / BUCKET); bu <= Math.floor(rect[2] / BUCKET); bu++)
          for (let bv = Math.floor(rect[1] / BUCKET); bv <= Math.floor(rect[3] / BUCKET); bv++) {
            const key = `${k(plane)}|${bu}|${bv}`;
            const list = m.get(key); if (list) list.push(rect); else m.set(key, [rect]);
          }
      }
    }
  }
  return idx;
}

function analyseFaces(cubes: Cube[], includeRotOccluders: boolean): { faces: number; hidden: number; ge1: number; ge3: number; all6: number; aaCubes: number } {
  const occ = cubes.filter(c => !c.translucent && (c.aa || includeRotOccluders));
  const idx = buildPlaneIndex(occ);
  let faces = 0, hidden = 0, ge1 = 0, ge3 = 0, all6 = 0, aaCubes = 0;
  for (const c of cubes) {
    if (!c.aa) continue;
    aaCubes++;
    let h = 0;
    c.faceHidden = [];
    for (let a = 0; a < 3; a++) {
      const u = (a + 1) % 3, v = (a + 2) % 3;
      const rect: [number, number, number, number] = [c.min[u]!, c.min[v]!, c.max[u]!, c.max[v]!];
      for (const dir of [1, -1]) {
        faces++;
        // +dir face sits at c.max[a]; its occluders have min[a] == that plane.
        const plane = dir > 0 ? c.max[a]! : c.min[a]!;
        const side = dir > 0 ? `${'xyz'[a]}-min` : `${'xyz'[a]}-max`;
        const cand: Array<[number, number, number, number]> = [];
        const seen = new Set<string>();
        for (const dp of [0, 1, -1]) { // tolerate the 0.01 rounding of the emitted form
          for (let bu = Math.floor(rect[0] / BUCKET); bu <= Math.floor(rect[2] / BUCKET); bu++)
            for (let bv = Math.floor(rect[1] / BUCKET); bv <= Math.floor(rect[3] / BUCKET); bv++) {
              const list = idx[side]!.map.get(`${k(plane) + dp}|${bu}|${bv}`);
              if (!list) continue;
              for (const r of list) { const kk = r.join(','); if (!seen.has(kk)) { seen.add(kk); cand.push(r); } }
            }
        }
        const clipped = cand.filter(r => r[2] > rect[0] + EPS && r[0] < rect[2] - EPS && r[3] > rect[1] + EPS && r[1] < rect[3] - EPS);
        const ok = clipped.length > 0 && fullyCovered(rect, clipped);
        c.faceHidden.push(ok);
        if (ok) { hidden++; h++; }
      }
    }
    if (h >= 1) ge1++;
    if (h >= 3) ge3++;
    if (h === 6) all6++;
  }
  return { faces, hidden, ge1, ge3, all6, aaCubes };
}

// ── Containment: a cube strictly inside ONE larger cube ──────────────────────
function containedInLarger(cubes: Cube[]): number {
  const occ = cubes.filter(c => c.aa && !c.translucent);
  const CELL = 64;
  const grid = new Map<string, Cube[]>();
  for (const c of occ) {
    for (let x = Math.floor(c.min[0] / CELL); x <= Math.floor(c.max[0] / CELL); x++)
      for (let y = Math.floor(c.min[1] / CELL); y <= Math.floor(c.max[1] / CELL); y++)
        for (let z = Math.floor(c.min[2] / CELL); z <= Math.floor(c.max[2] / CELL); z++) {
          const key = `${x},${y},${z}`; const l = grid.get(key); if (l) l.push(c); else grid.set(key, [c]);
        }
  }
  let n = 0;
  for (const c of cubes) {
    const key = `${Math.floor(c.min[0] / CELL)},${Math.floor(c.min[1] / CELL)},${Math.floor(c.min[2] / CELL)}`;
    const list = grid.get(key) ?? [];
    for (const o of list) {
      if (o === c) continue;
      if (o.min[0] <= c.min[0] + EPS && o.max[0] >= c.max[0] - EPS
        && o.min[1] <= c.min[1] + EPS && o.max[1] >= c.max[1] - EPS
        && o.min[2] <= c.min[2] + EPS && o.max[2] >= c.max[2] - EPS
        && (o.max[0] - o.min[0]) * (o.max[1] - o.min[1]) * (o.max[2] - o.min[2]) > (c.max[0] - c.min[0]) * (c.max[1] - c.min[1]) * (c.max[2] - c.min[2]) + EPS) { n++; break; }
    }
  }
  return n;
}

// ── Merge re-runs ────────────────────────────────────────────────────────────
type RC = { min: Vec3; max: Vec3; material: { colorId: number; rgb: number[]; alpha: number }; bone: string; aligned?: boolean; studTop?: boolean; rotation?: Vec3; pivot?: Vec3 };
function mergeRuns(cubes: Cube[]): { sameColour: number; anyColour: number; eligible: number } {
  const mk = (colourBlind: boolean): RC[] => cubes.map(c => ({
    min: c.min, max: c.max,
    material: { colorId: colourBlind ? 0 : c.colorId, rgb: [0, 0, 0], alpha: c.translucent ? 0.5 : 1 },
    bone: c.bone,
    ...(c.aa && !c.studFacet ? { aligned: true } : {}),
  }));
  const a = mergeAlignedCuboids(mk(false) as never);
  const b = mergeAlignedCuboids(mk(true) as never);
  const eligible = cubes.filter(c => c.aa && !c.studFacet && c.bone === 'body').length;
  return { sameColour: a.merged, anyColour: b.merged, eligible };
}

// ── Byte forms ───────────────────────────────────────────────────────────────
const PLAIN_UV = { uv: [0, 0], uv_size: [16, 16] };
const FACES = ['north', 'south', 'east', 'west', 'up', 'down'] as const;
function byteForms(cubes: Cube[]): { shipped: number; sixFace: number; omitted: number; keptFaces: number; totalFaces: number } {
  let shipped = 0, sixFace = 0, omitted = 0, keptFaces = 0, totalFaces = 0;
  for (const c of cubes) {
    shipped += c.bytes;
    const base = { origin: [0, 0, 0], size: [0, 0, 0] };
    const six: Record<string, unknown> = {};
    for (const f of FACES) six[f] = PLAIN_UV;
    sixFace += JSON.stringify({ ...base, uv: six }).length + (c.bytes - JSON.stringify({ ...base, uv: [0, 0] }).length);
    const nHidden = c.faceHidden ? c.faceHidden.filter(Boolean).length : 0;
    const nKept = 6 - nHidden;
    totalFaces += 6; keptFaces += nKept;
    const sub: Record<string, unknown> = {};
    for (let i = 0; i < nKept; i++) sub[FACES[i]!] = PLAIN_UV;
    omitted += JSON.stringify({ ...base, uv: sub }).length + (c.bytes - JSON.stringify({ ...base, uv: [0, 0] }).length);
  }
  return { shipped, sixFace, omitted, keptFaces, totalFaces };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('usage: bun scripts/_probe-geo-audit.ts <extracted-pack-dir>...'); process.exit(2); }
const report: unknown[] = [];
for (const dir of dirs) {
  const rpName = readdirSync(dir).find(n => /_RP$/.test(n));
  if (!rpName) { console.error(`no RP in ${dir}`); continue; }
  const rp = join(dir, rpName);
  const modelDir = join(rp, 'models', 'entity');
  const files = readdirSync(modelDir).filter(f => f.endsWith('.geo.json')).sort();
  console.log(`\n══ ${basename(dir)} (${rpName}) ══`);
  const entities: Entity[] = [];
  for (const f of files) entities.push(loadEntity(rp, f));
  // Q2 layout
  console.log('\n-- Q2 actor/geometry layout --');
  console.log('entity'.padEnd(34) + 'cubes'.padStart(8) + 'geos'.padStart(6) + 'ctrls'.padStart(7) + 'colours'.padStart(9) + 'maxCubes/geo'.padStart(14) + 'bones'.padStart(8) + 'geoKB'.padStart(9));
  for (const e of entities) {
    const cubes = e.cubes.length;
    console.log(e.id.padEnd(34) + String(cubes).padStart(8) + String(e.geoCount).padStart(6) + String(e.controllers).padStart(7)
      + String(e.colours).padStart(9) + String(Math.max(0, ...e.cubesPerGeo)).padStart(14)
      + String(e.bonesPerGeo.reduce((a, b) => a + b, 0)).padStart(8) + (e.bytes / 1024).toFixed(0).padStart(9));
  }
  const packCubes = entities.filter(e => !/_preview$/.test(e.id)).reduce((a, e) => a + e.cubes.length, 0);
  console.log(`pack cuboids (excluding the wand ghost): ${packCubes}; entities ${entities.filter(e => !/_preview$/.test(e.id)).length}`
    + `; shell actors ${entities.filter(e => /_shell$/.test(e.id)).length}`);

  // Q1 on the biggest entity (the shell/vehicle) and on the whole pack
  const targets = entities.filter(e => !/_preview$/.test(e.id)).sort((a, b) => b.cubes.length - a.cubes.length).slice(0, 1);
  for (const e of targets) {
    console.log(`\n-- Q1 on ${e.id} (${e.cubes.length} cubes) --`);
    const aa = e.cubes.filter(c => c.aa).length, rot = e.cubes.length - aa;
    const studs = e.cubes.filter(c => c.studFacet).length;
    const trans = e.cubes.filter(c => c.translucent).length;
    const ext = e.cubes.reduce((acc, c) => { for (let i = 0; i < 3; i++) { acc.min[i] = Math.min(acc.min[i]!, c.min[i]!); acc.max[i] = Math.max(acc.max[i]!, c.max[i]!); } return acc; }, { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 });
    console.log(`  axis-aligned ${aa} (${(aa / e.cubes.length * 100).toFixed(1)} %), rotated ${rot}, stud facets ${studs}, translucent ${trans}`);
    console.log(`  model extent (units): ${ext.max.map((v, i) => (v - ext.min[i]!).toFixed(0)).join(' x ')}`);
    const A = analyseFaces(e.cubes, false);
    const faceA = { ...A };
    const B = analyseFaces(e.cubes, true);
    console.log(`  FACES  AA-occluders only : ${A.hidden}/${A.faces} = ${(A.hidden / A.faces * 100).toFixed(1)} % hidden | cubes >=1 ${(A.ge1 / A.aaCubes * 100).toFixed(1)} %  >=3 ${(A.ge3 / A.aaCubes * 100).toFixed(1)} %  6/6 ${A.all6} (${(A.all6 / A.aaCubes * 100).toFixed(2)} %)`);
    console.log(`  FACES  + rotated AABBs   : ${B.hidden}/${B.faces} = ${(B.hidden / B.faces * 100).toFixed(1)} % hidden | cubes >=1 ${(B.ge1 / B.aaCubes * 100).toFixed(1)} %  >=3 ${(B.ge3 / B.aaCubes * 100).toFixed(1)} %  6/6 ${B.all6} (${(B.all6 / B.aaCubes * 100).toFixed(2)} %)`);
    const contained = containedInLarger(e.cubes);
    console.log(`  CUBES  strictly inside one LARGER cube: ${contained} (${(contained / e.cubes.length * 100).toFixed(2)} % of all cubes)`);
    // The compiler's own culler, re-run on the SHIPPED set — in the frame it
    // really runs in: render-frame LDU (the emitted cubes are model UNITS, at
    // BEDROCK_UNITS_PER_LDU per LDU for a 1x model scale).
    const perLdu = BEDROCK_UNITS_PER_LDU;
    const toLdu = (v: Vec3): Vec3 => [v[0] / perLdu, v[1] / perLdu, v[2] / perLdu];
    const forCull = e.cubes.map(c => ({ min: toLdu(c.min), max: toLdu(c.max), translucent: c.translucent, aligned: c.aa }));
    const lduSpan = [0, 1, 2].map(i => (ext.max[i]! - ext.min[i]!) / perLdu);
    console.log(`  CULL   model extent in LDU: ${lduSpan.map(v => v.toFixed(0)).join(' x ')}`);
    for (const cell of [4, 6, 8, 12, 16]) {
      const span = lduSpan.map(v => Math.ceil(v / cell) + 2);
      const samples = span[0]! * span[1]! * span[2]!;
      const bails = samples > 40_000_000;
      const t0 = Date.now();
      const culled = bails ? new Set<number>() : cullHiddenCuboids(forCull as never, cell);
      console.log(`         cell ${String(cell).padStart(2)} LDU: grid ${span.join('x')} = ${(samples / 1e6).toFixed(1)} M samples`
        + `${bails ? '  >40 M -> BAILS OUT, culls 0' : `  culls ${culled.size} (${(culled.size / e.cubes.length * 100).toFixed(2)} %) in ${Date.now() - t0} ms`}`);
    }
    const culled = new Set<number>();
    const m = mergeRuns(e.cubes);
    console.log(`  MERGE  eligible (body bone, AA, non-stud) ${m.eligible}; same-colour re-run removes ${m.sameColour} (${(m.sameColour / e.cubes.length * 100).toFixed(2)} %); colour-blind removes ${m.anyColour} (${(m.anyColour / e.cubes.length * 100).toFixed(2)} %)`);
    // restore variant A's per-face flags for the byte accounting
    analyseFaces(e.cubes, false);
    const by = byteForms(e.cubes);
    console.log(`  BYTES  shipped box UV ${(by.shipped / 1024).toFixed(0)} kB | six-face UV ${(by.sixFace / 1024).toFixed(0)} kB (${(by.sixFace / by.shipped).toFixed(2)}x) | per-face with hidden omitted ${(by.omitted / 1024).toFixed(0)} kB (${(by.omitted / by.shipped).toFixed(2)}x), faces kept ${by.keptFaces}/${by.totalFaces}`);
    report.push({ pack: basename(dir), entity: e.id, cubes: e.cubes.length, aa, rot, studs, trans, facesA: faceA, facesB: B, contained, culled: culled.size, merge: m, bytes: by, extent: ext.max.map((v, i) => Math.round(v - ext.min[i]!)) });
  }
}
writeFileSync('output/_probe-q-2026-09-19/geo-audit.json', JSON.stringify(report, null, 1));
console.log('\nwrote output/_probe-q-2026-09-19/geo-audit.json');
