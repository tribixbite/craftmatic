/**
 * glTF 2.0 binary (GLB) writer — pure, no DOM/Canvas required.
 *
 * Extracted from the inline writer in `scripts/tiles-headless.ts` (lines
 * 616-830) into a reusable module consumed by:
 *   • `src/pipeline/capture/tiles.ts`  — tile-capture GLB
 *   • `src/pipeline/export/glb-print.ts` — printable B-rep GLB (multi-group)
 *   • `src/pipeline/export/glb-scene.ts` — decorated scene GLB
 *
 * Multi-group output: meshes carry an optional `groupName` that the writer
 * turns into a named scene node. Slicers (Prusa/Cura) read these groups so
 * the consumer can ship structural + fixtures + plinth in one file.
 *
 * Spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification
 */

/** One mesh input to the writer. Buffers are small enough to be inline. */
export interface MeshInput {
  readonly position: Float32Array;
  readonly normal?: Float32Array | null;
  readonly uv?: Float32Array | null;
  readonly index?: Uint32Array | null;
  /** JPEG-encoded texture bytes, or null for untextured meshes. */
  readonly textureJpeg?: Uint8Array | null;
  readonly texWidth?: number;
  readonly texHeight?: number;
  /** PBR baseColorFactor, RGBA (0-1). Default mid-grey. */
  readonly baseColorFactor?: readonly [number, number, number, number];
  /** Optional scene-node name (spec §Stage 8a group_structural / fixtures / plinth). */
  readonly groupName?: string;
  /** Optional material name — helps slicers report which mesh is which. */
  readonly materialName?: string;
}

export interface BuildGlbOptions {
  /** `asset.generator` string in the glTF JSON. */
  readonly generator?: string;
  /**
   * Material overrides: emitted as glTF `extras.minecraftBlock` so downstream
   * voxel exporters can read the intended block without re-inferring from colour.
   * Keyed by array index = mesh index in the input array.
   */
  readonly minecraftBlocks?: ReadonlyArray<string | undefined>;
}

// ─── Implementation ────────────────────────────────────────────────────────

type GltfAccessor = {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: readonly number[];
  max?: readonly number[];
};

type GltfBufferView = { buffer: 0; byteOffset: number; byteLength: number; target?: number };

type GltfMaterial = {
  name?: string;
  pbrMetallicRoughness: {
    baseColorFactor?: readonly [number, number, number, number];
    baseColorTexture?: { index: number };
    metallicFactor: number;
    roughnessFactor: number;
  };
  extras?: Record<string, unknown>;
};

type GltfMesh = {
  primitives: ReadonlyArray<{
    attributes: Record<string, number>;
    indices?: number;
    material: number;
    mode: 4;
  }>;
};

type GltfNode = {
  mesh: number;
  name?: string;
};

interface GltfRoot {
  asset: { version: '2.0'; generator: string };
  scene: 0;
  scenes: ReadonlyArray<{ nodes: readonly number[] }>;
  nodes: readonly GltfNode[];
  meshes: readonly GltfMesh[];
  accessors: readonly GltfAccessor[];
  bufferViews: readonly GltfBufferView[];
  materials: readonly GltfMaterial[];
  buffers: readonly [{ byteLength: number }];
  textures?: ReadonlyArray<{ sampler: number; source: number }>;
  images?: ReadonlyArray<{ bufferView: number; mimeType: string }>;
  samplers?: ReadonlyArray<{ magFilter: number; minFilter: number; wrapS: number; wrapT: number }>;
}

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UINT32 = 5125;
const LINEAR = 9729;
const LINEAR_MIPMAP_LINEAR = 9987;
const CLAMP_TO_EDGE = 33071;

