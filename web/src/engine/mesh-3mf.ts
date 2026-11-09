/**
 * 3MF reader (BIZ-32): a 3MF package (OPC zip) -> a Three.js Group, without the DOM.
 *
 * Three's own ThreeMFLoader needs `DOMParser`, which does not exist in Node (so it could not be tested
 * offline) and ignores the build item transforms' row-vector convention in places. This reader walks the
 * model XML with a tag tokenizer and supports what a slicer or CAD export carries:
 * - `<build><item>` roots with `transform`, `<components>` assemblies (nested, with transforms);
 * - the model `unit` attribute (default millimetre);
 * - `<basematerials>` colours, per object (`pid`/`pindex`) and per triangle (`pid`/`p1`).
 *
 * TODO(B09): production-extension objects in other model files (`p:path`), `<colorgroup>`/texture
 * resources and `<slice>` data are not read; a component pointing at another file is skipped and reported
 * in `userData.meshSource.warnings`.
 */

import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'fflate';

/** Result of reading a 3MF: geometry in the file's own units and frame (Z up), plus its unit. */
export interface ThreeMfResult {
  group: THREE.Group;
  /** The model's `unit` attribute (3MF default: millimeter). */
  unit: string;
  warnings: string[];
}

interface MeshData {
  /** Flat xyz. */
  vertices: number[];
  /** Flat v1 v2 v3. */
  triangles: number[];
  /** Per-triangle base-material index pair [pid, pindex] or -1. */
  triPid: number[];
  triP1: number[];
  pid: number;
  pindex: number;
}

interface ObjectData {
  id: number;
  type: string;
  mesh?: MeshData;
  components: { objectid: number; transform?: THREE.Matrix4; path?: string }[];
}

const NON_PRINTED = new Set(['support', 'solidsupport', 'surface']);
const TAG_RE = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrsOf(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(src); m; m = ATTR_RE.exec(src)) out[m[1]!] = m[2] ?? m[3] ?? '';
  return out;
}

/** 3MF's 12-number transform is row-vector: x' = x*m0 + y*m3 + z*m6 + m9 (and so on). */
function parseTransform(s: string | undefined): THREE.Matrix4 | undefined {
  if (!s) return undefined;
  const m = s.trim().split(/\s+/).map(Number);
  if (m.length !== 12 || m.some((v) => !Number.isFinite(v))) return undefined;
  return new THREE.Matrix4().set(
    m[0]!, m[3]!, m[6]!, m[9]!,
    m[1]!, m[4]!, m[7]!, m[10]!,
    m[2]!, m[5]!, m[8]!, m[11]!,
    0, 0, 0, 1,
  );
}

/** "#RRGGBB" or "#RRGGBBAA" (sRGB) -> THREE.Color in linear working space. */
function parseDisplayColour(s: string): THREE.Color {
  return new THREE.Color().setStyle('#' + s.replace('#', '').slice(0, 6), THREE.SRGBColorSpace);
}

/** Finds the model part: the `3dmodel` relationship target, else the first `*.model`. */
function modelPath(files: Record<string, Uint8Array>): string {
  const rels = files['_rels/.rels'];
  if (rels) {
    const re = /<Relationship\b[^>]*>/g;
    const text = strFromU8(rels);
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const a = attrsOf(m[0]);
      if (a.Type?.endsWith('/3dmodel') && a.Target) {
        const p = a.Target.replace(/^\//, '');
        if (files[p]) return p;
      }
    }
  }
  const found = Object.keys(files).find((k) => k.toLowerCase().endsWith('.model'));
  if (!found) throw new Error('3MF has no 3D model part');
  return found;
}

/**
 * Reads a 3MF package.
 * @throws when the bytes are not a zip / have no model part / contain nothing to build.
 */
