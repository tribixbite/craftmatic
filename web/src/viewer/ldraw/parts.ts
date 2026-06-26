/**
 * LDraw part fetching, parsing, and geometry resolution.
 *
 * Module-level caches survive across LDrawViewer instances so reloading the
 * same model is fast (parts already in memory). The parsing handles BFC
 * winding, !COLOUR inline definitions, !TEXMAP/!DATA blocks (currently
 * skipped), color-16 inheritance, and recursive sub-file references.
 */

import type { Vec3, Triangle, Edge, PartGeom, UV } from './types.js';

const datTextCache = new Map<string, string | null>();
const partGeomCache = new Map<string, PartGeom>();
const datInFlight = new Map<string, Promise<string | null>>();
const geomInFlight = new Map<string, Promise<PartGeom>>();

const MAX_CACHE_ENTRIES = 10_000;

/** Color IDs discovered to be transparent via inline !COLOUR ALPHA definitions */
export const inlineTransparentColors = new Set<number>();

/**
 * Sub-file names that exhausted every candidate path with a definitive miss.
 * Parents referencing them still render their OTHER geometry, so these are
 * SILENT holes unless surfaced — the viewer reports them after each load.
 * Cleared per-model by clearMpdInlines().
 */
export const unresolvedDatNames = new Set<string>();

/**
 * Texture data from !DATA blocks. Keyed by image filename (lowercased,
 * no path). Stored as data URLs so they can be passed straight to
 * THREE.TextureLoader without an extra round-trip.
 */
export const partTextureUrls = new Map<string, string>();

/**
 * UV from a PLANAR texmap: project the point onto the (u, v) basis defined
 * by the three texmap points and normalize by axis length squared, so the
 * basis-endpoint vertices land at u=1 (or v=1) and the origin at (0, 0).
 */
function planarUV(
  p: Vec3,
  tm: { p1: Vec3; uAxis: Vec3; vAxis: Vec3; uLenSq: number; vLenSq: number },
): UV {
  const dx = p[0] - tm.p1[0];
  const dy = p[1] - tm.p1[1];
  const dz = p[2] - tm.p1[2];
  const u = (dx * tm.uAxis[0] + dy * tm.uAxis[1] + dz * tm.uAxis[2]) / (tm.uLenSq || 1);
  const v = (dx * tm.vAxis[0] + dy * tm.vAxis[1] + dz * tm.vAxis[2]) / (tm.vLenSq || 1);
  return [u, v];
}

/**
 * Synchronous cache reader. Returns undefined if the part hasn't been
 * resolved yet (caller should await resolvePartGeometry first). The
 * viewer relies on this to read prefetched geometry without re-promising.
 */
export function getCachedPartGeom(id: string): PartGeom | undefined {
  return partGeomCache.get(normId(id));
}

/**
 * Drop a part's assembled geometry from the cache so the next
 * resolvePartGeometry() rebuilds it from scratch. Used to repair geometry
 * that came back incomplete from a concurrent-resolution race (a parent that
 * read a child's not-yet-populated placeholder). The underlying .dat text
 * stays cached (it's fine); only the assembled triangle set is rebuilt.
 */
export function invalidatePartGeom(id: string): void {
  partGeomCache.delete(normId(id));
}

let LDRAW_BASE = '/ldraw-parts';

export function setLDrawBase(base: string): void {
  LDRAW_BASE = base;
}

// ─── Persistent .dat text cache (IndexedDB) ──────────────────────────────────
// Library part files are immutable in practice, so caching their text across
// sessions makes repeat loads near-instant (a cold large-set load is ~97%
// network time). Only POSITIVE results are persisted — misses stay
// session-local so library additions are picked up. Every operation degrades
// silently to "no persistent cache" (node/vitest, private browsing, quota).
// Bump IDB_VERSION_KEY to invalidate after a known library-wide change.

const IDB_NAME = 'craftmatic-ldraw';
const IDB_STORE = 'dat-text';
const IDB_VERSION_KEY = 'v1';
let idbHandle: Promise<IDBDatabase | null> | null = null;

function openIdb(): Promise<IDBDatabase | null> {
  if (idbHandle) return idbHandle;
  idbHandle = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return idbHandle;
}