export function buildGlb(meshes: readonly MeshInput[], opts: BuildGlbOptions = {}): ArrayBuffer {
  const bufferViews: GltfBufferView[] = [];
  const accessors: GltfAccessor[] = [];
  const gltfMeshes: GltfMesh[] = [];
  const nodes: GltfNode[] = [];
  const materials: GltfMaterial[] = [];
  const textures: Array<{ sampler: number; source: number }> = [];
  const images: Array<{ bufferView: number; mimeType: string }> = [];
  const samplers = [{
    magFilter: LINEAR,
    minFilter: LINEAR_MIPMAP_LINEAR,
    wrapS: CLAMP_TO_EDGE,
    wrapT: CLAMP_TO_EDGE,
  }];
  const binaryChunks: ArrayBuffer[] = [];
  let byteOffset = 0;

  const addBufferView = (data: ArrayBufferLike, target?: number): number => {
    const idx = bufferViews.length;
    const view: GltfBufferView = { buffer: 0, byteOffset, byteLength: data.byteLength };
    if (target !== undefined) view.target = target;
    bufferViews.push(view);
    // Copy into a plain ArrayBuffer — typed-array source may be SharedArrayBuffer
    // or a larger backing buffer (e.g. views with byteOffset != 0).
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(new Uint8Array(data as ArrayBuffer));
    binaryChunks.push(copy);
    byteOffset += data.byteLength;
    const pad = (4 - (data.byteLength % 4)) % 4;
    if (pad > 0) {
      binaryChunks.push(new ArrayBuffer(pad));
      byteOffset += pad;
    }
    return idx;
  };

  const addAccessor = (
    bufferView: number,
    componentType: number,
    count: number,
    type: string,
    min?: readonly number[],
    max?: readonly number[],
  ): number => {
    const idx = accessors.length;
    const acc: GltfAccessor = { bufferView, componentType, count, type };
    if (min) acc.min = min;
    if (max) acc.max = max;
    accessors.push(acc);
    return idx;
  };

  meshes.forEach((m, i) => {
    const attributes: Record<string, number> = {};

    // Position + bounding box (required)
    const posView = addBufferView(m.position.buffer, ARRAY_BUFFER);
    const posMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const posMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < m.position.length; j += 3) {
      const x = m.position[j], y = m.position[j + 1], z = m.position[j + 2];
      if (x < posMin[0]) posMin[0] = x;
      if (y < posMin[1]) posMin[1] = y;
      if (z < posMin[2]) posMin[2] = z;
      if (x > posMax[0]) posMax[0] = x;
      if (y > posMax[1]) posMax[1] = y;
      if (z > posMax[2]) posMax[2] = z;
    }
    attributes['POSITION'] = addAccessor(posView, FLOAT, m.position.length / 3, 'VEC3', posMin, posMax);

    if (m.normal) {
      const nView = addBufferView(m.normal.buffer, ARRAY_BUFFER);
      attributes['NORMAL'] = addAccessor(nView, FLOAT, m.normal.length / 3, 'VEC3');
    }

    if (m.uv) {
      const uvView = addBufferView(m.uv.buffer, ARRAY_BUFFER);
      attributes['TEXCOORD_0'] = addAccessor(uvView, FLOAT, m.uv.length / 2, 'VEC2');
    }

    let indices: number | undefined;
    if (m.index) {
      const idxView = addBufferView(m.index.buffer, ELEMENT_ARRAY_BUFFER);
      indices = addAccessor(idxView, UINT32, m.index.length, 'SCALAR');
    }

    // Material
    const matIdx = materials.length;
    const material: GltfMaterial = {
      pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 },
    };
    if (m.materialName) material.name = m.materialName;
    const mcBlock = opts.minecraftBlocks?.[i];
    if (mcBlock) material.extras = { minecraftBlock: mcBlock };

    if (m.textureJpeg && m.uv) {
      const imgView = addBufferView(m.textureJpeg.buffer);
      const imgIdx = images.length;
      images.push({ bufferView: imgView, mimeType: 'image/jpeg' });
      const texIdx = textures.length;
      textures.push({ sampler: 0, source: imgIdx });
      material.pbrMetallicRoughness.baseColorTexture = { index: texIdx };
    } else {
      material.pbrMetallicRoughness.baseColorFactor = m.baseColorFactor ?? [0.5, 0.5, 0.5, 1.0];
    }
    materials.push(material);

    gltfMeshes.push({
      primitives: [{ attributes, mode: 4, material: matIdx, ...(indices !== undefined ? { indices } : {}) }],
    });
    const node: GltfNode = { mesh: i };
    if (m.groupName) node.name = m.groupName;
    nodes.push(node);
  });

  const gltf: GltfRoot = {
    asset: { version: '2.0', generator: opts.generator ?? 'craftmatic-glb-writer' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    accessors,
    bufferViews,
    materials,
    buffers: [{ byteLength: byteOffset }],
  };
  if (textures.length > 0) {
    (gltf as Writable<GltfRoot>).textures = textures;
    (gltf as Writable<GltfRoot>).images = images;
    (gltf as Writable<GltfRoot>).samplers = samplers;
  }

  const jsonStr = JSON.stringify(gltf);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = new Uint8Array(jsonBytes.length + jsonPad);
  jsonChunk.set(jsonBytes);
  jsonChunk.fill(0x20, jsonBytes.length);

  const binChunk = new Uint8Array(byteOffset);
  let off = 0;
  for (const chunk of binaryChunks) {
    binChunk.set(new Uint8Array(chunk), off);
    off += chunk.byteLength;
  }

  const totalLen = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = new ArrayBuffer(totalLen);
  const view = new DataView(glb);

  // GLB header
  view.setUint32(0, 0x46546C67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLen, true);

  // JSON chunk
  view.setUint32(12, jsonChunk.length, true);
  view.setUint32(16, 0x4E4F534A, true); // "JSON"
  new Uint8Array(glb, 20).set(jsonChunk);

  // BIN chunk
  const binOff = 20 + jsonChunk.length;
  view.setUint32(binOff, binChunk.length, true);
  view.setUint32(binOff + 4, 0x004E4942, true); // "BIN\0"
  new Uint8Array(glb, binOff + 8).set(binChunk);

  return glb;
}

