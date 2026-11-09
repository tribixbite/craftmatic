/**
 * B09 (BIZ-32): STL (binary + ASCII), 3MF, PLY and GLB (meshopt / Draco) readers, with unit handling
 * (1 stud = 8 mm = 20 LDU, so mm x 2.5 = LDU) feeding the X-11 lattice.
 * Every fixture is built here from raw triangles / raw bytes, never from a primitive's round-trip.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { MeshoptEncoder } from 'meshoptimizer/meshopt_encoder.module.js';
import {
  detectMeshType, loadMeshFromBytes, analyzeMesh, meshExtentLdu, resolveLduPerUnit,
  gltfCompression, LDU_PER_MM,
} from '../web/src/engine/mesh-import.js';
import { meshBytesToLattice } from '../web/src/engine/mesh-import-lattice.js';
import { latticeIndex } from '../web/src/engine/legolize/types.js';

type V3 = [number, number, number];

/** 12 outward-wound triangles of the box [0,w] x [0,h] x [0,d]. */
function boxTriangles(w: number, h: number, d: number): V3[][] {
  const [x0, y0, z0, x1, y1, z1] = [0, 0, 0, w, h, d];
  const p = (x: number, y: number, z: number): V3 => [x, y, z];
  const quad = (a: V3, b: V3, c: V3, e: V3): V3[][] => [[a, b, c], [a, c, e]];
  return [
    ...quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),
    ...quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0)),
    ...quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1)),
    ...quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)),
    ...quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0)),
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),
  ];
}

/** An 80-byte header + count + 50 bytes per triangle (normal left zero: readers must not need it). */
function binaryStl(tris: V3[][]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, i) => t.forEach((v, j) => v.forEach((c, k) => dv.setFloat32(84 + i * 50 + 12 + j * 12 + k * 4, c, true))));
  return buf;
}

