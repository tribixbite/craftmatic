/**
 * Browser-global polyfills and DRACO decoder setup needed to run Three.js +
 * `3d-tiles-renderer` + `DRACOLoader` inside headless Node/Bun.
 *
 * These were previously inlined at the top of `scripts/tiles-headless.ts`.
 * Extracted here so CLI entry (`scripts/build.ts`, legacy `tiles-headless.ts`)
 * and test harnesses share one implementation.
 *
 * The functions are idempotent — calling twice is safe.
 */

import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { resolve } from 'node:path';

/**
 * Install the browser globals `3d-tiles-renderer` + Three.js expect when
 * running outside a browser.
 *
 * Safe to call repeatedly — each polyfill checks for its own absence first.
 */
export function installNodePolyfills(): void {
  const g = globalThis as unknown as Record<string, unknown>;

  if (typeof g['window'] === 'undefined') {
    g['window'] = { location: { href: 'https://localhost/' } };
  }

  if (typeof g['document'] === 'undefined') {
    g['document'] = {
      createElementNS: () => ({}),
      createElement: () => ({ style: {} }),
    };
  }

  if (typeof g['DOMParser'] === 'undefined') {
    class StubDOMParser {
      parseFromString(): { documentElement: object } { return { documentElement: {} }; }
    }
    g['DOMParser'] = StubDOMParser;
  }

  // rAF/cAF polyfills — 3d-tiles-renderer uses these for scheduling
  if (typeof g['requestAnimationFrame'] === 'undefined') {
    let rafId = 0;
    const rafCallbacks = new Map<number, ReturnType<typeof setTimeout>>();
    g['requestAnimationFrame'] = (cb: () => void) => {
      const id = ++rafId;
      rafCallbacks.set(id, setTimeout(() => { rafCallbacks.delete(id); cb(); }, 0));
      return id;
    };
    g['cancelAnimationFrame'] = (id: number) => {
      const handle = rafCallbacks.get(id);
      if (handle) { clearTimeout(handle); rafCallbacks.delete(id); }
    };
  }

  // ImageBitmap polyfill — Three.js texture loader checks for it via instanceof.
  if (typeof g['ImageBitmap'] === 'undefined') {
    class StubImageBitmap {
      width = 1;
      height = 1;
      close(): void { /* noop */ }
    }
    g['ImageBitmap'] = StubImageBitmap;
  }

  // createImageBitmap — decodes via `sharp` so texture pixel data is real.
  if (typeof g['createImageBitmap'] === 'undefined') {
    g['createImageBitmap'] = async (source: Blob | ArrayBuffer) => {
      try {
        const sharpMod = (await import('sharp')).default;
        let buf: Buffer;
        if (source instanceof Blob) {
          buf = Buffer.from(await source.arrayBuffer());
        } else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
          buf = Buffer.from(source as ArrayBuffer);
        } else {
          return new (g['ImageBitmap'] as new () => unknown)();
        }
        const img = sharpMod(buf);
        const meta = await img.metadata();
        const pixels = await img.raw().ensureAlpha().toBuffer();
        return {
          width: meta.width ?? 1,
          height: meta.height ?? 1,
          data: new Uint8Array(pixels),
          close(): void { /* noop */ },
        };
      } catch {
        return new (g['ImageBitmap'] as new () => unknown)();
      }
    };
  }

  // ProgressEvent polyfill — Three.js FileLoader's fetch-streaming uses it.
  if (typeof g['ProgressEvent'] === 'undefined') {
    class StubProgressEvent extends Event {
      lengthComputable: boolean;
      loaded: number;
      total: number;
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type);
        this.lengthComputable = (init['lengthComputable'] as boolean) ?? false;
        this.loaded = (init['loaded'] as number) ?? 0;
        this.total = (init['total'] as number) ?? 0;
      }
    }
    g['ProgressEvent'] = StubProgressEvent;
  }
}

// ─── DRACO decoder (main-thread, WASM-free) ─────────────────────────────────
//
// Bun Workers can't run the emscripten-compiled `draco_decoder.js`, so we
// load the JS build in the main thread and monkey-patch `DRACOLoader` to
// decode inline. Reproduces the DRACOWorker internals from Three.js.