// ─── Small helpers ─────────────────────────────────────────────────────────

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** Minimal header sanity check — returns the JSON object embedded in the GLB. */
export function parseGlbJson(glb: ArrayBuffer): GltfRoot {
  const view = new DataView(glb);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546C67) throw new Error('Not a GLB file (bad magic)');
  if (view.getUint32(4, true) !== 2) throw new Error('GLB version must be 2');
  const jsonLen = view.getUint32(12, true);
  const jsonType = view.getUint32(16, true);
  if (jsonType !== 0x4E4F534A) throw new Error('First chunk is not JSON');
  const jsonBytes = new Uint8Array(glb, 20, jsonLen);
  return JSON.parse(new TextDecoder().decode(jsonBytes)) as GltfRoot;
}

/**
 * Read positions+indices for every mesh primitive in a GLB. Returns one
 * `{ positions, indices }` entry per primitive, in scene-local metres
 * matching the source coordinate frame (Y is up — both `buildGlb` and
 * Google 3D Tiles use this convention).
 *
 * Used by `--tiles-glb` and `extract-tile-meshes-from-glb` to feed local
 * cached photogrammetry into the slice synthesizer without round-tripping
 * through Three.js / TilesRenderer.
 */
export function parseGlbMeshes(glb: ArrayBuffer): Array<{
  positions: Float32Array;
  indices: Uint32Array;
}> {
  const root = parseGlbJson(glb);
  const view = new DataView(glb);
  const jsonLen = view.getUint32(12, true);
  // BIN chunk follows JSON chunk: 12 byte header + jsonLen + 8 byte chunk header
  const binChunkOffset = 20 + jsonLen + 8;
  const out: Array<{ positions: Float32Array; indices: Uint32Array }> = [];

  const readAccessor = (accessorIdx: number): {
    bytes: Uint8Array;
    count: number;
    componentType: number;
    typeSize: number;
  } => {
    const acc = root.accessors[accessorIdx];
    const bv = root.bufferViews[acc.bufferView];
    const off = binChunkOffset + bv.byteOffset;
    const bytes = new Uint8Array(glb, off, bv.byteLength);
    const typeSize = TYPE_COMPONENT_COUNT[acc.type] ?? 1;
    return { bytes, count: acc.count, componentType: acc.componentType, typeSize };
  };

  const toFloat32 = (bytes: Uint8Array, count: number, componentType: number, typeSize: number): Float32Array => {
    if (componentType !== 5126) throw new Error(`POSITION must be FLOAT (5126), got ${componentType}`);
    return new Float32Array(bytes.buffer, bytes.byteOffset, count * typeSize);
  };

  const toUint32 = (bytes: Uint8Array, count: number, componentType: number): Uint32Array => {
    if (componentType === 5125) {
      return new Uint32Array(bytes.buffer, bytes.byteOffset, count);
    }
    if (componentType === 5123) {
      const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, count);
      const out = new Uint32Array(count);
      for (let i = 0; i < count; i++) out[i] = u16[i];
      return out;
    }
    if (componentType === 5121) {
      const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, count);
      const out = new Uint32Array(count);
      for (let i = 0; i < count; i++) out[i] = u8[i];
      return out;
    }
    throw new Error(`Unsupported index componentType ${componentType}`);
  };

  for (const mesh of root.meshes) {
    for (const prim of mesh.primitives) {
      const posIdx = prim.attributes['POSITION'];
      if (posIdx === undefined) continue;
      const posAcc = readAccessor(posIdx);
      // Position bytes may not be 4-aligned within the mega-buffer;
      // copy into a fresh Float32Array if so.
      let positions: Float32Array;
      const aligned = (posAcc.bytes.byteOffset % 4) === 0;
      if (aligned) {
        positions = toFloat32(posAcc.bytes, posAcc.count, posAcc.componentType, posAcc.typeSize);
      } else {
        const copy = new Uint8Array(posAcc.bytes);
        positions = new Float32Array(copy.buffer, copy.byteOffset, posAcc.count * posAcc.typeSize);
      }

      let indices: Uint32Array;
      if (prim.indices !== undefined) {
        const idxAcc = readAccessor(prim.indices);
        indices = toUint32(idxAcc.bytes, idxAcc.count, idxAcc.componentType);
      } else {
        // Non-indexed: synthesize 0..n-1
        indices = new Uint32Array(posAcc.count);
        for (let i = 0; i < indices.length; i++) indices[i] = i;
      }

      // Copy to detach from the shared GLB buffer (callers may mutate or hold)
      out.push({
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
      });
    }
  }
  return out;
}

