/** Hand-assembled GLBs for the photo3d tests (BIZ-39 / WP B15). */

const pad4 = (n: number): number => (n + 3) & ~3;

/** A minimal GLB: one mesh, POSITION + optional COLOR_0 (VEC3 float, linear), u16 indices, optional node translation. */
export function buildGlb(
  positions: number[],
  indices: number[],
  colours: number[] | null,
  opts: { translation?: [number, number, number]; texture?: boolean } = {},
): Uint8Array {
  const pos = new Float32Array(positions);
  const col = colours ? new Float32Array(colours) : null;
  const idx = new Uint16Array(indices);
  const chunks: Uint8Array[] = [
    new Uint8Array(pos.buffer),
    ...(col ? [new Uint8Array(col.buffer)] : []),
    new Uint8Array(idx.buffer),
  ];
  const offsets: number[] = [];
  let total = 0;
  for (const c of chunks) {
    offsets.push(total);
    total += pad4(c.length);
  }
  const bin = new Uint8Array(total);
  chunks.forEach((c, i) => bin.set(c, offsets[i]!));
  const views = chunks.map((c, i) => ({ buffer: 0, byteOffset: offsets[i], byteLength: c.length }));
  const accessors: unknown[] = [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3' },
  ];
  const attrs: Record<string, number> = { POSITION: 0 };
  if (col) {
    accessors.push({ bufferView: 1, componentType: 5126, count: col.length / 3, type: 'VEC3' });
    attrs['COLOR_0'] = 1;
  }
  accessors.push({ bufferView: chunks.length - 1, componentType: 5123, count: idx.length, type: 'SCALAR' });
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...(opts.translation ? { translation: opts.translation } : {}) }],
    meshes: [{ primitives: [{ attributes: attrs, indices: accessors.length - 1, ...(opts.texture ? { material: 0 } : {}) }] }],
    ...(opts.texture
      ? {
          materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
          textures: [{ source: 0 }],
          images: [{ uri: 'x.png' }],
        }
      : {}),
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: total }],
  };
  const raw = new TextEncoder().encode(JSON.stringify(json));
  const j = new Uint8Array(pad4(raw.length)).fill(0x20);
  j.set(raw);
  const out = new Uint8Array(12 + 8 + j.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  const o = 20 + j.length;
  dv.setUint32(o, bin.length, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  out.set(bin, o + 8);
  return out;
}

export const TETRA_V = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
export const TETRA_F = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
export const LINEAR = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1, 1, 1];

/** A closed, linear-coloured tetrahedron. */
export function buildTetraGlb(): Uint8Array {
  return buildGlb(TETRA_V, TETRA_F, LINEAR);
}
