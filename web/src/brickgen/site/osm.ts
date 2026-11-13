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
import { coverageFraction } from '../massing/geometry.js';
import type { MassVolume, RoofShape, RoofSpec, SiteEvidence, SourceRef, Vec2m } from '../types.js';

/** `SiteEvidence.measurements[].what` prefix carrying a part's roof rise in metres (`roof-rise:way/123`). */
export const ROOF_RISE_PREFIX = 'roof-rise:';
/**
 * `SiteEvidence.measurements[].what` prefix marking a footprint entry as a building OUTLINE rather than a part
 * (`building-outline:way/123`). `SiteEvidence` has no such field (`types.ts` is X-08's). Massing lets parts replace an
 * outline wherever they cover it, whatever the heights, instead of the outline hiding the parts.
 */
export const OUTLINE_PREFIX = 'building-outline:';
/** Attribution string ODbL requires wherever OSM-derived data is used. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0)';
/** `SiteEvidence.measurements[].what` prefix carrying a part's `roof:direction` as a compass bearing in DEGREES (in `valueM`). */
export const ROOF_DIRECTION_PREFIX = 'roof-direction-deg:';
/**
 * A `building:part` belongs to the chosen building outline when at least this fraction of its footprint lies inside
 * it. OSM defines a part as lying within its building; an Overpass radius query also returns the neighbours' parts.
 */
