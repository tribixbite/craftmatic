/**
 * OSM (Overpass JSON) -> `SiteEvidence` (A05, BIZ-05).
 *
 * Pure: it parses an Overpass `out geom;` response that the caller already holds (a live fetch through
 * `fetchOSMById`/`searchOSMBuildingParts` in `src/gen/api/osm.ts`, or a committed fixture), so tests are offline.
 * It reuses that module's `OverpassElement` shape and the pipeline's `projectPolygonToLocal` projection.
 *
 * Frame: local metres around the building's bounding-box centre, x EAST, z SOUTH (the stud lattice's own x/z).
 *
 * Height semantics follow the OSM wiki: `height` is the TOP of the part including its roof, `min_height` the
 * bottom, `roof:height` the roof's share of `height`. The wall top is therefore `height - roof:height`; the roof
 * rise is recorded as a `roof-rise:<partId>` measurement (see `ROOF_RISE_PREFIX`) because `RoofSpec` has no rise
 * field and `types.ts` belongs to X-08.
 *
 * Licence: everything produced here is ODbL, "(c) OpenStreetMap contributors".
 */
import type { OverpassElement } from '@craft/gen/api/osm';
import { projectPolygonToLocal } from '@craft/pipeline/synthesis/features';
import type { MassVolume, RoofShape, RoofSpec, SiteEvidence, SourceRef, Vec2m } from '../types.js';

/** `SiteEvidence.measurements[].what` prefix carrying a part's roof rise in metres (`roof-rise:way/123`). */
export const ROOF_RISE_PREFIX = 'roof-rise:';
/** Attribution string ODbL requires wherever OSM-derived data is used. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0)';
/** Metres per `building:levels` level when only levels are tagged (OSM 3D renderers use 3 m; 3.2 adds a floor slab). */
export const METRES_PER_LEVEL = 3.2;
/** Height used when neither a height nor levels is tagged anywhere (3 levels), with a warning. */
export const DEFAULT_HEIGHT_M = 9.6;

export type PartRole = MassVolume['role'];

/** What `siteFromOverpass` hands back: the evidence plus the side data massing consumes. */
export interface OsmSiteResult {
  site: SiteEvidence;
  /** Role hint per part id (`way/123`), from `tower:type`, `man_made` and `building:part` values. */
  roles: Record<string, PartRole>;
  /** WGS84 centre the metre frame is centred on. */
  origin: { lat: number; lng: number };
  /** Things that were guessed or skipped; never silent. */
  warnings: string[];
}

export interface OsmSiteOptions {
  /** Working title; defaults to the building's `name:en` / `name`. */
  name?: string;
  /** `type/id` (`way/201611261`) of the building outline when several `building` elements are present. */
  buildingId?: string;
  /** ISO retrieval date recorded in each `SourceRef`. */
  retrieved: string;
  /** Overpass URL or fixture path recorded as the source URL. */
  url?: string;
}

interface LatLon { lat: number; lon: number }

