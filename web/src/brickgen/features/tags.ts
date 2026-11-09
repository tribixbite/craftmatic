/**
 * Features from OSM tags (A09, BIZ-05): the lowest-authority source, used where nothing marked a photo.
 *
 * Rules (each cites the part's own `SourceRef`, confidence 0.3-0.7):
 *  - `roof:shape` pyramidal/cone/spire on a tall roof (rise >= 8 m and >= 1.2 x the footprint) -> `spire`;
 *    the same roof on a footprint of 3 m or less -> `pinnacle`;
 *  - `roof:shape` dome/onion -> `dome`;
 *  - a thin skillion strip (<= 2.5 m wide, >= 6 m long) -> `flying-buttress` (OSM maps the arches of a Gothic
 *    chevet as 1-stud skillion parts);
 *  - `tower:type=bell_tower` -> a pair of belfry `lancet`s on each long face; `tower:type=clock` -> a `clock`;
 *  - `man_made=chimney` -> `chimney`;
 *  - an explicit `building:levels` -> a `window` row per level on each long face.
 * OSM carries no positions on a facade, so windows and belfry openings are even rows: a guess, hence the low
 * confidence, and any annotation of the same kind on the volume replaces them (`merge.ts`).
 */
import type { OverpassElement } from '@craft/gen/api/osm';
import { parseLengthM } from '../site/osm.js';
import type { FeatureKind, FeatureSpec, Massing, MassVolume, Vec3m } from '../types.js';
import { osmSourceId, outerEdges, volumeIdForPart, type EdgeInfo } from './frame.js';
import { DEFAULT_DEPTH_M, type OriginFeature } from './types.js';

/** An OSM element's tags with the ids the rest of brickgen uses for it. */
export interface TagPart {
  /** `way/123`. */
  partId: string;
  tags: Record<string, string>;
  /** `SourceRef` id of the element (`osm-way-123`); must be in the design's sources. */
  sourceId: string;
}

/** Every building or building:part element of an Overpass response, with its tags. */
export function tagPartsFromOverpass(elements: ReadonlyArray<OverpassElement>): TagPart[] {
  return elements
    .filter(e => e.tags !== undefined && (e.tags['building'] !== undefined || e.tags['building:part'] !== undefined))
    .map(e => ({ partId: `${e.type}/${e.id}`, tags: e.tags!, sourceId: osmSourceId(`${e.type}/${e.id}`) }));
}

/** Footprint above which a pyramidal roof counts as a spire rather than a cap (tall and slim). */
const SPIRE_MIN_RISE_M = 8;
const SPIRE_SLENDERNESS = 1.2;
/** A roof on a footprint this small is a pinnacle. */
const PINNACLE_MAX_SIDE_M = 3;
const FLYING_BUTTRESS_MAX_WIDTH_M = 2.5;
const FLYING_BUTTRESS_MIN_LENGTH_M = 6;
/** Spacing of generated window rows (m). */
const WINDOW_PITCH_M = 4;
const CONF = { spire: 0.7, pinnacle: 0.6, dome: 0.7, flying: 0.55, belfry: 0.3, clock: 0.3, chimney: 0.6, levels: 0.35 } as const;

/** Round to micrometres. */
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

interface Bounds { cx: number; cz: number; w: number; d: number }
function boundsOf(v: MassVolume): Bounds {
  const xs = v.outer.map(p => p[0]), zs = v.outer.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
}

/** Edges worth decorating: at least 60 % of the volume's longest edge and 6 m. */
function longEdges(v: MassVolume): EdgeInfo[] {
  const edges = outerEdges(v);
  const longest = Math.max(0, ...edges.map(e => e.length));
  return edges.filter(e => e.length >= Math.max(6, 0.6 * longest));
}

/**
 * Features implied by the tags of the parts that became volumes of `massing`.
 * Parts with no volume (merged away or dropped by massing) are skipped and counted in `warnings`.
 */