/** Read a cached .dat text. undefined = not cached (or no IDB available). */
async function idbGetDat(key: string): Promise<string | undefined> {
  const db = await openIdb();
  if (!db) return undefined;
  return new Promise(resolve => {
    try {
      const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(`${IDB_VERSION_KEY}:${key}`);
      rq.onsuccess = () => resolve(typeof rq.result === 'string' ? rq.result : undefined);
      rq.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Persist a fetched .dat text (fire-and-forget). */
function idbPutDat(key: string, text: string): void {
  void openIdb().then(db => {
    if (!db) return;
    try {
      db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(text, `${IDB_VERSION_KEY}:${key}`);
    } catch {
      // quota / private mode — persistent cache is best-effort
    }
  });
}

export function normId(id: string): string {
  return id.replace(/\\/g, '/').toLowerCase().replace(/\.dat$/i, '').trim();
}

function applyMat(v: Vec3, R: readonly number[], T: Vec3): Vec3 {
  return [
    R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2] + T[0],
    R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2] + T[1],
    R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2] + T[2],
  ];
}

/**
 * Inject MPD inline sub-model contents into the .dat text cache so they
 * resolve without HTTP fetches. Pass the raw MPD/LDR file content.
 */
export function preloadMpdInlines(mpdContent: string): void {
  const lines = mpdContent.split(/\r?\n/);
  let currentName: string | null = null;
  let currentLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const fileMatch = /^0\s+FILE\s+(.+)$/i.exec(trimmed);
    const nofileMatch = /^0\s+NOFILE\s*$/i.test(trimmed);
    if (fileMatch) {
      if (currentName) {
        datTextCache.set(normId(currentName), currentLines.join('\n'));
      }
      currentName = fileMatch[1]!.trim();
      currentLines = [];
    } else if (nofileMatch) {
      if (currentName) {
        datTextCache.set(normId(currentName), currentLines.join('\n'));
        currentName = null;
        currentLines = [];
      }
    } else if (currentName) {
      currentLines.push(line);
    }
  }
  if (currentName) {
    datTextCache.set(normId(currentName), currentLines.join('\n'));
  }
}

/** Keys registered by preloadDatTexts for the CURRENT model — cleared between loads. */
const preloadedDatKeys = new Set<string>();

/**
 * Register model-bundled .dat definitions (e.g. a Studio .io archive's
 * `CustomParts/` entries) so sub-file references resolve from memory instead
 * of the network. Entries are keyed by their archive-relative path; each is
 * registered under every path suffix (`p/48/x.dat` → `p/48/x`, `48/x`, `x`)
 * because LDraw references may use any of those forms. Model-specific:
 * cleared by clearMpdInlines() on the next load.
 */
export function preloadDatTexts(files: Map<string, string>): void {
  for (const [rawPath, text] of files) {
    const path = rawPath.replace(/\\/g, '/').toLowerCase();
    const segs = path.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const key = normId(segs.slice(i).join('/'));
      if (!key) continue;
      datTextCache.set(key, text);
      partGeomCache.delete(key); // text changed → stale assembled geometry
      preloadedDatKeys.add(key);
    }
  }
}

/**
 * Clear inline .ldr entries between model loads. Keeps the .dat library
 * cache (which is shared) but evicts model-specific MPD inlines and
 * preloaded archive part definitions.
 */
export function clearMpdInlines(): void {
  inlineTransparentColors.clear();
  unresolvedDatNames.clear();
  for (const key of [...partGeomCache.keys()]) {
    if (key.endsWith('.ldr')) {
      partGeomCache.delete(key);
      datTextCache.delete(key);
    }
  }
  for (const key of preloadedDatKeys) {
    partGeomCache.delete(key);
    datTextCache.delete(key);
  }
  preloadedDatKeys.clear();
}

/**
 * Common LEGO bricks/plates/tiles/slopes — the ~40 parts that show up in
 * nearly every set. Fetching them in parallel at app idle pre-warms the
 * datTextCache so the first model load is meaningfully faster (cold-load
 * benchmark on 10248-ferrari dropped from ~10s to ~3-4s in dev).
 *
 * Fire-and-forget: errors are silently swallowed since this is a
 * speculative warmup, not a load-blocking operation.
 */
const COMMON_PARTS = [
  // Basic bricks
  '3001', '3002', '3003', '3004', '3005', '3007', '3009', '3010',
  '3622', '3700', '3701', '3702',
  // Plates
  '3020', '3021', '3022', '3023', '3024', '3034', '3035', '3460',
  '3623', '3666', '3710', '3795', '41539',
  // Tiles
  '3068', '3069', '3070', '6636', '4150',
  // Slopes
  '3037', '3038', '3039', '3040', '3298', '54200', '60481',
  // Round/curved
  '4032', '4073', '6141', '85984', '3062',
];

