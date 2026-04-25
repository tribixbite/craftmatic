/**
 * LDraw part fetching, parsing, and geometry resolution.
 *
 * Module-level caches survive across LDrawViewer instances so reloading the
 * same model is fast (parts already in memory). The parsing handles BFC
 * winding, !COLOUR inline definitions, !TEXMAP/!DATA blocks (currently
 * skipped), color-16 inheritance, and recursive sub-file references.
 */

import type { Vec3, Triangle, Edge, PartGeom } from './types.js';

const datTextCache = new Map<string, string | null>();
const partGeomCache = new Map<string, PartGeom>();
const datInFlight = new Map<string, Promise<string | null>>();
const geomInFlight = new Map<string, Promise<PartGeom>>();

const MAX_CACHE_ENTRIES = 10_000;

/** Color IDs discovered to be transparent via inline !COLOUR ALPHA definitions */
export const inlineTransparentColors = new Set<number>();

/**
 * Synchronous cache reader. Returns undefined if the part hasn't been
 * resolved yet (caller should await resolvePartGeometry first). The
 * viewer relies on this to read prefetched geometry without re-promising.
 */
export function getCachedPartGeom(id: string): PartGeom | undefined {
  return partGeomCache.get(normId(id));
}

let LDRAW_BASE = '/ldraw-parts';

export function setLDrawBase(base: string): void {
  LDRAW_BASE = base;
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

/**
 * Clear inline .ldr entries between model loads. Keeps the .dat library
 * cache (which is shared) but evicts model-specific MPD inlines.
 */
export function clearMpdInlines(): void {
  inlineTransparentColors.clear();
  for (const key of [...partGeomCache.keys()]) {
    if (key.endsWith('.ldr')) {
      partGeomCache.delete(key);
      datTextCache.delete(key);
    }
  }
}

async function fetchDatText(id: string): Promise<string | null> {
  const key = normId(id);
  if (datTextCache.has(key)) return datTextCache.get(key)!;
  if (datInFlight.has(key)) return datInFlight.get(key)!;

  const stem = key.split('/').pop()!;
  const paths: string[] = [];
  if (key.includes('/')) {
    if (key.startsWith('s/'))
      paths.push(`${LDRAW_BASE}/parts/${key}.dat`, `${LDRAW_BASE}/parts/s/${stem}.dat`);
    else if (key.startsWith('48/'))
      paths.push(`${LDRAW_BASE}/p/${key}.dat`, `${LDRAW_BASE}/p/48/${stem}.dat`);
    else
      paths.push(`${LDRAW_BASE}/p/${key}.dat`, `${LDRAW_BASE}/UnOfficial/p/${key}.dat`);
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

  const promise = (async (): Promise<string | null> => {
    for (const path of paths) {
      try {
        const r = await fetch(path, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const text = await r.text();
          datTextCache.set(key, text);
          return text;
        }
      } catch { /* try next */ }
    }
    datTextCache.set(key, null);
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
    let texmapDepth = 0;

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      if (/^0\s+!DATA\s/i.test(line)) { texmapDepth++; continue; }
      if (/^0\s+!:/i.test(line) && texmapDepth > 0) continue;

      if (/^0\s+!TEXMAP\s+START/i.test(line) || /^0\s+!TEXMAP\s+NEXT/i.test(line)) {
        texmapDepth++;
        continue;
      }
      if (/^0\s+!TEXMAP\s+FALLBACK/i.test(line)) {
        texmapDepth = Math.max(0, texmapDepth - 1);
        continue;
      }
      if (/^0\s+!TEXMAP\s+END/i.test(line)) {
        texmapDepth = Math.max(0, texmapDepth - 1);
        continue;
      }
      if (texmapDepth > 0) continue;

      const tok = line.split(/\s+/);

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
        if (triColor !== 16 && triColor !== 24 && !isNaN(triColor)) {
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
        if (quadColor !== 16 && quadColor !== 24 && !isNaN(quadColor)) {
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
          }),
        );
      }
    }

    await Promise.allSettled(subPromises);
    return geom;
  })();

  geomInFlight.set(key, promise);
  const result = await promise;
  geomInFlight.delete(key);
  return result;
}

/**
 * Skip non-visual primitives — text logos and LSynth virtual hose segments.
 * Everything else (cylinders, studs, fraction primitives) is kept since it
 * defines visible geometry.
 */
export function isLDrawPrimitive(part: string): boolean {
  const bare = part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
  if (bare.startsWith('logo')) return true;
  if (/^ls\d+/.test(bare)) return true;
  return false;
}
