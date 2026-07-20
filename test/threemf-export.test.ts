/**
 * 3MF export validation (color 3D-printing path) — offline, GPU-free.
 *
 * meshesTo3mf bakes instances into per-color merged meshes and packages an
 * OPC zip ([Content_Types].xml + _rels/.rels + 3D/3dmodel.model). These tests
 * generate a 3MF from synthetic instanced meshes, then round-trip it through
 * the repo's own ZIP reader (zip-utils) and validate: the 3 required archive
 * members exist, every XML part is well-formed, the basematerials group has
 * one <base> per unique color, each <object> binds pid/pindex to it, triangle
 * indices are in range, and geometry lands at real-world mm scale on z=0.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { meshesTo3mf, EXPORT_MM_PER_STUD, type ExportMeshLike } from '../web/src/viewer/exporter.js';
import { listZipEntries, extractFile } from '../web/src/engine/zip-utils.js';

/** A unit cube InstancedMesh stand-in with a solid material color. */
function cubeInstances(positions: [number, number, number][], color = 0xffffff): ExportMeshLike {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const originalMatrices = positions.map(([x, y, z]) =>
    new THREE.Matrix4().makeTranslation(x, y, z));
  return {
    geometry,
    material: new THREE.MeshStandardMaterial({ color }),
    userData: { originalMatrices },
  };
}

/** Instanced cubes with PER-INSTANCE colors (instanceColor + getColorAt). */
function coloredCubeInstances(entries: { pos: [number, number, number]; color: number }[]): ExportMeshLike {
  const base = cubeInstances(entries.map(e => e.pos), 0xffffff);
  base.instanceColor = {} as THREE.InstancedBufferAttribute; // truthiness gate only
  base.getColorAt = (i, c) => c.setHex(entries[i]!.color);
  return base;
}

/** Minimal structural XML well-formedness check (no DOM in node/vitest). */
function assertWellFormedXml(xml: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>/, '');
  const token = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+="[^"<>]*")*)\s*(\/?)>|([^<]+)/g;
  const stack: string[] = [];
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = token.exec(body)) !== null) {
    consumed += m[0].length;
    if (m[5] !== undefined) continue; // text node
    if (m[1] === '/') {
      const open = stack.pop();
      if (open !== m[2]) throw new Error(`mismatched </${m[2]}> (expected </${open}>)`);
    } else if (m[4] !== '/') {
      stack.push(m[2]!);
    }
  }
  if (consumed !== body.length) throw new Error('XML contains unparseable content');
  if (stack.length > 0) throw new Error(`unclosed tags: ${stack.join(', ')}`);
}

const dec = new TextDecoder();
async function extractText(zip: Uint8Array, name: string): Promise<string> {
  const buf = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
  return dec.decode(await extractFile(buf, name));
}

describe('meshesTo3mf', () => {
  it('produces an OPC zip with the 3 required members, all well-formed XML', async () => {
    const zip = await meshesTo3mf([cubeInstances([[0, 0, 0]], 0xc4281c)]);
    const buf = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;

    const names = listZipEntries(buf);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('3D/3dmodel.model');
    expect(names).toHaveLength(3);

    for (const name of names) {
      const text = await extractText(zip, name);
      assertWellFormedXml(text);
    }

    const ct = await extractText(zip, '[Content_Types].xml');
    expect(ct).toContain('application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
    const rels = await extractText(zip, '_rels/.rels');
    expect(rels).toContain('Target="/3D/3dmodel.model"');
  });

  it('one <base> per unique color, one <object> per color bound via pid/pindex, matching <build> items', async () => {
    // 3 instances in ONE InstancedMesh with per-instance colors red/red/blue,
    // plus a second mesh with a solid green material → 3 unique colors.
    const meshes = [
      coloredCubeInstances([
        { pos: [0, 0, 0], color: 0xff0000 },
        { pos: [2, 0, 0], color: 0xff0000 },
        { pos: [4, 0, 0], color: 0x0000ff },
      ]),
      cubeInstances([[0, 3, 0]], 0x00aa00),
    ];
    const zip = await meshesTo3mf(meshes);
    const model = await extractText(zip, '3D/3dmodel.model');
    assertWellFormedXml(model);

    expect(model).toContain('unit="millimeter"');
    const bases = [...model.matchAll(/<base name="[^"]*" displaycolor="#([0-9A-F]{6})" \/>/g)].map(m => m[1]);
    expect(new Set(bases)).toEqual(new Set(['FF0000', '0000FF', '00AA00']));

    const objects = [...model.matchAll(/<object id="(\d+)" type="model" pid="1" pindex="(\d+)">/g)];
    expect(objects).toHaveLength(3); // one per color
    const pindexes = objects.map(o => Number(o[2]));
    expect(new Set(pindexes)).toEqual(new Set([0, 1, 2])); // each object → its own base

    const items = [...model.matchAll(/<item objectid="(\d+)" \/>/g)].map(m => m[1]);
    expect(items.sort()).toEqual(objects.map(o => o[1]!).sort());

    // Red bucket merged BOTH red cubes: 24 shared BoxGeometry verts × 2, 12 tris × 2.
    const redObj = objects.find(o => Number(o[2]) === bases.indexOf('FF0000'))!;
    const objXml = model.slice(model.indexOf(`<object id="${redObj[1]}"`), model.indexOf('</object>', model.indexOf(`<object id="${redObj[1]}"`)));
    expect((objXml.match(/<vertex /g) ?? []).length).toBe(48);
    expect((objXml.match(/<triangle /g) ?? []).length).toBe(24);
  });

  it('triangle indices are in range and geometry is at mm scale, floored to z=0', async () => {
    const zip = await meshesTo3mf([cubeInstances([[0, 0, 0]])]);
    const model = await extractText(zip, '3D/3dmodel.model');

    const verts = [...model.matchAll(/<vertex x="([-\d.]+)" y="([-\d.]+)" z="([-\d.]+)" \/>/g)]
      .map(m => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
    expect(verts.length).toBe(24);
    const tris = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)" \/>/g)]
      .flatMap(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    expect(tris.length).toBe(36); // 12 tris
    for (const idx of tris) expect(idx).toBeLessThan(verts.length);

    // Unit cube at origin × 8 mm/stud: x,y span ±4; z floored onto the plate → [0, 8].
    const xs = verts.map(v => v[0]), ys = verts.map(v => v[1]), zs = verts.map(v => v[2]);
    expect(Math.max(...xs)).toBeCloseTo(EXPORT_MM_PER_STUD / 2, 3);
    expect(Math.min(...xs)).toBeCloseTo(-EXPORT_MM_PER_STUD / 2, 3);
    expect(Math.max(...ys)).toBeCloseTo(EXPORT_MM_PER_STUD / 2, 3);
    expect(Math.min(...zs)).toBeCloseTo(0, 3);
    expect(Math.max(...zs)).toBeCloseTo(EXPORT_MM_PER_STUD, 3);
  });

  it('throws on empty input instead of writing a geometry-less archive', async () => {
    await expect(meshesTo3mf([])).rejects.toThrow(/no geometry/);
  });
});
