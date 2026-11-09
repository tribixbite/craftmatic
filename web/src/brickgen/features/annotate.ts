/**
 * Annotation sidecars (A09, BIZ-05): the reliable v1 path from licensed photos and drawings to features.
 *
 * A reviewer (an agent or a person) marks windows, portals, rose windows, buttresses, towers and spires on a
 * rectified image and writes the marks to a JSON sidecar (`types.ts`, schema `craftmatic.facade-annotations/1`).
 * The sidecar also lists every image as a `SourceRef` with its URL, author and licence, so the licence gate can
 * refuse anything it should. An annotation is human authority: it beats every automatic source (`merge.ts`).
 * The image itself is never read here and never ships; only the marks and their calibration are used.
 *
 * `TODO(annotate-ui)`: a small web page that writes this JSON from clicks on the image.
 * `TODO(photo-analysis)`: `analyzeFenestration`/`detectStories` (`src/gen/api/streetview-analysis.ts`) as a
 * SUGGESTION adapter that proposes marks for a reviewer to accept; it must never enter a design unreviewed.
 */
import type { FeatureSpec, MassVolume, SourceRef, Vec3m } from '../types.js';
import { mapFacade, volumeIdForPart } from './frame.js';
import {
  DEFAULT_DEPTH_M, SIDECAR_SCHEMA, SOURCE_AUTHORITY, type AnnotationMark, type AnnotationSidecar, type FacadeEntry, type OriginFeature,
} from './types.js';

/** Thrown by `parseSidecar`; carries every problem found. */
export class SidecarError extends Error {
  constructor(readonly problems: string[]) {
    super(`annotation sidecar is invalid: ${problems.join('; ')}`);
    this.name = 'SidecarError';
  }
}

const KINDS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_DEPTH_M));
const FACINGS: ReadonlySet<string> = new Set(['north', 'south', 'east', 'west']);

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Validates parsed JSON as an `AnnotationSidecar` and returns it typed.
 * @throws SidecarError listing every problem (not only the first).
 */
export function parseSidecar(raw: unknown): AnnotationSidecar {
  const problems: string[] = [];
  const bad = (msg: string): void => { problems.push(msg); };
  if (!isObj(raw)) throw new SidecarError(['the sidecar is not a JSON object']);
  if (raw['schema'] !== SIDECAR_SCHEMA) bad(`schema must be "${SIDECAR_SCHEMA}", got ${JSON.stringify(raw['schema'])}`);
  if (typeof raw['site'] !== 'string' || raw['site'].length === 0) bad('site must be a non-empty string');
  if (!Array.isArray(raw['sources'])) bad('sources must be an array');
  if (!Array.isArray(raw['facades'])) bad('facades must be an array');
  const sources = Array.isArray(raw['sources']) ? raw['sources'] : [];
  const ids = new Set<string>();
  sources.forEach((s, i) => {
    if (!isObj(s) || typeof s['id'] !== 'string') { bad(`sources[${i}] needs a string id`); return; }
    if (ids.has(s['id'])) bad(`sources[${i}]: duplicate source id ${s['id']}`);
    ids.add(s['id']);
    for (const k of ['kind', 'retrieved', 'licence'] as const) if (typeof s[k] !== 'string') bad(`source ${s['id']}: ${k} must be a string`);
    if (!Array.isArray(s['usedFor'])) bad(`source ${s['id']}: usedFor must be an array`);
  });
  const facades = Array.isArray(raw['facades']) ? raw['facades'] : [];
  const facadeIds = new Set<string>();
  facades.forEach((f, i) => {
    if (!isObj(f)) { bad(`facades[${i}] is not an object`); return; }
    const id = typeof f['id'] === 'string' ? f['id'] : `#${i}`;
    if (facadeIds.has(id)) bad(`facade ${id}: duplicate id`);
    facadeIds.add(id);
    if (typeof f['source'] !== 'string') bad(`facade ${id}: source must be a SourceRef id`);
    if (typeof f['volume'] !== 'string') bad(`facade ${id}: volume must be a string`);
    const hasEdge = f['edge'] !== undefined, hasFacing = f['facing'] !== undefined;
    if (hasEdge === hasFacing) bad(`facade ${id}: give exactly one of edge or facing`);
    if (hasEdge && !(Number.isInteger(f['edge']) && (f['edge'] as number) >= 0)) bad(`facade ${id}: edge must be a non-negative integer`);
    if (hasFacing && !FACINGS.has(String(f['facing']))) bad(`facade ${id}: facing ${JSON.stringify(f['facing'])} is not north/south/east/west`);
    const cal = f['calibration'];
    if (!isObj(cal) || !isNum(cal['groundRowPx'])) bad(`facade ${id}: calibration.groundRowPx is required`);
    if (!Array.isArray(f['marks'])) { bad(`facade ${id}: marks must be an array`); return; }
    const markIds = new Set<string>();
    f['marks'].forEach((m, j) => {
      if (!isObj(m)) { bad(`facade ${id} marks[${j}] is not an object`); return; }
      const mid = typeof m['id'] === 'string' ? m['id'] : `#${j}`;
      if (markIds.has(mid)) bad(`facade ${id}: duplicate mark id ${mid}`);
      markIds.add(mid);
      if (!KINDS.has(String(m['kind']))) bad(`facade ${id} mark ${mid}: kind ${JSON.stringify(m['kind'])} is not a FeatureKind`);
      const b = m['boxPx'];
      if (!Array.isArray(b) || b.length !== 4 || !b.every(isNum)) bad(`facade ${id} mark ${mid}: boxPx must be four numbers`);
      else if (b[0] === b[2] || b[1] === b[3]) bad(`facade ${id} mark ${mid}: boxPx has no area`);
      if (m['count'] !== undefined && !(Number.isInteger(m['count']) && (m['count'] as number) >= 1)) bad(`facade ${id} mark ${mid}: count must be an integer >= 1`);
      if (m['confidence'] !== undefined && !(isNum(m['confidence']) && m['confidence'] >= 0 && m['confidence'] <= 1)) bad(`facade ${id} mark ${mid}: confidence must be 0..1`);
    });
  });
  if (problems.length > 0) throw new SidecarError(problems);
  return raw as unknown as AnnotationSidecar;
}