const TYPE_COMPONENT_COUNT: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

/**
 * Full GLB mesh extraction including UVs and texture image bytes for
 * the photogrammetry color-transfer pipeline. Each primitive emits:
 *   • positions, indices (same as parseGlbMeshes)
 *   • uvs — TEXCOORD_0 attribute, or null if absent
 *   • textureImage — JPEG/PNG bytes from the material's baseColorTexture,
 *     or null if the material has no texture / falls back to factor
 *   • textureMime — 'image/jpeg' or 'image/png' to drive decoding
 */
export interface FullMeshPrimitive {
  positions: Float32Array;
  indices: Uint32Array;
  uvs: Float32Array | null;
  textureImage: Uint8Array | null;
  textureMime: 'image/jpeg' | 'image/png' | null;
  /** baseColorFactor RGBA when no texture, else null. */
  baseColorFactor: readonly [number, number, number, number] | null;
}

export function parseGlbMeshesFull(glb: ArrayBuffer): FullMeshPrimitive[] {
  const root = parseGlbJson(glb);
  const view = new DataView(glb);
  const jsonLen = view.getUint32(12, true);
  const binChunkOffset = 20 + jsonLen + 8;
  const out: FullMeshPrimitive[] = [];

  const readBufferView = (bvIdx: number): Uint8Array => {
    const bv = root.bufferViews[bvIdx];
    return new Uint8Array(glb, binChunkOffset + bv.byteOffset, bv.byteLength);
  };

  const readAccessor = (accessorIdx: number): {
    bytes: Uint8Array;
    count: number;
    componentType: number;
    typeSize: number;
  } => {
    const acc = root.accessors[accessorIdx];
    const bv = root.bufferViews[acc.bufferView];
    const off = binChunkOffset + bv.byteOffset;
    const bytes = new Uint8Array(glb, off, bv.byteLength);
    const typeSize = TYPE_COMPONENT_COUNT[acc.type] ?? 1;
    return { bytes, count: acc.count, componentType: acc.componentType, typeSize };
  };

  const toFloat32 = (bytes: Uint8Array, count: number, typeSize: number): Float32Array => {
    if ((bytes.byteOffset % 4) === 0) {
      return new Float32Array(bytes.buffer, bytes.byteOffset, count * typeSize);
    }
    const copy = new Uint8Array(bytes);
    return new Float32Array(copy.buffer, copy.byteOffset, count * typeSize);
  };

  const toUint32 = (bytes: Uint8Array, count: number, componentType: number): Uint32Array => {
    if (componentType === 5125) {
      if ((bytes.byteOffset % 4) === 0) return new Uint32Array(bytes.buffer, bytes.byteOffset, count);
      const copy = new Uint8Array(bytes);
      return new Uint32Array(copy.buffer, copy.byteOffset, count);
    }
    if (componentType === 5123) {
      const aligned = (bytes.byteOffset % 2) === 0;
      const u16 = aligned
        ? new Uint16Array(bytes.buffer, bytes.byteOffset, count)
        : new Uint16Array(new Uint8Array(bytes).buffer);
      const out = new Uint32Array(count);
      for (let i = 0; i < count; i++) out[i] = u16[i];
      return out;
    }
    if (componentType === 5121) {
      const out = new Uint32Array(count);
      for (let i = 0; i < count; i++) out[i] = bytes[i];
      return out;
    }
    throw new Error(`Unsupported index componentType ${componentType}`);
  };

  for (const mesh of root.meshes) {
    for (const prim of mesh.primitives) {
      const posIdx = prim.attributes['POSITION'];
      if (posIdx === undefined) continue;
      const posAcc = readAccessor(posIdx);
      const positions = new Float32Array(toFloat32(posAcc.bytes, posAcc.count, posAcc.typeSize));

      let indices: Uint32Array;
      if (prim.indices !== undefined) {
        const idxAcc = readAccessor(prim.indices);
        indices = new Uint32Array(toUint32(idxAcc.bytes, idxAcc.count, idxAcc.componentType));
      } else {
        indices = new Uint32Array(posAcc.count);
        for (let i = 0; i < indices.length; i++) indices[i] = i;
      }

      let uvs: Float32Array | null = null;
      const uvIdx = prim.attributes['TEXCOORD_0'];
      if (uvIdx !== undefined) {
        const uvAcc = readAccessor(uvIdx);
        uvs = new Float32Array(toFloat32(uvAcc.bytes, uvAcc.count, uvAcc.typeSize));
      }

      let textureImage: Uint8Array | null = null;
      let textureMime: 'image/jpeg' | 'image/png' | null = null;
      let baseColorFactor: readonly [number, number, number, number] | null = null;
      if (prim.material !== undefined && root.materials) {
        const mat = root.materials[prim.material];
        const tex = mat?.pbrMetallicRoughness?.baseColorTexture;
        if (tex !== undefined && root.textures && root.images) {
          const texEntry = root.textures[tex.index];
          const img = texEntry ? root.images[texEntry.source] : undefined;
          if (img && img.bufferView !== undefined) {
            textureImage = new Uint8Array(readBufferView(img.bufferView));
            textureMime = img.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
          }
        }
        if (textureImage === null && mat?.pbrMetallicRoughness?.baseColorFactor) {
          baseColorFactor = mat.pbrMetallicRoughness.baseColorFactor;
        }
      }

      out.push({ positions, indices, uvs, textureImage, textureMime, baseColorFactor });
    }
  }
  return out;
}