interface DracoModule {
  Decoder: new () => DracoDecoderInstance;
  Mesh: new () => DracoGeomInstance;
  PointCloud: new () => DracoGeomInstance;
  TRIANGULAR_MESH: number;
  POINT_CLOUD: number;
  DT_FLOAT32: number;
  DT_INT8: number;
  DT_INT16: number;
  DT_INT32: number;
  DT_UINT8: number;
  DT_UINT16: number;
  DT_UINT32: number;
  HEAPF32: { buffer: ArrayBuffer };
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  destroy: (obj: unknown) => void;
  [key: string]: unknown;
}

interface DracoDecoderInstance {
  GetEncodedGeometryType(array: Int8Array): number;
  DecodeArrayToMesh(array: Int8Array, size: number, mesh: DracoGeomInstance): DracoDecodingStatus;
  DecodeArrayToPointCloud(array: Int8Array, size: number, pc: DracoGeomInstance): DracoDecodingStatus;
  GetAttributeByUniqueId(geom: DracoGeomInstance, id: number): DracoAttribute;
  GetAttributeId(geom: DracoGeomInstance, type: number): number;
  GetAttribute(geom: DracoGeomInstance, id: number): DracoAttribute;
  GetAttributeDataArrayForAllPoints(
    geom: DracoGeomInstance, attr: DracoAttribute, dataType: number,
    byteLen: number, ptr: number,
  ): void;
  GetTrianglesUInt32Array(geom: DracoGeomInstance, byteLen: number, ptr: number): void;
}

interface DracoGeomInstance {
  ptr: number;
  num_points(): number;
  num_faces(): number;
}

interface DracoAttribute {
  num_components(): number;
}

interface DracoDecodingStatus {
  ok(): boolean;
  error_msg(): string;
}

function getDracoDataType(
  draco: DracoModule,
  attributeType: unknown,
): number | undefined {
  if (attributeType === Float32Array) return draco.DT_FLOAT32;
  if (attributeType === Int8Array) return draco.DT_INT8;
  if (attributeType === Int16Array) return draco.DT_INT16;
  if (attributeType === Int32Array) return draco.DT_INT32;
  if (attributeType === Uint8Array) return draco.DT_UINT8;
  if (attributeType === Uint16Array) return draco.DT_UINT16;
  if (attributeType === Uint32Array) return draco.DT_UINT32;
  return undefined;
}

interface DracoTaskConfig {
  attributeIDs: Record<string, number | string>;
  attributeTypes: Record<string, string>;
  useUniqueIDs: boolean;
  vertexColorSpace?: string;
}

interface DracoGeometryOutput {
  index: { array: Uint32Array; itemSize: 1 } | null;
  attributes: Array<{ name: string; array: ArrayBufferView; itemSize: number; vertexColorSpace?: string }>;
}