/** Confidence of a mark: its own, else the authority of its source kind (0.9 when the kind has none listed). */
function markConfidence(mark: AnnotationMark, source: SourceRef | undefined): number {
  return mark.confidence ?? SOURCE_AUTHORITY[source?.kind ?? 'photo'] ?? 0.9;
}

/** Rounds to micrometres so floating-point noise never reaches a golden file. */
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * Turns every facade of a sidecar into features on the massing's volumes.
 * @throws Error naming the facade for an unknown volume, edge or scale.
 */
export function featuresFromAnnotations(volumes: ReadonlyArray<MassVolume>, sidecar: AnnotationSidecar): OriginFeature[] {
  const byId = new Map(volumes.map(v => [v.id, v]));
  const sources = new Map(sidecar.sources.map(s => [s.id, s]));
  const out: OriginFeature[] = [];
  for (const entry of sidecar.facades) {
    const vid = volumeIdForPart(entry.volume);
    const vol = byId.get(vid);
    if (!vol) throw new Error(`facade ${entry.id}: volume ${vid} is not in the massing (dropped or misnamed)`);
    const map = mapFacade(entry as FacadeEntry, vol);
    const src = sources.get(entry.source);
    for (const mark of entry.marks) {
      const [ax, ay, bx, by] = mark.boxPx;
      const xl = Math.min(ax, bx), xr = Math.max(ax, bx), yt = Math.min(ay, by), yb = Math.max(ay, by);
      const centre = map.planAt((xl + xr) / 2);
      const edge = map.edgeFor(centre);
      const along = (centre[0] - edge.a[0]) * edge.dir[0] + (centre[1] - edge.a[1]) * edge.dir[1];
      const count = mark.count ?? 1;
      const runW = (xr - xl) * map.scaleX;
      const sizeM: Vec3m = [r6(runW / count), r6((yb - yt) * map.scaleY), mark.depthM ?? DEFAULT_DEPTH_M[mark.kind]];
      const spec: FeatureSpec = {
        kind: mark.kind, volume: vid, edge: edge.index,
        atM: [r6(along), r6(map.heightAt(yb)), 0], sizeM,
        confidence: markConfidence(mark, src), sources: [entry.source],
      };
      if (count > 1) { spec.count = count; spec.spacingM = r6(runW / count); }
      out.push({ origin: 'annotation', spec, ref: `${entry.id}/${mark.id}` });
    }
  }
  return out;
}
