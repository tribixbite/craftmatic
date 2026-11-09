/**
 * Features stage (A09, BIZ-05): `Massing` + inputs -> `FeatureSet`, ready for the grammar/bricker stages.
 *
 * Inputs, strongest first:
 *  1. annotation sidecars on licensed photos/drawings (`annotate.ts`): human authority;
 *  2. mesh slices (`mesh.ts`): measured from a licence-clean mesh;
 *  3. OSM tags (`tags.ts`): guesses from sparse data.
 * `mergeFeatures` lets the stronger source replace the weaker one. Every input passes the licence gate first
 * (`site/licence-gate.ts`: Google content, unknown licences, share-alike meshes and missing attributions are
 * refused for a commercial run, which is the default), and every feature cites a `SourceRef` id that exists in the
 * merged evidence.
 *
 * Not here: the optional image-to-3D adapter (B15's GLB of a licence-clean elevation photo, measured locally and
 * never shipped) is `TODO(b15-adapter)`: its mesh would enter through `meshes` like any other once B15 merges.
 */
import type { MeshSliceInput } from '@craft/pipeline/synthesis/slice-extract';
import type { MassingResult } from '../massing/index.js';
import { assertSiteLicences, LicenceGateError, type LicenceFinding, type LicenceGateResult } from '../site/licence-gate.js';
import type { FeatureSet, SiteEvidence, SourceRef } from '../types.js';
import { featuresFromAnnotations } from './annotate.js';
import { featuresFromMesh } from './mesh.js';
import { mergeFeatures } from './merge.js';
import { buildStyle } from './style.js';
import { featuresFromTags, type TagPart } from './tags.js';
import { toFacadeAnnotation, type AnnotationSidecar, type FeatureOrigin, type OriginFeature, type SupersededFeature } from './types.js';

export { parseSidecar, SidecarError } from './annotate.js';
export { featuresFromTags, tagPartsFromOverpass, type TagPart } from './tags.js';
export { featuresFromMesh } from './mesh.js';
export * from './types.js';

/** A mesh to slice, with the `SourceRef` id it came from (kind `mesh` or `lidar`). Site-frame metres, y up. */
export type MeshInput = MeshSliceInput & { source: string };

export interface FeatureInputs {
  site: SiteEvidence;
  massing: MassingResult;
  sidecars?: ReadonlyArray<AnnotationSidecar>;
  tagParts?: ReadonlyArray<TagPart>;
  /** Meshes to slice; defaults to `site.mesh` when the site carries one. */
  meshes?: ReadonlyArray<MeshInput>;
  /** True (default) for a run that ships: Google/unknown inputs are refused. Pass false only for local comparison. */
  commercial?: boolean;
}

export interface FeatureReport {
  /** Features per origin after precedence. */
  byOrigin: Record<FeatureOrigin, number>;
  /** Automatic features an annotation or mesh replaced. */
  superseded: SupersededFeature[];
  warnings: string[];
  /** Every `SourceRef` id the stage checked (site + sidecars), sorted. */
  sources: string[];
  licence: LicenceGateResult;
}

export interface FeatureResult { set: FeatureSet; report: FeatureReport }

/** Merges source lists by id; the same id with different content is a mistake worth stopping for. */
function mergeSources(lists: ReadonlyArray<ReadonlyArray<SourceRef>>): SourceRef[] {
  const byId = new Map<string, SourceRef>();
  for (const s of lists.flat()) {
    const have = byId.get(s.id);
    if (have && JSON.stringify(have) !== JSON.stringify(s)) throw new Error(`features: source id ${s.id} is defined twice with different content`);
    byId.set(s.id, s);
  }
  return [...byId.values()];
}

/**
 * Builds the `FeatureSet` of a massing.
 * @throws LicenceGateError when any input is refused; SidecarError-free (parse sidecars with `parseSidecar` first);
 *   Error naming a facade when its volume, edge or scale cannot be resolved.
 */
