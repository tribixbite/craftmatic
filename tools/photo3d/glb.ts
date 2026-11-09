/**
 * A small GLB reader for the generated meshes (BIZ-39 / WP B15): positions, triangle indices and vertex
 * colours with node transforms applied, plus a closedness check. No dependencies; it reads what ComfyUI's
 * `Save3DAdvanced` writes (one or more triangle primitives, `COLOR_0` as linear RGB(A)).
 *
 * `COLOR_0` is LINEAR in glTF, so it is converted to sRGB 0..255 here (pokefit `_glb_vertex_colours` does the same).
 */

export interface GlbMesh {
  /** xyz per vertex, node transforms applied. */
  vertices: Float32Array;
  /** Three vertex indices per triangle. */
  faces: Uint32Array;
  /** sRGB rgb per vertex, 0..255 (mid grey where a primitive has no colour). */
  colours: Uint8Array;
  /** Some primitive carried a COLOR_0 attribute. */
  hasVertexColour: boolean;
  /** Some material colours by a texture image (UV-baked) rather than per vertex. */
  hasTexture: boolean;
}

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
}

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number; material?: number }[] }[];
  materials?: Record<string, unknown>[];
  accessors?: Accessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
/** Mat4 as 16 numbers, column-major like glTF. */
type Mat4 = number[];

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function nodeMatrix(n: GltfNode): Mat4 {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const x2 = qx! + qx!, y2 = qy! + qy!, z2 = qz! + qz!;
  const xx = qx! * x2, xy = qx! * y2, xz = qx! * z2, yy = qy! * y2, yz = qy! * z2, zz = qz! * z2;
  const wx = qw! * x2, wy = qw! * y2, wz = qw! * z2;
  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

/** Linear 0..1 to sRGB 0..1 (the standard transfer function). */
export function linearToSrgb(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Parse a GLB container into its JSON and binary chunk. */
function parseContainer(bytes: Uint8Array): { json: Gltf; bin: Uint8Array } {
  if (bytes.length < 20) throw new Error('not a GLB: too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB: bad magic');
  if (dv.getUint32(4, true) !== 2) throw new Error('unsupported GLB version');
  let off = 12;
  let json: Gltf | null = null;
  let bin: Uint8Array = new Uint8Array(0);
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const body = bytes.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as Gltf;
    else if (type === 0x004e4942 && bin.length === 0) bin = body;
    off += 8 + len;
  }
  if (!json) throw new Error('not a GLB: no JSON chunk');
  return { json, bin };
}

/** Read an accessor as numbers (normalised integer types mapped to 0..1 / -1..1 when `normalized`). */
function readAccessor(g: Gltf, bin: Uint8Array, index: number): { data: Float64Array; width: number; count: number } {
  const acc = g.accessors?.[index];
  if (!acc) throw new Error(`GLB accessor ${index} missing`);
  const width = COMPONENTS[acc.type];
  const csize = COMPONENT_BYTES[acc.componentType];
  if (!width || !csize) throw new Error(`unsupported accessor ${acc.type}/${acc.componentType}`);
  const out = new Float64Array(acc.count * width);
  if (acc.bufferView === undefined) return { data: out, width, count: acc.count }; // all zeros by spec
  const view = g.bufferViews?.[acc.bufferView];
  if (!view) throw new Error(`GLB bufferView ${acc.bufferView} missing`);
  const stride = view.byteStride ?? width * csize;
  const base = bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(bin.buffer);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < width; c++) {
      const at = base + i * stride + c * csize;
      let v: number;
      switch (acc.componentType) {
        case 5126: v = dv.getFloat32(at, true); break;
        case 5125: v = dv.getUint32(at, true); break;
        case 5123: v = dv.getUint16(at, true); if (acc.normalized) v /= 65535; break;
        case 5122: v = dv.getInt16(at, true); if (acc.normalized) v = Math.max(v / 32767, -1); break;
        case 5121: v = dv.getUint8(at); if (acc.normalized) v /= 255; break;
        default: v = dv.getInt8(at); if (acc.normalized) v = Math.max(v / 127, -1);
      }
      out[i * width + c] = v;
    }
  }
  return { data: out, width, count: acc.count };
}