export const PART_INSIDE_OUTLINE_MIN = 0.5;
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
  /**
   * Several outlines for a site that is more than one building (Tower Bridge's two towers, a castle's separate halls).
   * A `building` element named here is massed as an outline; any other element (a bridge or site area) only says where
   * the site is, so the parts inside it are kept; a named `building:part` is kept as a part. Beats `buildingId`.
   */
  buildingIds?: string[];
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

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Parses an OSM `roof:direction` / `direction` value (degrees clockwise from north, or a 16-point compass name) to degrees, or null. */
export function parseBearingDeg(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const named = COMPASS_POINTS.indexOf(raw.trim().toUpperCase());
  if (named >= 0) return named * 22.5;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(raw);
  if (!m) return null;
  const v = parseFloat(m[1]!.replace(',', '.'));
  return Number.isFinite(v) ? ((v % 360) + 360) % 360 : null;
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
  type Ringed = (typeof withRings)[number];
  const isPart = (e: OverpassElement): boolean => e.tags?.['building:part'] !== undefined && e.tags['building:part'] !== 'no';
  const allPartEls = withRings.filter(({ e }) => isPart(e));
  // `building:part=no` on a `building` (the Eiffel Tower, the Elizabeth Tower) says "this is a whole building, not a
  // part of one": it is an outline, and so is any `building` that carries no part tag.
  const buildingEls = withRings.filter(({ e }) => e.tags?.['building'] !== undefined && !isPart(e));
  const rawArea = (r: LatLon[]): number => Math.abs(r.reduce((s, p, i) => {
    const q = r[(i + 1) % r.length]!;
    return s + p.lon * q.lat - q.lon * p.lat;
  }, 0));

  // Which elements the caller chose: a `building` is an outline (massed), any other element (a site area, a bridge) only
  // says where the site is (its parts are admitted, it is not massed), a `building:part` is admitted as a part.
  const chosen = opts.buildingIds ?? (opts.buildingId ? [opts.buildingId] : []);
  const outlines: Ringed[] = [], areas: Ringed[] = [], forcedParts = new Set<string>();
  for (const id of chosen) {
    const el = withRings.find(({ e }) => key(e) === id);
    if (!el) throw new Error(`osm: ${id} is not in the response`);
    if (isPart(el.e)) forcedParts.add(id);
    else if (buildingEls.includes(el)) outlines.push(el);
    else areas.push(el);
  }
  if (chosen.length === 0) {
    const largest = [...buildingEls].sort((a, b) => rawArea(b.r.outer) - rawArea(a.r.outer))[0];
    if (largest) outlines.push(largest);
  }
  const regions = [...outlines, ...areas];
  if (regions.length === 0 && allPartEls.length === 0) throw new Error('osm: no building or building:part geometry in the response');

  // A part that lies outside every outline belongs to a neighbour the query also returned: leave it out (reported).
  let partEls = allPartEls;
  /** The outline (or area) a part lies in, by the fraction of its footprint inside it. */
  const ownerOf = new Map<string, Ringed>();
  if (regions.length > 0) {
    const lats = regions.flatMap(o => o.r.outer.map(p => p.lat)), lons = regions.flatMap(o => o.r.outer.map(p => p.lon));
    const centre = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lng: (Math.min(...lons) + Math.max(...lons)) / 2 };
    const local = (ring: LatLon[]): Vec2m[] => projectPolygonToLocal(ring, centre, 0).map(p => [p.x, p.z] as Vec2m);
    const regionLocal = regions.map(o => ({ o, outer: local(o.r.outer), holes: o.r.holes.map(local) }));
    partEls = allPartEls.filter(({ e, r }) => {
      if (forcedParts.has(key(e))) return true;
      const outer = local(r.outer), holes = r.holes.map(local);
      let best = 0, owner: Ringed | undefined;
      for (const reg of regionLocal) {
        const inside = coverageFraction(outer, holes, [{ outer: reg.outer, holes: reg.holes }], 0.25);
        if (inside > best) { best = inside; owner = reg.o; }
      }
      if (owner && best >= PART_INSIDE_OUTLINE_MIN) { ownerOf.set(key(e), owner); return true; }
      warnings.push(`${key(e)}: ${Math.round(best * 100)}% inside ${regions.length === 1 ? 'the outline' : 'any outline'} ${regions.map(o => key(o.e)).join(', ')}; left out as a neighbouring building`);
      return false;
    });
  }

  // Centre the frame on the bounding box of everything we use.
  const used = [...outlines, ...partEls];
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

  const outlineHeights = new Map<string, number>();
  for (const outline of outlines) {
    const t = outline.e.tags ?? {};
    const id = key(outline.e);
    const hasParts = partEls.some(({ e }) => ownerOf.get(key(e)) === outline);
    const levels = parseInt(t['building:levels'] ?? '', 10);
    const tagged = parseLengthM(t['height']);
    if (tagged !== null) outlineHeights.set(id, tagged);
    const h = tagged ?? (Number.isFinite(levels) ? levels * METRES_PER_LEVEL : null);
    if (h === null && !hasParts) warnings.push(`${id}: no height or levels tagged, using ${DEFAULT_HEIGHT_M} m`);
    // The outline is also a part (its footprint carries the outline's id); massing decides where the parts replace it.
    const roof = roofShapeFromOsm(t['roof:shape']);
    if (!roof.known) warnings.push(`${id}: roof:shape=${t['roof:shape']} has no RoofShape, using flat`);
    footprint.push({ outer: project(outline.r.outer), holes: outline.r.holes.map(project), partId: id });
    ref(outline.e, ['footprint', 'outline height']);
    parts.push({ partId: id, baseM: 0, heightM: h ?? DEFAULT_HEIGHT_M, roof: { shape: roof.shape }, colourHint: t['building:colour'] });
    measurements.push({ what: `${OUTLINE_PREFIX}${id}`, valueM: 1, source: `osm-${outline.e.type}-${outline.e.id}` });
    const role = roleFromTags(t);
    if (role) roles[id] = role;
    const rise = parseLengthM(t['roof:height']);
    if (rise !== null) measurements.push({ what: `${ROOF_RISE_PREFIX}${id}`, valueM: rise, source: `osm-${outline.e.type}-${outline.e.id}` });
    const dir = parseBearingDeg(t['roof:direction']);
    if (dir !== null) measurements.push({ what: `${ROOF_DIRECTION_PREFIX}${id}`, valueM: dir, source: `osm-${outline.e.type}-${outline.e.id}` });
  }

  for (const { e, r } of partEls) {
    const t = e.tags ?? {};
    footprint.push({ outer: project(r.outer), holes: r.holes.map(project), partId: key(e) });
    ref(e, ['footprint', 'part height']);
    const top = parseLengthM(t['height']) ?? parseLengthM(t['building:height']);
    const levels = parseInt(t['building:levels'] ?? '', 10);
    const owner = ownerOf.get(key(e));
    const outlineHeight = owner ? outlineHeights.get(key(owner.e)) ?? null : null;
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
    const dir = parseBearingDeg(t['roof:direction']);
    if (dir !== null) measurements.push({ what: `${ROOF_DIRECTION_PREFIX}${key(e)}`, valueM: dir, source: `osm-${e.type}-${e.id}` });
    // TODO(roof-orientation): roof:orientation (gable ridge axis, `along`/`across`) is not carried yet.
  }

  const tags = outlines[0]?.e.tags ?? {};
  return {
    site: {
      name: opts.name ?? tags['name:en'] ?? tags['name'] ?? 'OSM site',
      sources, footprint, parts, measurements, annotations: [],
    },
    roles, origin, warnings,
  };
}