/** Parses an OSM length tag ("12", "12.5 m", "40 ft", `3'6"`-free) to metres, or null when unparseable. */
export function parseLengthM(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m|ft|feet|'|)\s*$/i.exec(raw);
  if (!m) return null;
  const v = parseFloat(m[1]!.replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  return /^(ft|feet|')$/i.test(m[2]!) ? v * 0.3048 : v;
}

/** Maps an OSM `roof:shape` value to the nearest `RoofShape`; unknown values fall back to flat (reported). */
export function roofShapeFromOsm(tag: string | undefined): { shape: RoofShape; known: boolean } {
  switch (tag) {
    case undefined: case 'flat': return { shape: 'flat', known: true };
    case 'gabled': case 'gable': case 'gambrel': case 'saltbox': return { shape: 'gabled', known: true };
    case 'hipped': case 'half-hipped': case 'hip': return { shape: 'hipped', known: true };
    case 'pyramidal': return { shape: 'pyramidal', known: true };
    case 'dome': return { shape: 'dome', known: true };
    case 'onion': return { shape: 'onion', known: true };
    case 'cone': case 'conical': return { shape: 'conical', known: true };
    case 'mansard': return { shape: 'mansard', known: true };
    case 'skillion': case 'shed': case 'lean_to': return { shape: 'shed', known: true };
    // TODO(roof-shapes): round, quadruple_saltbox, sawtooth and others have no RoofShape yet.
    default: return { shape: 'flat', known: false };
  }
}

/** The first `inner`/`outer` ring set of a relation, assembling open member ways into closed rings by shared ends. */
function assembleRings(members: ReadonlyArray<LatLon[]>): LatLon[][] {
  const same = (a: LatLon, b: LatLon): boolean => a.lat === b.lat && a.lon === b.lon;
  const pending = members.map(m => [...m]);
  const rings: LatLon[][] = [];
  while (pending.length > 0) {
    let cur = pending.shift()!;
    let grew = true;
    while (grew && !same(cur[0]!, cur[cur.length - 1]!)) {
      grew = false;
      for (let i = 0; i < pending.length; i++) {
        const w = pending[i]!;
        if (same(cur[cur.length - 1]!, w[0]!)) cur = cur.concat(w.slice(1));
        else if (same(cur[cur.length - 1]!, w[w.length - 1]!)) cur = cur.concat([...w].reverse().slice(1));
        else if (same(cur[0]!, w[w.length - 1]!)) cur = w.concat(cur.slice(1));
        else if (same(cur[0]!, w[0]!)) cur = [...w].reverse().concat(cur.slice(1));
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (same(cur[0]!, cur[cur.length - 1]!) && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

/** Outer ring + holes of a way or multipolygon relation, in lat/lon, closing vertex removed; null when none. */
function elementRings(el: OverpassElement): { outer: LatLon[]; holes: LatLon[][] } | null {
  const open = (r: LatLon[]): LatLon[] => r.slice(0, -1).map(p => ({ lat: p.lat, lon: p.lon }));
  if (el.type === 'way' && el.geometry && el.geometry.length >= 4) return { outer: open(el.geometry), holes: [] };
  if (el.type === 'relation' && el.members) {
    const geom = (role: string): LatLon[][] =>
      el.members!.filter(m => m.role === role && m.geometry && m.geometry.length >= 2).map(m => m.geometry!);
    const outers = assembleRings(geom('outer'));
    if (outers.length === 0) return null;
    // TODO(multi-outer): a relation with several outer rings (a split building) keeps only the largest here.
    const area = (r: LatLon[]): number => Math.abs(r.reduce((s, p, i) => {
      const q = r[(i + 1) % r.length]!;
      return s + p.lon * q.lat - q.lon * p.lat;
    }, 0));
    outers.sort((a, b) => area(b) - area(a));
    return { outer: open(outers[0]!), holes: assembleRings(geom('inner')).map(open) };
  }
  return null;
}

/** Role hint from tags (the plan's tower/nave/... vocabulary), or undefined for a plain body. */
export function roleFromTags(tags: Record<string, string>): PartRole | undefined {
  if (tags['man_made'] === 'tower' || tags['tower:type'] !== undefined) return 'tower';
  const v = tags['building:part'];
  if (v === 'nave' || v === 'aisle' || v === 'transept' || v === 'apse' || v === 'podium' || v === 'deck' || v === 'pier') return v;
  return undefined;
}

/**
 * Builds `SiteEvidence` from an Overpass response. The building outline is the `building` element named by
 * `buildingId`, else the largest-area one that carries a `building` tag and is not an apartment neighbour of a
 * `building:part` set; every `building:part` way becomes a part with its own footprint entry (`partId`).
 *
 * @throws when the response holds no usable building geometry.
 */
export function siteFromOverpass(json: { elements?: OverpassElement[] }, opts: OsmSiteOptions): OsmSiteResult {
  const warnings: string[] = [];
  const els = json.elements ?? [];
  const key = (e: OverpassElement): string => `${e.type}/${e.id}`;
  const withRings = els.flatMap(e => { const r = elementRings(e); return r ? [{ e, r }] : []; });
  const partEls = withRings.filter(({ e }) => e.tags?.['building:part'] !== undefined && e.tags['building:part'] !== 'no');
  const buildingEls = withRings.filter(({ e }) => e.tags?.['building'] !== undefined && e.tags['building:part'] === undefined);
  const rawArea = (r: LatLon[]): number => Math.abs(r.reduce((s, p, i) => {
    const q = r[(i + 1) % r.length]!;
    return s + p.lon * q.lat - q.lon * p.lat;
  }, 0));
  const outline = opts.buildingId
    ? buildingEls.find(({ e }) => key(e) === opts.buildingId)
    : [...buildingEls].sort((a, b) => rawArea(b.r.outer) - rawArea(a.r.outer))[0];
  if (opts.buildingId && !outline) throw new Error(`osm: ${opts.buildingId} is not in the response`);
  if (!outline && partEls.length === 0) throw new Error('osm: no building or building:part geometry in the response');

  // Centre the frame on the bounding box of everything we use.
  const used = [...(outline ? [outline] : []), ...partEls];
  const all = used.flatMap(u => u.r.outer);
  const origin = {
    lat: (Math.min(...all.map(p => p.lat)) + Math.max(...all.map(p => p.lat))) / 2,
    lng: (Math.min(...all.map(p => p.lon)) + Math.max(...all.map(p => p.lon))) / 2,
  };
  const project = (ring: LatLon[]): Vec2m[] =>
    projectPolygonToLocal(ring, origin, 0).map(p => [p.x, p.z] as Vec2m);

  const sources: SourceRef[] = [];
  const footprint: SiteEvidence['footprint'] = [];
  const parts: SiteEvidence['parts'] = [];
  const measurements: SiteEvidence['measurements'] = [];
  const roles: Record<string, PartRole> = {};
  const ref = (e: OverpassElement, usedFor: string[]): void => {
    sources.push({
      id: `osm-${e.type}-${e.id}`, kind: 'osm', url: opts.url, retrieved: opts.retrieved,
      licence: 'odbl', attribution: OSM_ATTRIBUTION, usedFor,
    });
  };

  const outlineHeight = outline ? parseLengthM(outline.e.tags?.['height']) : null;
  if (outline) {
    footprint.push({ outer: project(outline.r.outer), holes: outline.r.holes.map(project) });
    ref(outline.e, ['footprint', 'outline height']);
    const t = outline.e.tags ?? {};
    const levels = parseInt(t['building:levels'] ?? '', 10);
    const h = outlineHeight ?? (Number.isFinite(levels) ? levels * METRES_PER_LEVEL : null);
    if (h === null && partEls.length === 0) warnings.push(`${key(outline.e)}: no height or levels tagged, using ${DEFAULT_HEIGHT_M} m`);
    // The outline is also a part (partId-less footprint is the outline); massing decides whether parts replace it.
    const roof = roofShapeFromOsm(t['roof:shape']);
    if (!roof.known) warnings.push(`${key(outline.e)}: roof:shape=${t['roof:shape']} has no RoofShape, using flat`);
    parts.push({
      partId: key(outline.e), baseM: 0, heightM: h ?? DEFAULT_HEIGHT_M, roof: { shape: roof.shape },
      colourHint: t['building:colour'],
    });
    footprint[0]!.partId = key(outline.e);
    const role = roleFromTags(t);
    if (role) roles[key(outline.e)] = role;
    const rise = parseLengthM(t['roof:height']);
    if (rise !== null) measurements.push({ what: `${ROOF_RISE_PREFIX}${key(outline.e)}`, valueM: rise, source: `osm-${outline.e.type}-${outline.e.id}` });
  }

  for (const { e, r } of partEls) {
    const t = e.tags ?? {};
    footprint.push({ outer: project(r.outer), holes: r.holes.map(project), partId: key(e) });
    ref(e, ['footprint', 'part height']);
    const top = parseLengthM(t['height']) ?? parseLengthM(t['building:height']);
    const levels = parseInt(t['building:levels'] ?? '', 10);
    let heightM: number;
    if (top !== null) heightM = top;
    else if (Number.isFinite(levels)) { heightM = levels * METRES_PER_LEVEL; warnings.push(`${key(e)}: height from building:levels ${levels}`); }
    else if (outlineHeight !== null) { heightM = outlineHeight; warnings.push(`${key(e)}: no height, inherited the outline's ${outlineHeight} m`); }
    else { heightM = DEFAULT_HEIGHT_M; warnings.push(`${key(e)}: no height or levels anywhere, using ${DEFAULT_HEIGHT_M} m`); }
    let baseM = parseLengthM(t['min_height']) ?? 0;
    const minLevel = parseInt(t['building:min_level'] ?? '', 10);
    if (t['min_height'] === undefined && Number.isFinite(minLevel)) baseM = minLevel * METRES_PER_LEVEL;
    const roof: RoofSpec = { shape: roofShapeFromOsm(t['roof:shape']).shape };
    if (!roofShapeFromOsm(t['roof:shape']).known) warnings.push(`${key(e)}: roof:shape=${t['roof:shape']} has no RoofShape, using flat`);
    parts.push({ partId: key(e), baseM, heightM, roof, colourHint: t['building:colour'] ?? t['building:facade:colour'] });
    const role = roleFromTags(t);
    if (role) roles[key(e)] = role;
    const rise = parseLengthM(t['roof:height']);
    if (rise !== null) measurements.push({ what: `${ROOF_RISE_PREFIX}${key(e)}`, valueM: rise, source: `osm-${e.type}-${e.id}` });
    // TODO(roof-direction): roof:direction / roof:orientation (skillion slope, ridge axis) is not carried yet.
  }

  const tags = outline?.e.tags ?? {};
  return {
    site: {
      name: opts.name ?? tags['name:en'] ?? tags['name'] ?? 'OSM site',
      sources, footprint, parts, measurements, annotations: [],
    },
    roles, origin, warnings,
  };
}