function asciiStl(tris: V3[][]): ArrayBuffer {
  const body = tris.map((t) => `facet normal 0 0 0\n outer loop\n${t.map((v) => `  vertex ${v.join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n');
  return strToU8(`solid cube\n${body}\nendsolid cube\n`).buffer as ArrayBuffer;
}

/** Indexed (shared-vertex) box as an ASCII PLY, optionally with a per-vertex red colour. */
function asciiPly(w: number, h: number, d: number, red = false): ArrayBuffer {
  const v: V3[] = [[0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0], [0, 0, d], [w, 0, d], [w, h, d], [0, h, d]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const lines = [
    'ply', 'format ascii 1.0', `element vertex ${v.length}`, 'property float x', 'property float y', 'property float z',
    ...(red ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    `element face ${quads.length}`, 'property list uchar int vertex_indices', 'end_header',
    ...v.map((p) => p.join(' ') + (red ? ' 255 0 0' : '')),
    ...quads.map((q) => `4 ${q.join(' ')}`),
  ];
  return strToU8(lines.join('\n') + '\n').buffer as ArrayBuffer;
}

function binaryPly(tris: V3[][]): ArrayBuffer {
  const header = strToU8(
    `ply\nformat binary_little_endian 1.0\nelement vertex ${tris.length * 3}\nproperty float x\nproperty float y\nproperty float z\n` +
    `element face ${tris.length}\nproperty list uchar int vertex_indices\nend_header\n`);
  const body = new ArrayBuffer(tris.length * 3 * 12 + tris.length * 13);
  const dv = new DataView(body);
  let o = 0;
  tris.forEach((t) => t.forEach((v) => v.forEach((c) => { dv.setFloat32(o, c, true); o += 4; })));
  tris.forEach((_, i) => { dv.setUint8(o++, 3); for (let k = 0; k < 3; k++) { dv.setInt32(o, i * 3 + k, true); o += 4; } });
  const out = new Uint8Array(header.length + body.byteLength);
  out.set(header);
  out.set(new Uint8Array(body), header.length);
  return out.buffer;
}

/** A 3MF zip around `modelXml`. */
function threeMf(modelXml: string, extra: Record<string, Uint8Array> = {}): ArrayBuffer {
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(modelXml),
    ...extra,
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

/** `<object>` with a mesh = the box [0,w] x [0,h] x [0,d] (8 vertices, 12 triangles), optional attrs. */
function boxObject(id: number, w: number, h: number, d: number, attrs = ''): string {
  const v: V3[] = [[0, 0, 0], [w, 0, 0], [w, h, 0], [0, h, 0], [0, 0, d], [w, 0, d], [w, h, d], [0, h, d]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]];
  return `<object id="${id}" type="model" ${attrs}><mesh><vertices>${v.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices>` +
    `<triangles>${t.map((q) => `<triangle v1="${q[0]}" v2="${q[1]}" v3="${q[2]}"/>`).join('')}</triangles></mesh></object>`;
}

const model = (unit: string | null, resources: string, build: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><model ${unit ? `unit="${unit}" ` : ''}xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${resources}</resources><build>${build}</build></model>`;

const approx = (a: number, b: number): void => expect(a).toBeCloseTo(b, 3);

describe('mesh-import-formats', () => {
  it('a binary STL cube 16 mm across reports 40 LDU', async () => {
    const obj = await loadMeshFromBytes(binaryStl(boxTriangles(16, 16, 16)), 'cube.stl');
    const e = meshExtentLdu(obj, { mode: 'real' });
    approx(e.x, 40); approx(e.y, 40); approx(e.z, 40);
    approx(e.lduPerUnit, 2.5);
    expect(LDU_PER_MM).toBe(2.5);
    expect(analyzeMesh(obj).triangleCount).toBe(12);
  });

  it('detects the new extensions case-insensitively', () => {
    expect(detectMeshType('A.STL')).toBe('stl');
    expect(detectMeshType('b.3mf')).toBe('3mf');
    expect(detectMeshType('c.ply')).toBe('ply');
    expect(detectMeshType('d.glb')).toBe('glb');
    expect(detectMeshType('e.step')).toBeNull();
  });

  it('an ASCII STL reads the same as the binary one', async () => {
    const obj = await loadMeshFromBytes(asciiStl(boxTriangles(16, 8, 24)), 'a.stl');
    const e = meshExtentLdu(obj, { mode: 'real' });
    expect(analyzeMesh(obj).triangleCount).toBe(12);
    approx(e.x, 40);
  });

  it('STL, PLY and 3MF are Z-up: the printer\'s Z becomes the model\'s height', async () => {
    // 16 (x) x 8 (y) x 24 (z) mm: z is the height -> 60 LDU tall, and the old y (8 mm) is the depth.
    const obj = await loadMeshFromBytes(binaryStl(boxTriangles(16, 8, 24)), 'tall.stl');
    const e = meshExtentLdu(obj, { mode: 'real' });
    approx(e.x, 40); approx(e.y, 60); approx(e.z, 20);
    const box = new THREE.Box3().setFromObject(obj);
    expect(box.min.y).toBeCloseTo(0, 4); // the part stays above the floor, not mirrored below it
  });

  it('an ASCII PLY with faces of 4 vertices is triangulated; a binary PLY loads too', async () => {
    const a = await loadMeshFromBytes(asciiPly(16, 16, 16), 'q.ply');
    expect(analyzeMesh(a).triangleCount).toBe(12);
    approx(meshExtentLdu(a, { mode: 'real' }).x, 40);
    const b = await loadMeshFromBytes(binaryPly(boxTriangles(16, 16, 16)), 'b.ply');
    expect(analyzeMesh(b).triangleCount).toBe(12);
    approx(meshExtentLdu(b, { mode: 'real' }).z, 40);
  });

  it('a PLY with no faces (a point cloud) is refused with a reason', async () => {
    const pts = strToU8('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n');
    await expect(loadMeshFromBytes(pts.buffer as ArrayBuffer, 'p.ply')).rejects.toThrow(/no faces|point cloud/i);
  });

  it('a 3MF reads vertices, triangles and the build item transform; its unit attribute sets the scale', async () => {
    const xml = model('millimeter', boxObject(1, 16, 16, 16),
      '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/>');
    const obj = await loadMeshFromBytes(threeMf(xml), 'cube.3mf');
    expect(analyzeMesh(obj).triangleCount).toBe(12);
    const e = meshExtentLdu(obj, { mode: 'real' });
    approx(e.x, 40);
    const box = new THREE.Box3().setFromObject(obj);
    approx(box.min.x, 100); // translated by the build transform
    // The same numbers in centimetres are ten times larger in the real world.
    const cm = await loadMeshFromBytes(threeMf(model('centimeter', boxObject(1, 1.6, 1.6, 1.6), '<item objectid="1"/>')), 'cm.3mf');
    approx(meshExtentLdu(cm, { mode: 'real' }).x, 40);
    // No unit attribute: the 3MF default is millimetres.
    const dflt = await loadMeshFromBytes(threeMf(model(null, boxObject(1, 16, 16, 16), '<item objectid="1"/>')), 'd.3mf');
    approx(meshExtentLdu(dflt, { mode: 'real' }).x, 40);
  });

  it('a 3MF component assembly places each referenced object with its own transform', async () => {
    const res = boxObject(1, 8, 8, 8) +
      '<object id="2" type="model"><components><component objectid="1"/><component objectid="1" transform="1 0 0 0 1 0 0 0 1 16 0 0"/></components></object>';
    const obj = await loadMeshFromBytes(threeMf(model('millimeter', res, '<item objectid="2"/>')), 'asm.3mf');
    expect(analyzeMesh(obj).triangleCount).toBe(24);
    approx(meshExtentLdu(obj, { mode: 'real' }).x, (16 + 8) * 2.5);
  });

  it('a 3MF base material colours its triangles', async () => {
    const res = '<basematerials id="5"><base name="red" displaycolor="#FF0000FF"/></basematerials>' + boxObject(1, 16, 16, 16, 'pid="5" pindex="0"');
    const obj = await loadMeshFromBytes(threeMf(model('millimeter', res, '<item objectid="1"/>')), 'red.3mf');
    let mesh: THREE.Mesh | undefined;
    obj.traverse((c) => { if (c instanceof THREE.Mesh) mesh = c; });
    const col = mesh!.geometry.getAttribute('color');
    expect(col).toBeDefined();
    approx(col.getX(0), 1); approx(col.getY(0), 0);
  });

  it('a 3MF with no mesh is refused with a reason', async () => {
    await expect(loadMeshFromBytes(threeMf(model('millimeter', '', '')), 'e.3mf')).rejects.toThrow(/no mesh|nothing to build/i);
    await expect(loadMeshFromBytes(new Uint8Array([1, 2, 3]).buffer, 'x.3mf')).rejects.toThrow(/3mf/i);
  });

  it('sizing: real size, fit to N studs, and an explicit scale', async () => {
    const obj = await loadMeshFromBytes(binaryStl(boxTriangles(16, 16, 40)), 'long.stl');
    approx(resolveLduPerUnit(obj, { mode: 'real' }), 2.5);
    // Fit the largest side (40 mm tall) to 10 studs = 200 LDU -> 5 LDU per mm.
    approx(resolveLduPerUnit(obj, { mode: 'fit', studs: 10 }), 5);
    const e = meshExtentLdu(obj, { mode: 'fit', studs: 10 });
    approx(e.y, 200); approx(e.x, 80);
    approx(resolveLduPerUnit(obj, { mode: 'scale', lduPerUnit: 7 }), 7);
    expect(() => resolveLduPerUnit(obj, { mode: 'fit', studs: 0 })).toThrow(/studs/i);
  });

  it('a GLB is in metres: 1 stud = 0.008 m', async () => {
    const glb = buildGlb({ positions: boxPositions(0.016, 0.016, 0.016), indices: boxIndices() });
    const obj = await loadMeshFromBytes(glb, 'cube.glb');
    approx(meshExtentLdu(obj, { mode: 'real' }).x, 40);
  });

  it('an uncompressed GLB reports no compression extension', () => {
    expect(gltfCompression(buildGlb({ positions: boxPositions(1, 1, 1), indices: boxIndices() }))).toEqual({ draco: false, meshopt: false });
  });

  it('a meshopt-compressed GLB decodes through the lazy decoder', async () => {
    await MeshoptEncoder.ready;
    const glb = buildGlb({ positions: boxPositions(0.016, 0.016, 0.016), indices: boxIndices(), meshopt: true });
    expect(gltfCompression(glb)).toEqual({ draco: false, meshopt: true });
    const obj = await loadMeshFromBytes(glb, 'cube.glb');
    expect(analyzeMesh(obj).triangleCount).toBe(12);
    approx(meshExtentLdu(obj, { mode: 'real' }).x, 40);
  });

  it('a GLB that requires Draco is recognised from its extension lists (gltf JSON too)', () => {
    const json = JSON.stringify({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'] });
    expect(gltfCompression(strToU8(json).buffer as ArrayBuffer)).toEqual({ draco: true, meshopt: false });
    expect(gltfCompression(new Uint8Array([0, 1, 2]).buffer)).toEqual({ draco: false, meshopt: false });
  });

  it('feeds the lattice: a 16 mm STL cube is 2 studs x 5 plates x 2 studs, all filled', async () => {
    const lat = await meshBytesToLattice(binaryStl(boxTriangles(16, 16, 16)), 'cube.stl', { mode: 'real' });
    expect(lat.dims).toEqual([2, 5, 2]);
    let n = 0;
    for (let p = 0; p < 5; p++) for (let z = 0; z < 2; z++) for (let x = 0; x < 2; x++) if (lat.cells[latticeIndex(lat.dims, x, p, z)]) n++;
    expect(n).toBe(20);
  });

  it('feeds the lattice at "fit to N studs": the same STL fitted to 4 studs is 4 wide', async () => {
    const lat = await meshBytesToLattice(binaryStl(boxTriangles(16, 16, 16)), 'cube.stl', { mode: 'fit', studs: 4 });
    expect(lat.dims[0]).toBe(4);
    expect(lat.dims[2]).toBe(4);
  });
});

// ---- GLB fixture builder (raw bytes; never GLTFExporter) ----

function boxPositions(w: number, h: number, d: number): Float32Array {
  return new Float32Array([0, 0, 0, w, 0, 0, w, h, 0, 0, h, 0, 0, 0, d, w, 0, d, w, h, d, 0, h, d]);
}
function boxIndices(): Uint16Array {
  return new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]);
}

const pad4 = (n: number): number => (n + 3) & ~3;

/** One-mesh GLB; `meshopt` stores the two buffer views EXT_meshopt_compression-encoded. */
function buildGlb({ positions, indices, meshopt = false }: { positions: Float32Array; indices: Uint16Array; meshopt?: boolean }): ArrayBuffer {
  const posRaw = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  const idxRaw = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
  const posEnc = meshopt ? MeshoptEncoder.encodeGltfBuffer(posRaw, positions.length / 3, 12, 'ATTRIBUTES') : posRaw;
  const idxEnc = meshopt ? MeshoptEncoder.encodeGltfBuffer(idxRaw, indices.length, 2, 'TRIANGLES') : idxRaw;
  const posOff = 0;
  const idxOff = pad4(posEnc.length);
  const binLen = pad4(idxOff + idxEnc.length);
  const bin = new Uint8Array(binLen);
  bin.set(posEnc, posOff);
  bin.set(idxEnc, idxOff);

  const bv = (raw: Uint8Array, enc: Uint8Array, off: number, count: number, stride: number, mode: string, target: number): Record<string, unknown> =>
    meshopt
      ? { buffer: 0, byteOffset: 0, byteLength: raw.length, target,
          extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: off, byteLength: enc.length, byteStride: stride, mode, count } } }
      : { buffer: 0, byteOffset: off, byteLength: raw.length, target };
  const posView = bv(posRaw, posEnc, posOff, positions.length / 3, 12, 'ATTRIBUTES', 34962);
  const idxView = bv(idxRaw, idxEnc, idxOff, indices.length, 2, 'TRIANGLES', 34963);
  if (meshopt) {
    // Views that point at the (absent) uncompressed copy: give them their own fallback buffer.
    posView.buffer = 1; idxView.buffer = 1; posView.byteOffset = 0; idxView.byteOffset = pad4(posRaw.length);
  }
  const mn = [0, 0, 0], mx = [0, 0, 0];
  for (let i = 0; i < positions.length; i++) mx[i % 3] = Math.max(mx[i % 3]!, positions[i]!);
  const json = {
    asset: { version: '2.0' },
    ...(meshopt ? { extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'] } : {}),
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: mn, max: mx },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [posView, idxView],
    buffers: meshopt
      ? [{ byteLength: binLen }, { byteLength: pad4(posRaw.length) + idxRaw.length, extensions: { EXT_meshopt_compression: { fallback: true } } }]
      : [{ byteLength: binLen }],
  };
  // The uncompressed layout needs its own offsets (views above used compressed offsets).
  if (!meshopt) { posView.byteOffset = 0; idxView.byteOffset = pad4(posRaw.length); bin.set(posRaw, 0); bin.set(idxRaw, pad4(posRaw.length)); }
  let jsonBytes = strToU8(JSON.stringify(json));
  const jpad = pad4(jsonBytes.length);
  const padded = new Uint8Array(jpad).fill(0x20);
  padded.set(jsonBytes);
  jsonBytes = padded;
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jsonBytes.length).set(jsonBytes);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, bin.length, true); dv.setUint32(o + 4, 0x004e4942, true);
  new Uint8Array(out, o + 8, bin.length).set(bin);
  return out;
}