function decodeDracoGeometry(
  draco: DracoModule,
  buffer: ArrayBuffer,
  taskConfig: DracoTaskConfig,
): DracoGeometryOutput {
  const decoder = new draco.Decoder();
  try {
    const array = new Int8Array(buffer);
    let dracoGeometry: DracoGeomInstance;
    let decodingStatus: DracoDecodingStatus;
    const geometryType = decoder.GetEncodedGeometryType(array);
    if (geometryType === draco.TRIANGULAR_MESH) {
      dracoGeometry = new draco.Mesh();
      decodingStatus = decoder.DecodeArrayToMesh(array, array.byteLength, dracoGeometry);
    } else if (geometryType === draco.POINT_CLOUD) {
      dracoGeometry = new draco.PointCloud();
      decodingStatus = decoder.DecodeArrayToPointCloud(array, array.byteLength, dracoGeometry);
    } else {
      throw new Error('Unexpected DRACO geometry type');
    }
    if (!decodingStatus.ok() || dracoGeometry.ptr === 0) {
      throw new Error('DRACO decode failed: ' + decodingStatus.error_msg());
    }
    const geometry: DracoGeometryOutput = { index: null, attributes: [] };
    for (const name in taskConfig.attributeIDs) {
      const attrType = (globalThis as Record<string, unknown>)[taskConfig.attributeTypes[name]] as unknown;
      let attribute: DracoAttribute, attrID: number;
      if (taskConfig.useUniqueIDs) {
        attrID = taskConfig.attributeIDs[name] as number;
        attribute = decoder.GetAttributeByUniqueId(dracoGeometry, attrID);
      } else {
        attrID = decoder.GetAttributeId(dracoGeometry, draco[taskConfig.attributeIDs[name] as string] as number);
        if (attrID === -1) continue;
        attribute = decoder.GetAttribute(dracoGeometry, attrID);
      }
      const numComp = attribute.num_components();
      const numPts = dracoGeometry.num_points();
      const numVals = numPts * numComp;
      const BYTES_PER_ELEMENT = (attrType as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
      const byteLen = numVals * BYTES_PER_ELEMENT;
      const dataType = getDracoDataType(draco, attrType);
      if (dataType === undefined) throw new Error(`Unknown DRACO data type for ${name}`);
      const ptr = draco._malloc(byteLen);
      decoder.GetAttributeDataArrayForAllPoints(dracoGeometry, attribute, dataType, byteLen, ptr);
      const ArrayCtor = attrType as new (buffer: ArrayBuffer, byteOffset: number, length: number) => ArrayBufferView;
      const arr = new ArrayCtor(draco.HEAPF32.buffer, ptr, numVals);
      // slice() copies out of WASM heap before free
      const copy = (arr as unknown as { slice: () => ArrayBufferView }).slice();
      draco._free(ptr);
      const result: DracoGeometryOutput['attributes'][number] = {
        name, array: copy, itemSize: numComp,
      };
      if (name === 'color') result.vertexColorSpace = taskConfig.vertexColorSpace;
      geometry.attributes.push(result);
    }
    if (geometryType === draco.TRIANGULAR_MESH) {
      const numFaces = dracoGeometry.num_faces();
      const numIdx = numFaces * 3;
      const idxBytes = numIdx * 4;
      const ptr = draco._malloc(idxBytes);
      decoder.GetTrianglesUInt32Array(dracoGeometry, idxBytes, ptr);
      const raw = new Uint32Array(draco.HEAPF32.buffer, ptr, numIdx);
      geometry.index = { array: raw.slice(), itemSize: 1 };
      draco._free(ptr);
    }
    draco.destroy(dracoGeometry);
    return geometry;
  } finally {
    draco.destroy(decoder);
  }
}

/**
 * Create a DRACOLoader configured to decode in the main thread (no Worker).
 *
 * @param projectRoot — absolute path to the project root. Used to locate the
 *   bundled draco_decoder.js under `node_modules/three/examples/jsm/libs/draco/gltf/`.
 */
export async function createDracoLoader(projectRoot: string): Promise<DRACOLoader> {
  const dracoDir = resolve(projectRoot, 'node_modules/three/examples/jsm/libs/draco/gltf');
  const loader = new DRACOLoader();
  loader.setDecoderPath('file://' + dracoDir + '/');
  loader.setDecoderConfig({ type: 'js' });

  // Emscripten require polyfill (for fs + path) and __dirname
  const g = globalThis as Record<string, unknown>;
  if (typeof g['require'] === 'undefined') {
    const nodeFs = await import('node:fs');
    const nodePath = await import('node:path');
    g['require'] = (id: string) => {
      if (id === 'fs') return nodeFs;
      if (id === 'path') return nodePath;
      throw new Error(`require('${id}') not polyfilled`);
    };
  }
  if (typeof g['__dirname'] === 'undefined') {
    g['__dirname'] = dracoDir;
  }

  const { readFile } = await import('node:fs/promises');
  const decoderJS = await readFile(resolve(dracoDir, 'draco_decoder.js'), 'utf8');
  // The decoder script defines DracoDecoderModule globally via a factory
  const decoderFactory = new Function(decoderJS + '\nreturn DracoDecoderModule;')();
  const dracoModule = await new Promise<DracoModule>((res) => {
    decoderFactory({ onModuleLoaded: (draco: DracoModule) => res(draco) });
  });

  // Patch decodeGeometry to run in main thread
  (loader as unknown as {
    decodeGeometry: (buf: ArrayBuffer, cfg: DracoTaskConfig) => Promise<unknown>;
  }).decodeGeometry = function (buffer, taskConfig) {
    return Promise.resolve().then(() => {
      const geometry = decodeDracoGeometry(dracoModule, buffer, taskConfig);
      return (this as unknown as { _createGeometry: (g: DracoGeometryOutput) => unknown })
        ._createGeometry(geometry);
    });
  };

  return loader;
}