export function buildFeatureSet(input: FeatureInputs): FeatureResult {
  const { site, massing } = input;
  const sidecars = input.sidecars ?? [];
  const tagParts = input.tagParts ?? [];
  const warnings: string[] = [];

  // 1. Licence gate over the merged evidence: site sources, every sidecar's sources, every facade and mesh reference.
  const sources = mergeSources([site.sources, ...sidecars.map(s => s.sources)]);
  const meshes: MeshInput[] = input.meshes ? [...input.meshes] : site.mesh ? [{ positions: site.mesh.positions, indices: site.mesh.indices, source: site.mesh.source }] : [];
  const merged: SiteEvidence = {
    ...site, sources,
    annotations: [...site.annotations, ...sidecars.flatMap(s => s.facades.map(f => toFacadeAnnotation(f, f.calibration.rectifiedScale ?? 0)))],
  };
  const licence = assertSiteLicencesWith(merged, sidecars, meshes, input.commercial ?? true);
  if (site.annotations.length > 0) {
    warnings.push(`${site.annotations.length} SiteEvidence.annotations entr(ies) carry no image frame (span, ground row) and were not used; write them as a sidecar facade`);
  }

  // 2. Collect.
  const origin: OriginFeature[] = [];
  for (const sc of sidecars) origin.push(...featuresFromAnnotations(massing.massing.volumes, sc));
  for (const [src, group] of groupBySource(meshes)) {
    origin.push(...featuresFromMesh(massing.massing, group, { source: src, frame: massing.frame }).origin);
  }
  const tags = featuresFromTags(massing.massing, tagParts);
  origin.push(...tags.origin);
  warnings.push(...tags.warnings);

  // 3. Every feature must cite a source that exists in the evidence.
  const known = new Set(sources.map(s => s.id));
  for (const o of origin) {
    for (const id of o.spec.sources) if (!known.has(id)) throw new Error(`features: ${o.spec.kind} from ${o.ref} cites unknown source ${id}`);
  }

  // 4. Precedence, style, report.
  const { kept, superseded } = mergeFeatures(origin);
  const byOrigin: Record<FeatureOrigin, number> = { annotation: 0, mesh: 0, tags: 0 };
  for (const k of kept) byOrigin[k.origin]++;
  return {
    set: { features: kept.map(k => k.spec), style: buildStyle(sidecars, tagParts) },
    report: { byOrigin, superseded, warnings, sources: [...known].sort(), licence },
  };
}

function groupBySource(meshes: ReadonlyArray<MeshInput>): Map<string, MeshInput[]> {
  const m = new Map<string, MeshInput[]>();
  for (const x of meshes) m.set(x.source, [...(m.get(x.source) ?? []), x]);
  return m;
}

/** `assertSiteLicences` plus the checks that need the sidecars and mesh inputs: kinds of the sources used. */
function assertSiteLicencesWith(site: SiteEvidence, sidecars: ReadonlyArray<AnnotationSidecar>, meshes: ReadonlyArray<MeshInput>, commercial: boolean): LicenceGateResult {
  const byId = new Map(site.sources.map(s => [s.id, s]));
  const extra: LicenceFinding[] = [];
  for (const f of sidecars.flatMap(s => s.facades)) {
    const s = byId.get(f.source);
    if (s && s.kind !== 'photo' && s.kind !== 'drawing') extra.push({ sourceId: s.id, licence: s.licence, reason: `facade ${f.id} marks a ${s.kind}; annotations belong on a photo or drawing` });
  }
  for (const m of meshes) {
    const s = byId.get(m.source);
    if (!s) extra.push({ sourceId: m.source, licence: 'unresolved', reason: 'a mesh cites a source id that has no SourceRef (and so no licence)' });
    else if (s.kind !== 'mesh' && s.kind !== 'lidar') extra.push({ sourceId: s.id, licence: s.licence, reason: `a mesh input must cite a mesh or lidar source, not ${s.kind}` });
  }
  if (extra.length > 0) {
    try { assertSiteLicences(site, { commercial }); } catch (e) {
      if (e instanceof LicenceGateError) throw new LicenceGateError([...e.findings, ...extra]);
      throw e;
    }
    throw new LicenceGateError(extra);
  }
  return assertSiteLicences(site, { commercial });
}
