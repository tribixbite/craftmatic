/**
 * The input licence gate (A05, BIZ-06).
 *
 * Every input of a design carries a `SourceRef` with its licence. For a COMMERCIAL run (anything that ships) the
 * gate refuses:
 *  - `google-maps-content`: Google Maps Platform Terms 3.2.3(c) forbid creating content (including 3D building
 *    models) from Google content. Google tiles, Street View and satellite imagery stay available for LOCAL
 *    comparison only (non-commercial runs warn);
 *  - `unknown`: an input nobody can show a licence for;
 *  - a source whose URL is Google-hosted but which claims another licence (a mislabelled Google input);
 *  - a mesh or LiDAR input under `cc-by-sa` (the derivative geometry would ship; the plan allows share-alike
 *    material for measurement from photos, drawings and documented dimensions only);
 *  - a licence that requires attribution (`cc-by`, `cc-by-sa`, `odbl`, `ogl-uk`, `licence-ouverte`) with none
 *    recorded;
 *  - evidence that references a source id missing from `sources` (annotations, measurements, the mesh), which is
 *    treated as `unknown`;
 *  - evidence with geometry but no sources at all.
 *
 * It is pure and returns every finding at once; `assertSiteLicences` throws `LicenceGateError` listing them.
 */
import type { InputLicence, SiteEvidence, SourceRef } from '../types.js';

export interface LicenceFinding {
  /** The offending source id (or the unresolved reference). */
  sourceId: string;
  licence: InputLicence | 'unresolved';
  reason: string;
}

export interface LicenceGateResult {
  /** True when nothing was refused. */
  ok: boolean;
  refused: LicenceFinding[];
  /** Non-blocking findings (a non-commercial run using Google or unknown inputs). */
  warnings: LicenceFinding[];
  /** Distinct attribution lines the shipped design must carry (credits file input). */
  attributions: string[];
}

export interface LicenceGateOptions {
  /** True for any run whose output ships or is sold. There is deliberately no default here. */
  commercial: boolean;
}

/** Licences that legally require the attribution text to be recorded. */
const NEEDS_ATTRIBUTION: ReadonlySet<InputLicence> = new Set<InputLicence>([
  'cc-by', 'cc-by-sa', 'odbl', 'ogl-uk', 'licence-ouverte',
]);

/** URL hosts that are Google Maps Platform content regardless of what a source claims. */
const GOOGLE_MAPS_HOSTS = /(^|\.)(maps\.googleapis\.com|tile\.googleapis\.com|khms\d*\.google\.com|streetviewpixels[^/]*\.google\.com|maps\.google\.[a-z.]+|earth\.google\.com)$/i;

/** True when a URL points at Google Maps Platform content. Malformed URLs are not Google. */
export function isGoogleMapsUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (GOOGLE_MAPS_HOSTS.test(u.hostname)) return true;
    // www.google.com/maps/... and /streetview.
    return /(^|\.)google\.[a-z.]+$/i.test(u.hostname) && /^\/(maps|streetview)\b/.test(u.pathname);
  } catch {
    return false;
  }
}

/** Gates a list of sources. Use `gateSite` to also check what the evidence references. */
export function gateSources(sources: ReadonlyArray<SourceRef>, opts: LicenceGateOptions): LicenceGateResult {
  const refused: LicenceFinding[] = [];
  const warnings: LicenceFinding[] = [];
  const attributions = new Set<string>();

  const flag = (f: LicenceFinding, hard: boolean): void => { (hard ? refused : warnings).push(f); };

  for (const s of sources) {
    if (s.licence === 'google-maps-content') {
      flag({ sourceId: s.id, licence: s.licence, reason: 'Google Maps content may not be used to create design content (Maps Platform Terms 3.2.3(c)); local comparison only' }, opts.commercial);
    } else if (s.licence === 'unknown') {
      flag({ sourceId: s.id, licence: s.licence, reason: 'no licence is recorded for this input' }, opts.commercial);
    } else if (isGoogleMapsUrl(s.url)) {
      // A hard refusal in EVERY run: the declared licence is wrong, so nothing else about the source can be trusted.
      refused.push({ sourceId: s.id, licence: s.licence, reason: `URL ${s.url} is Google Maps content but the source declares ${s.licence}` });
    }
    if (s.licence === 'cc-by-sa' && (s.kind === 'mesh' || s.kind === 'lidar')) {
      flag({ sourceId: s.id, licence: s.licence, reason: 'share-alike 3D geometry would ship inside the design; share-alike is allowed for photo/drawing/measurement use only' }, opts.commercial);
    }
    if (NEEDS_ATTRIBUTION.has(s.licence)) {
      const a = s.attribution?.trim();
      if (!a) flag({ sourceId: s.id, licence: s.licence, reason: `${s.licence} requires an attribution and none is recorded` }, true);
      else attributions.add(a);
    } else if (s.attribution?.trim()) {
      attributions.add(s.attribution.trim());
    }
  }
  return { ok: refused.length === 0, refused, warnings, attributions: [...attributions].sort() };
}

/** Gates a whole `SiteEvidence`: its sources plus every source id its evidence refers to. */
export function gateSite(site: SiteEvidence, opts: LicenceGateOptions): LicenceGateResult {
  const result = gateSources(site.sources, opts);
  const known = new Set(site.sources.map(s => s.id));
  const unresolved = new Set<string>();
  for (const a of site.annotations) if (!known.has(a.source)) unresolved.add(a.source);
  if (site.mesh && !known.has(site.mesh.source)) unresolved.add(site.mesh.source);
  // Measurement sources may be free text only when they name a SourceRef; anything else is unattributed.
  for (const m of site.measurements) if (!known.has(m.source)) unresolved.add(m.source);
  for (const id of unresolved) {
    result.refused.push({ sourceId: id, licence: 'unresolved', reason: 'evidence cites a source id that has no SourceRef (and so no licence)' });
  }
  const hasGeometry = site.footprint.length > 0 || site.mesh !== undefined;
  if (hasGeometry && site.sources.length === 0) {
    result.refused.push({ sourceId: '(none)', licence: 'unresolved', reason: 'the site has geometry but records no sources' });
  }
  result.ok = result.refused.length === 0;
  return result;
}

/** Thrown by `assertSiteLicences`; carries every finding. */
export class LicenceGateError extends Error {
  constructor(readonly findings: LicenceFinding[]) {
    super(`licence gate refused ${findings.length} input(s): ${findings.map(f => `${f.sourceId} [${f.licence}] ${f.reason}`).join('; ')}`);
    this.name = 'LicenceGateError';
  }
}

/** Gate-or-throw form used by the pipeline entry points. */
export function assertSiteLicences(site: SiteEvidence, opts: LicenceGateOptions): LicenceGateResult {
  const r = gateSite(site, opts);
  if (!r.ok) throw new LicenceGateError(r.refused);
  return r;
}