export function prewarmCommonParts(): Promise<void> {
  const tasks = COMMON_PARTS.map(id =>
    fetchDatText(id).then(() => undefined).catch(() => undefined),
  );
  return Promise.all(tasks).then(() => undefined);
}

/**
 * Heuristic: does this bare name look like a `p/` geometry primitive rather
 * than a numbered part? Drives candidate-path ORDER (primitives live in `p/`,
 * numbered parts in `parts/`), which matters a lot for load time: probing
 * `parts/` first for the hundreds of primitives in a big model wastes 1–7
 * 404 round-trips per primitive (and floods the console with 404 noise).
 */
function looksLikePrimitive(stem: string): boolean {
  if (/^\d+-\d+/.test(stem)) return true; // fraction prims: 4-4cyli, 1-12ring14…
  // Real PARTS are numbered (3001, 32523…); these letter-prefixed names only
  // exist as p/ primitives. Probing p/ first avoids a parts/ 404 round-trip per
  // primitive (on prod, each is a CF-Worker hop to upstream). Misclassifying is
  // safe: it just probes p/ first, then falls through. The technic family
  // (bush/conn/confric/fric/fillet/npeghol/beamhole/ribt/stud-cyl/radius) was
  // added after live prod testing surfaced dozens of such 404s on Technic sets.
  return /^(stud|stug|box|rect|ring|ndis|disc|edge|cyl|con[ec]?\d|conn|confric|cone|axl|bump|chrd|tri|tooth|peghole|npeghol|knob|duck|clip|filstud|fillet|bush|fric|beamhol|ribt|logo|ldu|empty|arm\d|handle|hinge|t[0-9]{2}[io]|r[0-9]+o|st[0-9x]j|typestn?[0-9])/.test(stem);
}

async function fetchDatText(id: string): Promise<string | null> {
  const key = normId(id);
  if (datTextCache.has(key)) return datTextCache.get(key)!;
  if (datInFlight.has(key)) return datInFlight.get(key)!;

  const stem = key.split('/').pop()!;
  const paths: string[] = [];
  if (key.includes('/')) {
    if (key.startsWith('s/'))
      paths.push(`${LDRAW_BASE}/parts/${key}.dat`, `${LDRAW_BASE}/parts/s/${stem}.dat`, `${LDRAW_BASE}/UnOfficial/parts/${key}.dat`);
    else if (key.startsWith('48/'))
      paths.push(`${LDRAW_BASE}/p/${key}.dat`, `${LDRAW_BASE}/p/48/${stem}.dat`, `${LDRAW_BASE}/UnOfficial/p/${key}.dat`);
    else
      paths.push(`${LDRAW_BASE}/p/${key}.dat`, `${LDRAW_BASE}/UnOfficial/p/${key}.dat`);
  } else if (looksLikePrimitive(stem)) {
    // Primitive-shaped name → p/ first; the parts/ fallbacks below still run
    // for the rare part whose number begins like a primitive.
    paths.push(
      `${LDRAW_BASE}/p/${stem}.dat`,
      `${LDRAW_BASE}/UnOfficial/p/${stem}.dat`,
      `${LDRAW_BASE}/parts/${stem}.dat`,
      `${LDRAW_BASE}/UnOfficial/parts/${stem}.dat`,
      // Some Studio-era subparts reference primitives that only exist as
      // hi-res `48/` variants (e.g. bare `1-12ring14` → p/48/1-12ring14.dat).
      // The 48/ version is the same shape at finer tessellation — a safe
      // drop-in that closes those silent geometry holes.
      `${LDRAW_BASE}/p/48/${stem}.dat`,
      `${LDRAW_BASE}/UnOfficial/p/48/${stem}.dat`,
    );
  }
  paths.push(
    `${LDRAW_BASE}/parts/${stem}.dat`,
    `${LDRAW_BASE}/p/${stem}.dat`,
    `${LDRAW_BASE}/parts/s/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/parts/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/parts/s/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/p/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/p/48/${stem}.dat`,
    `${LDRAW_BASE}/models/${stem}.dat`,
  );
  // De-duplicate while preserving first-occurrence order.
  const seen = new Set<string>();
  const orderedPaths = paths.filter(p => !seen.has(p) && (seen.add(p), true));

  const promise = (async (): Promise<string | null> => {
    // Persistent cache first: library .dat files are immutable in practice,
    // so a previous session's fetch satisfies this one with zero network.
    const persisted = await idbGetDat(key);
    if (persisted !== undefined) {
      datTextCache.set(key, persisted);
      return persisted;
    }

    // Distinguish a DEFINITIVE miss (every candidate path returned a real HTTP
    // response, all non-OK → part truly absent) from a TRANSIENT failure
    // (a fetch threw: timeout / network error / server overload). Only a
    // definitive miss is cached as null permanently. Transient failures are
    // retried per-path with backoff and, if still unresolved, left UNCACHED
    // so a later reference (or reload) can try again. This prevents a load
    // spike (e.g. many models at once) or a flaky network from permanently
    // dropping a part — the previous code cached null on the FIRST failure,
    // which turned transient timeouts into permanently missing pieces.
    let sawTransient = false;
    for (const path of orderedPaths) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(path, { signal: AbortSignal.timeout(8000) });
          if (r.ok) {
            const text = await r.text();
            datTextCache.set(key, text);
            idbPutDat(key, text);
            return text;
          }
          break; // got a definitive HTTP response (e.g. 404) — next path, no retry
        } catch {
          sawTransient = true; // timeout / network error — retry this path
          if (attempt < 2) await new Promise(res => setTimeout(res, 200 * (attempt + 1)));
        }
      }
    }
    if (!sawTransient) {
      datTextCache.set(key, null); // definitive miss only
      unresolvedDatNames.add(key);
    }
    return null;
  })();

  datInFlight.set(key, promise);
  const result = await promise;
  datInFlight.delete(key);
  return result;
}