export function featuresFromTags(massing: Massing, parts: ReadonlyArray<TagPart>): { features: FeatureSpec[]; origin: OriginFeature[]; warnings: string[] } {
  const byId = new Map(massing.volumes.map(v => [v.id, v]));
  const origin: OriginFeature[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (const part of parts) {
    const v = byId.get(volumeIdForPart(part.partId));
    if (!v) { skipped++; continue; }
    const t = part.tags;
    const b = boundsOf(v);
    const maxSide = Math.max(b.w, b.d), minSide = Math.min(b.w, b.d);
    const height = v.topM - v.baseM;
    const add = (kind: FeatureKind, spec: Omit<FeatureSpec, 'kind' | 'volume' | 'sources'>): void => {
      origin.push({ origin: 'tags', ref: part.partId, spec: { kind, volume: v.id, sources: [part.sourceId], ...spec } });
    };
    const rise = parseLengthM(t['roof:height']);
    const roof = t['roof:shape'];

    if (roof === 'pyramidal' || roof === 'cone' || roof === 'spire') {
      if (maxSide <= PINNACLE_MAX_SIDE_M) {
        add('pinnacle', { atM: [r6(b.cx), r6(v.topM), r6(b.cz)], sizeM: [r6(b.w), r6(rise ?? 1.5), r6(b.d)], confidence: CONF.pinnacle });
      } else if (rise !== null && rise >= SPIRE_MIN_RISE_M && rise >= SPIRE_SLENDERNESS * maxSide) {
        add('spire', { atM: [r6(b.cx), r6(v.topM), r6(b.cz)], sizeM: [r6(b.w), r6(rise), r6(b.d)], confidence: CONF.spire });
      }
    } else if (roof === 'dome' || roof === 'onion') {
      add('dome', { atM: [r6(b.cx), r6(v.topM), r6(b.cz)], sizeM: [r6(b.w), r6(rise ?? minSide / 2), r6(b.d)], confidence: CONF.dome });
    } else if (roof === 'skillion' && minSide <= FLYING_BUTTRESS_MAX_WIDTH_M && maxSide >= FLYING_BUTTRESS_MIN_LENGTH_M) {
      add('flying-buttress', { atM: [r6(b.cx), r6(v.topM), r6(b.cz)], sizeM: [r6(maxSide), r6(rise ?? 0), r6(minSide)], confidence: CONF.flying });
    }

    if (t['man_made'] === 'chimney') {
      add('chimney', { atM: [r6(b.cx), r6(v.baseM), r6(b.cz)], sizeM: [r6(b.w), r6(height), r6(b.d)], confidence: CONF.chimney });
    }

    if (t['tower:type'] === 'bell_tower') {
      // Belfry openings live in the top quarter of the shaft: two lancets per long face.
      for (const e of longEdges(v)) {
        const h = 0.22 * height;
        add('lancet', {
          edge: e.index, atM: [r6(e.length / 2), r6(v.topM - 0.3 * height), 0], sizeM: [1.5, r6(h), DEFAULT_DEPTH_M.lancet],
          count: 2, spacingM: 3, confidence: CONF.belfry,
        });
      }
    } else if (t['tower:type'] === 'clock') {
      const e = longEdges(v).reduce<EdgeInfo | undefined>((best, k) => (!best || k.length > best.length ? k : best), undefined);
      if (e) add('clock', { edge: e.index, atM: [r6(e.length / 2), r6(v.topM - 0.25 * height), 0], sizeM: [2.5, 2.5, DEFAULT_DEPTH_M.clock], confidence: CONF.clock });
    }

    const levels = parseInt(t['building:levels'] ?? '', 10);
    if (Number.isFinite(levels) && levels >= 1 && height > 0) {
      const lh = height / levels;
      for (const e of longEdges(v)) {
        const count = Math.floor(e.length / WINDOW_PITCH_M);
        if (count < 1) continue;
        for (let lv = 0; lv < levels; lv++) {
          const spec: Omit<FeatureSpec, 'kind' | 'volume' | 'sources'> = {
            edge: e.index, atM: [r6(e.length / 2), r6(v.baseM + lv * lh + 0.25 * lh), 0] as Vec3m,
            sizeM: [1.2, r6(Math.min(1.8, 0.55 * lh)), 0.3], confidence: CONF.levels,
          };
          if (count > 1) { spec.count = count; spec.spacingM = WINDOW_PITCH_M; }
          add('window', spec);
        }
      }
    }
  }
  if (skipped > 0) warnings.push(`tags: ${skipped} tagged part(s) have no volume in the massing (merged or dropped)`);
  return { features: origin.map(o => o.spec), origin, warnings };
}