export function read3mf(bytes: ArrayBuffer): ThreeMfResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes));
  } catch {
    throw new Error('Not a valid 3MF file (zip package could not be read)');
  }
  const xml = strFromU8(files[modelPath(files)]!);

  const warnings: string[] = [];
  let unit = 'millimeter';
  const objects = new Map<number, ObjectData>();
  const baseMaterials = new Map<number, THREE.Color[]>();
  const buildItems: { objectid: number; transform?: THREE.Matrix4 }[] = [];

  let curObj: ObjectData | undefined;
  let curMat: THREE.Color[] | undefined;
  let matId = 0;

  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(xml); m; m = TAG_RE.exec(xml)) {
    const closing = m[1] === '/';
    const name = m[2]!.replace(/^[\w-]+:/, ''); // drop a namespace prefix
    if (closing) {
      if (name === 'object') curObj = undefined;
      else if (name === 'basematerials') curMat = undefined;
      continue;
    }
    const selfClose = m[4] === '/';
    const a = attrsOf(m[3]!);
    switch (name) {
      case 'model':
        if (a.unit) unit = a.unit.toLowerCase();
        break;
      case 'basematerials':
        matId = Number(a.id);
        curMat = [];
        baseMaterials.set(matId, curMat);
        if (selfClose) curMat = undefined;
        break;
      case 'base':
        if (curMat && a.displaycolor) curMat.push(parseDisplayColour(a.displaycolor));
        break;
      case 'object': {
        curObj = {
          id: Number(a.id), type: (a.type ?? 'model').toLowerCase(), components: [],
        };
        if (a.pid !== undefined) {
          // Stash the object-level default on the mesh once it exists.
          curObj.mesh = undefined;
          (curObj as ObjectData & { _pid?: number; _pindex?: number })._pid = Number(a.pid);
          (curObj as ObjectData & { _pid?: number; _pindex?: number })._pindex = Number(a.pindex ?? 0);
        }
        objects.set(curObj.id, curObj);
        if (selfClose) curObj = undefined;
        break;
      }
      case 'mesh':
        if (curObj) {
          const o = curObj as ObjectData & { _pid?: number; _pindex?: number };
          curObj.mesh = { vertices: [], triangles: [], triPid: [], triP1: [], pid: o._pid ?? -1, pindex: o._pindex ?? 0 };
        }
        break;
      case 'vertex':
        curObj?.mesh?.vertices.push(Number(a.x), Number(a.y), Number(a.z));
        break;
      case 'triangle': {
        const mesh = curObj?.mesh;
        if (!mesh) break;
        mesh.triangles.push(Number(a.v1), Number(a.v2), Number(a.v3));
        mesh.triPid.push(a.pid !== undefined ? Number(a.pid) : mesh.pid);
        mesh.triP1.push(a.p1 !== undefined ? Number(a.p1) : mesh.pindex);
        break;
      }
      case 'component':
        curObj?.components.push({ objectid: Number(a.objectid), transform: parseTransform(a.transform), path: a.path });
        break;
      case 'item':
        buildItems.push({ objectid: Number(a.objectid), transform: parseTransform(a.transform) });
        break;
      default:
        break;
    }
  }

  const printable = [...objects.values()].filter((o) => !NON_PRINTED.has(o.type));
  const roots = buildItems.length
    ? buildItems.filter((i) => objects.has(i.objectid))
    : printable.map((o) => ({ objectid: o.id, transform: undefined as THREE.Matrix4 | undefined }));
  if (!roots.length) throw new Error('3MF has nothing to build (no build items or objects)');

  const group = new THREE.Group();
  const emit = (obj: ObjectData, world: THREE.Matrix4, depth: number): void => {
    if (depth > 16) { warnings.push(`component nesting deeper than 16 at object ${obj.id}`); return; }
    if (obj.mesh && obj.mesh.triangles.length) group.add(meshOf(obj.mesh, world, baseMaterials, warnings));
    for (const c of obj.components) {
      const child = objects.get(c.objectid);
      if (c.path || !child) { warnings.push(`component object ${c.objectid}${c.path ? ` in ${c.path}` : ''} not found`); continue; }
      emit(child, c.transform ? world.clone().multiply(c.transform) : world, depth + 1);
    }
  };
  for (const r of roots) {
    const obj = objects.get(r.objectid)!;
    if (NON_PRINTED.has(obj.type)) continue;
    emit(obj, r.transform ?? new THREE.Matrix4(), 0);
  }
  if (!group.children.length) throw new Error('3MF has no mesh geometry (nothing to build)');
  return { group, unit, warnings };
}

/** One THREE.Mesh from a parsed mesh with `world` baked in; non-indexed so each triangle can carry a colour. */
function meshOf(mesh: MeshData, world: THREE.Matrix4, mats: Map<number, THREE.Color[]>, warnings: string[]): THREE.Mesh {
  const nTri = mesh.triangles.length / 3;
  const nVert = mesh.vertices.length / 3;
  const pos = new Float32Array(nTri * 9);
  const v = new THREE.Vector3();
  const coloured = mesh.triPid.some((p) => p >= 0 && mats.has(p));
  const col = coloured ? new Float32Array(nTri * 9).fill(1) : undefined;
  let bad = 0;
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.triangles[t * 3 + k]!;
      if (!(vi >= 0 && vi < nVert)) { bad++; continue; }
      v.set(mesh.vertices[vi * 3]!, mesh.vertices[vi * 3 + 1]!, mesh.vertices[vi * 3 + 2]!).applyMatrix4(world);
      pos.set([v.x, v.y, v.z], t * 9 + k * 3);
    }
    const pid = mesh.triPid[t]!;
    const c = col && pid >= 0 ? mats.get(pid)?.[mesh.triP1[t]!] : undefined;
    if (col && c) for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], t * 9 + k * 3);
  }
  if (bad) warnings.push(`${bad} triangle corners referenced a missing vertex`);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // A transform with negative determinant mirrors the part: flip winding so normals stay outward.
  if (world.determinant() < 0) {
    for (const attr of [geo.getAttribute('position'), geo.getAttribute('color')]) {
      if (!attr) continue;
      const arr = (attr as THREE.BufferAttribute).array as Float32Array;
      for (let t = 0; t < nTri; t++) {
        const o = t * 9;
        for (let k = 0; k < 3; k++) { const tmp = arr[o + 3 + k]!; arr[o + 3 + k] = arr[o + 6 + k]!; arr[o + 6 + k] = tmp; }
      }
    }
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xcccccc, vertexColors: !!col, side: THREE.DoubleSide }));
}