/** Read every triangle primitive of the default scene into one mesh, node transforms applied. */
export function readGlb(bytes: Uint8Array): GlbMesh {
  const { json: g, bin } = parseContainer(bytes);
  const verts: number[] = [];
  const faces: number[] = [];
  const cols: number[] = [];
  let hasVertexColour = false;

  const visit = (ni: number, parent: Mat4): void => {
    const node = g.nodes?.[ni];
    if (!node) return;
    const m = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of g.meshes?.[node.mesh]?.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4) continue; // triangles only
        const posIdx = prim.attributes['POSITION'];
        if (posIdx === undefined) continue;
        const pos = readAccessor(g, bin, posIdx);
        const base = verts.length / 3;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.data[i * 3]!, y = pos.data[i * 3 + 1]!, z = pos.data[i * 3 + 2]!;
          verts.push(
            m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
            m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
            m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
          );
        }
        if (prim.indices !== undefined) {
          const idx = readAccessor(g, bin, prim.indices);
          for (let i = 0; i + 2 < idx.count; i += 3) faces.push(base + idx.data[i]!, base + idx.data[i + 1]!, base + idx.data[i + 2]!);
        } else {
          for (let i = 0; i + 2 < pos.count; i += 3) faces.push(base + i, base + i + 1, base + i + 2);
        }
        const cIdx = prim.attributes['COLOR_0'];
        if (cIdx !== undefined) {
          const col = readAccessor(g, bin, cIdx);
          hasVertexColour = true;
          for (let i = 0; i < col.count; i++) {
            for (let c = 0; c < 3; c++) cols.push(Math.round(linearToSrgb(col.data[i * col.width + c]!) * 255));
          }
        } else {
          for (let i = 0; i < pos.count; i++) cols.push(128, 128, 128); // no colour: mid grey
        }
      }
    }
    for (const child of node.children ?? []) visit(child, m);
  };

  const scene = g.scenes?.[g.scene ?? 0];
  const roots = scene?.nodes ?? (g.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, IDENTITY);
  if (verts.length === 0) throw new Error('the GLB has no mesh');

  const hasTexture = (g.materials ?? []).some((mat) => {
    const pbr = (mat['pbrMetallicRoughness'] ?? {}) as Record<string, unknown>;
    return Boolean(pbr['baseColorTexture'] ?? mat['emissiveTexture']);
  });
  return {
    vertices: Float32Array.from(verts),
    faces: Uint32Array.from(faces),
    colours: Uint8Array.from(cols),
    hasVertexColour,
    hasTexture,
  };
}

export interface MeshStats {
  vertices: number;
  faces: number;
  /** Edges used by exactly one triangle (after welding coincident vertices). */
  openEdges: number;
  /** Edges used by three or more triangles. */
  nonManifoldEdges: number;
  /** Welded vertices connected through shared triangles. */
  components: number;
  /** No open edge and at least one face. */
  closed: boolean;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** Closedness and connectivity of a mesh; vertices closer than 1e-5 of the bbox diagonal are welded. */
export function meshStats(mesh: GlbMesh): MeshStats {
  const n = mesh.vertices.length / 3;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = mesh.vertices[i * 3 + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const q = diag * 1e-5;
  const weld = new Map<string, number>();
  const ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const key = [0, 1, 2].map((a) => Math.round(mesh.vertices[i * 3 + a]! / q)).join(',');
    let id = weld.get(key);
    if (id === undefined) {
      id = weld.size;
      weld.set(key, id);
    }
    ids[i] = id;
  }
  const parent = Array.from({ length: weld.size }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const edges = new Map<number, number>();
  const nv = weld.size;
  const faceCount = mesh.faces.length / 3;
  for (let f = 0; f < faceCount; f++) {
    const t = [ids[mesh.faces[f * 3]!]!, ids[mesh.faces[f * 3 + 1]!]!, ids[mesh.faces[f * 3 + 2]!]!];
    for (let e = 0; e < 3; e++) {
      const a = t[e]!, b = t[(e + 1) % 3]!;
      if (a === b) continue; // a collapsed edge
      const key = Math.min(a, b) * nv + Math.max(a, b);
      edges.set(key, (edges.get(key) ?? 0) + 1);
      parent[find(a)] = find(b);
    }
  }
  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const c of edges.values()) {
    if (c === 1) openEdges++;
    else if (c > 2) nonManifoldEdges++;
  }
  const used = new Set<number>();
  for (let f = 0; f < faceCount * 3; f++) used.add(find(ids[mesh.faces[f]!]!));
  return {
    vertices: n,
    faces: faceCount,
    openEdges,
    nonManifoldEdges,
    components: used.size,
    closed: faceCount > 0 && openEdges === 0,
    bounds: { min, max },
  };
}