/**
 * Resolve part geometry recursively, returning local-space triangles+edges.
 * Color-16 (inherit) goes in `tris`/`edges`; explicit colors route to
 * `colorTris`/`colorEdges` so multi-colored sub-parts (printed tiles, etc.)
 * render with their actual colors instead of the parent's.
 */
export async function resolvePartGeometry(
  id: string,
  depth = 0,
  invertWinding = false,
): Promise<PartGeom> {
  const EMPTY: PartGeom = { tris: [], edges: [], colorTris: new Map(), colorEdges: new Map() };
  if (depth > 20) return EMPTY;
  const key = normId(id);

  if (partGeomCache.has(key)) return partGeomCache.get(key)!;
  if (geomInFlight.has(key)) return geomInFlight.get(key)!;

  const promise = (async (): Promise<PartGeom> => {
    const text = await fetchDatText(key);
    if (!text) return EMPTY;
    if (partGeomCache.size > MAX_CACHE_ENTRIES) {
      const it = partGeomCache.keys();
      for (let i = 0; i < 1000; i++) {
        const k = it.next();
        if (k.done) break;
        partGeomCache.delete(k.value);
      }
    }

    const geom: PartGeom = { tris: [], edges: [], colorTris: new Map(), colorEdges: new Map() };
    partGeomCache.set(key, geom);

    const subPromises: Promise<void>[] = [];
    let bfcCCW = true;
    let invertNext = false;

    // TEXMAP state. Either null (no active texmap), or carries plane+image.
    // mode='block': textured until END. mode='next': textured for one !:-line.
    // fallback=true means subsequent non-prefixed lines are textureless backups.
    let texmap: {
      type: 'planar'; p1: Vec3; uAxis: Vec3; vAxis: Vec3;
      uLenSq: number; vLenSq: number; image: string;
      mode: 'block' | 'next'; fallback: boolean;
    } | null = null;

    // !DATA accumulator. While inDataImage is set, !: lines are base64
    // continuations of that image, not textured-geometry refs.
    let inDataImage: string | null = null;
    let dataBuf: string[] = [];
    const commitData = () => {
      if (inDataImage && dataBuf.length) {
        partTextureUrls.set(
          inDataImage.toLowerCase(),
          `data:image/png;base64,${dataBuf.join('')}`,
        );
      }
      inDataImage = null;
      dataBuf = [];
    };

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      // ── !DATA block: collect base64 ────────────────────────────────────
      const dataMatch = line.match(/^0\s+!DATA\s+(.+)$/i);
      if (dataMatch) {
        commitData();
        inDataImage = dataMatch[1]!.trim();
        continue;
      }
      if (inDataImage) {
        const m = line.match(/^0\s+!:\s+(.*)$/i);
        if (m) { dataBuf.push(m[1]!); continue; }
        // Anything else terminates the data block
        commitData();
      }

      // ── !TEXMAP control lines ──────────────────────────────────────────
      const startMatch = line.match(/^0\s+!TEXMAP\s+(START|NEXT)\s+PLANAR\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+(\S+)/i);
      if (startMatch) {
        const p1: Vec3 = [+startMatch[2]!, +startMatch[3]!, +startMatch[4]!];
        const p2: Vec3 = [+startMatch[5]!, +startMatch[6]!, +startMatch[7]!];
        const p3: Vec3 = [+startMatch[8]!, +startMatch[9]!, +startMatch[10]!];
        const uAxis: Vec3 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
        const vAxis: Vec3 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];
        texmap = {
          type: 'planar', p1, uAxis, vAxis,
          uLenSq: uAxis[0] ** 2 + uAxis[1] ** 2 + uAxis[2] ** 2,
          vLenSq: vAxis[0] ** 2 + vAxis[1] ** 2 + vAxis[2] ** 2,
          image: startMatch[11]!.toLowerCase().replace(/^.*[/\\]/, ''),
          mode: startMatch[1]!.toUpperCase() === 'NEXT' ? 'next' : 'block',
          fallback: false,
        };
        continue;
      }
      if (/^0\s+!TEXMAP\s+FALLBACK/i.test(line)) {
        if (texmap) texmap.fallback = true;
        continue;
      }
      if (/^0\s+!TEXMAP\s+END/i.test(line)) {
        texmap = null;
        continue;
      }

      // ── In a !TEXMAP block, `0 !:` prefix means "render with active
      //    texture"; non-prefixed lines render as normal geometry (no
      //    texture) per the LDraw spec. After !TEXMAP FALLBACK, geometry
      //    should only render when textures are unsupported — but since
      //    we DO support textures, we drop fallback geometry to avoid
      //    double-rendering the same sub-part twice.
      let isTextured = false;
      let lineToParse = line;
      if (texmap) {
        const texGeo = line.match(/^0\s+!:\s+(.*)$/i);
        if (texGeo) {
          isTextured = true;
          lineToParse = texGeo[1]!;
        } else if (texmap.fallback) {
          // Skip fallback geometry — we already rendered the textured version.
          const t0 = line.split(/\s+/)[0];
          if (t0 === '1' || t0 === '2' || t0 === '3' || t0 === '4' || t0 === '5') continue;
        }
        // Otherwise (non-prefixed, no FALLBACK seen yet): fall through to
        // the normal parser so the geometry renders as untextured fill.
      }

      const tok = lineToParse.split(/\s+/);

      if (tok[0] === '0' && tok[1] === 'BFC') {
        const cmd = tok.slice(2).join(' ').toUpperCase();
        if (cmd.includes('CERTIFY')) {
          bfcCCW = !cmd.includes('CW') || cmd.includes('CCW');
        }
        if (cmd === 'INVERTNEXT') invertNext = true;
        if (cmd === 'CW') bfcCCW = false;
        if (cmd === 'CCW') bfcCCW = true;
        continue;
      }

      if (tok[0] === '0' && tok[1] === '!COLOUR') {
        const codeIdx = tok.indexOf('CODE');
        const valIdx = tok.indexOf('VALUE');
        const alphaIdx = tok.indexOf('ALPHA');
        if (codeIdx > 0 && valIdx > 0 && tok[codeIdx + 1] && tok[valIdx + 1]) {
          const cid = parseInt(tok[codeIdx + 1]!, 10);
          const rgb = tok[valIdx + 1]!;
          if (!isNaN(cid) && rgb.startsWith('#')) {
            const { LDRAW_COLOR_RGB } = await import('@engine/ldraw-colors.js');
            if (!(cid in LDRAW_COLOR_RGB)) {
              (LDRAW_COLOR_RGB as Record<number, string>)[cid] = rgb;
            }
            if (alphaIdx > 0 && tok[alphaIdx + 1]) {
              const alpha = parseInt(tok[alphaIdx + 1]!, 10);
              if (alpha < 200) inlineTransparentColors.add(cid);
            }
          }
        }
        continue;
      }

      if (tok[0] === '2' && tok.length >= 8) {
        const edgeColor = parseInt(tok[1]!, 10);
        const edge: Edge = [
          [+tok[2]!, +tok[3]!, +tok[4]!],
          [+tok[5]!, +tok[6]!, +tok[7]!],
        ];
        if (edgeColor !== 24 && edgeColor !== 16 && !isNaN(edgeColor)) {
          const ce = geom.colorEdges.get(edgeColor) ?? (() => {
            const a: Edge[] = []; geom.colorEdges.set(edgeColor, a); return a;
          })();
          ce.push(edge);
        } else {
          geom.edges.push(edge);
        }
      } else if (tok[0] === '5' && tok.length >= 14) {
        const edge: Edge = [
          [+tok[2]!, +tok[3]!, +tok[4]!],
          [+tok[5]!, +tok[6]!, +tok[7]!],
        ];
        geom.edges.push(edge);
      } else if (tok[0] === '3' && tok.length >= 11) {
        const triColor = parseInt(tok[1]!, 10);
        const x0 = +tok[2]!, y0 = +tok[3]!, z0 = +tok[4]!;
        const x1 = +tok[5]!, y1 = +tok[6]!, z1 = +tok[7]!;
        const x2 = +tok[8]!, y2 = +tok[9]!, z2 = +tok[10]!;
        if (isNaN(x0 + y0 + z0 + x1 + y1 + z1 + x2 + y2 + z2)) continue;
        const v0: Vec3 = [x0, y0, z0];
        const v1: Vec3 = [x1, y1, z1];
        const v2: Vec3 = [x2, y2, z2];
        const shouldInvert = invertWinding !== !bfcCCW;
        const tri: Triangle = shouldInvert ? [v0, v2, v1] : [v0, v1, v2];
        if (isTextured && texmap) {
          if (!geom.texTris) geom.texTris = new Map();
          let bucket = geom.texTris.get(texmap.image);
          if (!bucket) { bucket = []; geom.texTris.set(texmap.image, bucket); }
          bucket.push({
            v: tri,
            uv: [planarUV(tri[0], texmap), planarUV(tri[1], texmap), planarUV(tri[2], texmap)],
            color: triColor,
          });
          if (texmap.mode === 'next') texmap = null;
        } else if (triColor !== 16 && triColor !== 24 && !isNaN(triColor)) {
          const ct = geom.colorTris.get(triColor) ?? (() => {
            const a: Triangle[] = []; geom.colorTris.set(triColor, a); return a;
          })();
          ct.push(tri);
        } else {
          geom.tris.push(tri);
        }
      } else if (tok[0] === '4' && tok.length >= 14) {
        const quadColor = parseInt(tok[1]!, 10);
        const q = tok.slice(2, 14).map(t => +t!);
        if (q.some(isNaN)) continue;
        const v0: Vec3 = [q[0]!, q[1]!, q[2]!];
        const v1: Vec3 = [q[3]!, q[4]!, q[5]!];
        const v2: Vec3 = [q[6]!, q[7]!, q[8]!];
        const v3: Vec3 = [q[9]!, q[10]!, q[11]!];
        const shouldInvert = invertWinding !== !bfcCCW;
        const t1: Triangle = shouldInvert ? [v0, v2, v1] : [v0, v1, v2];
        const t2: Triangle = shouldInvert ? [v0, v3, v2] : [v0, v2, v3];
        if (isTextured && texmap) {
          if (!geom.texTris) geom.texTris = new Map();
          let bucket = geom.texTris.get(texmap.image);
          if (!bucket) { bucket = []; geom.texTris.set(texmap.image, bucket); }
          bucket.push({
            v: t1,
            uv: [planarUV(t1[0], texmap), planarUV(t1[1], texmap), planarUV(t1[2], texmap)],
            color: quadColor,
          });
          bucket.push({
            v: t2,
            uv: [planarUV(t2[0], texmap), planarUV(t2[1], texmap), planarUV(t2[2], texmap)],
            color: quadColor,
          });
          if (texmap.mode === 'next') texmap = null;
        } else if (quadColor !== 16 && quadColor !== 24 && !isNaN(quadColor)) {
          const ct = geom.colorTris.get(quadColor) ?? (() => {
            const a: Triangle[] = []; geom.colorTris.set(quadColor, a); return a;
          })();
          ct.push(t1, t2);
        } else {
          geom.tris.push(t1, t2);
        }
      } else if (tok[0] === '1' && tok.length >= 15 && depth < 19) {
        const subColor = parseInt(tok[1]!, 10);
        const tx = +tok[2]!, ty = +tok[3]!, tz = +tok[4]!;
        if (isNaN(tx + ty + tz)) continue;
        const R = [
          +tok[5]!, +tok[6]!, +tok[7]!,
          +tok[8]!, +tok[9]!, +tok[10]!,
          +tok[11]!, +tok[12]!, +tok[13]!,
        ];
        if (R.some(isNaN)) continue;
        const T: Vec3 = [tx, ty, tz];
        const subId = tok.slice(14).join(' ').trim();
        if (!subId) continue;

        const det = R[0]! * (R[4]! * R[8]! - R[5]! * R[7]!)
                  - R[1]! * (R[3]! * R[8]! - R[5]! * R[6]!)
                  + R[2]! * (R[3]! * R[7]! - R[4]! * R[6]!);
        const childInvert = invertWinding !== (det < 0) !== invertNext;
        invertNext = false;

        subPromises.push(
          resolvePartGeometry(subId, depth + 1, childInvert).then(sub => {
            const targetTris = (subColor !== 16 && subColor !== 24)
              ? (geom.colorTris.get(subColor) ?? (() => {
                  const a: Triangle[] = []; geom.colorTris.set(subColor, a); return a;
                })())
              : geom.tris;
            const targetEdges = (subColor !== 16 && subColor !== 24)
              ? (geom.colorEdges.get(subColor) ?? (() => {
                  const a: Edge[] = []; geom.colorEdges.set(subColor, a); return a;
                })())
              : geom.edges;

            for (const [sv0, sv1, sv2] of sub.tris) {
              targetTris.push([applyMat(sv0, R, T), applyMat(sv1, R, T), applyMat(sv2, R, T)]);
            }
            for (const [ev0, ev1] of sub.edges) {
              targetEdges.push([applyMat(ev0, R, T), applyMat(ev1, R, T)]);
            }
            for (const [cid, ctris] of sub.colorTris) {
              const target = geom.colorTris.get(cid) ?? (() => {
                const a: Triangle[] = []; geom.colorTris.set(cid, a); return a;
              })();
              for (const [sv0, sv1, sv2] of ctris) {
                target.push([applyMat(sv0, R, T), applyMat(sv1, R, T), applyMat(sv2, R, T)]);
              }
            }
            for (const [cid, cedges] of sub.colorEdges) {
              const target = geom.colorEdges.get(cid) ?? (() => {
                const a: Edge[] = []; geom.colorEdges.set(cid, a); return a;
              })();
              for (const [ev0, ev1] of cedges) {
                target.push([applyMat(ev0, R, T), applyMat(ev1, R, T)]);
              }
            }
            // Propagate sub-part textured triangles into parent. UVs are
            // image-space and DON'T transform; only the vertex positions do.
            if (sub.texTris) {
              if (!geom.texTris) geom.texTris = new Map();
              for (const [image, sTris] of sub.texTris) {
                let bucket = geom.texTris.get(image);
                if (!bucket) { bucket = []; geom.texTris.set(image, bucket); }
                for (const t of sTris) {
                  bucket.push({
                    v: [applyMat(t.v[0], R, T), applyMat(t.v[1], R, T), applyMat(t.v[2], R, T)],
                    uv: t.uv,
                    color: t.color,
                  });
                }
              }
            }
          }),
        );
      }
      // NEXT-mode texmap covers exactly one geometry line — release it after
      // any geometry line was processed under the textured context.
      if (isTextured && texmap?.mode === 'next') texmap = null;
    }
    // Commit any trailing !DATA block that wasn't terminated by another directive.
    commitData();

    await Promise.allSettled(subPromises);
    return geom;
  })();

  geomInFlight.set(key, promise);
  const result = await promise;
  geomInFlight.delete(key);
  return result;
}

/**
 * Skip non-visual primitives. Currently only the `logo` text stamps —
 * they're 1×1mm "LEGO" embossings that don't render at typical zoom and
 * cost ~50 tris each.
 *
 * LSynth virtual segment parts (lsXX.dat) used to be filtered here but
 * many of them have real .dat geometry in the library (cylinder
 * sections, hose segments). Letting them through allows hose-heavy
 * Technic models to render their flexible parts as their normal
 * triangle geometry. Unrecognized lsXX names just 404 silently.
 */
export function isLDrawPrimitive(part: string): boolean {
  const bare = part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
  if (bare.startsWith('logo')) return true;
  return false;
}
