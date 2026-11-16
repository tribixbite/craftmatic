/**
 * What a built pack CONTAINS, read from the sweep's per-set build report (`<stem>.json`, the stdout of
 * `_playable_ref.ts`): the content half of the favourites gate (PROC-19, generality census 2026-11-16).
 *
 * The gate's simulator steps judge behaviour (child play, vehicles, regressions); none of them sees that a pack drew
 * a part as a box, drew a substituted mould, gave its figures the default face, shipped parts floating clear of the
 * model, or coarsened most of its placements. The 60-set census (`output/gengate-6fa0afa6`) passed its sweep "OK"
 * on every pack with all of those present. This module turns each report into one row and the rows into a report
 * section with totals and the worst packs per measure. It REPORTS only: nothing here fails the gate.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/** The fields of one entity's diagnostics the content section reads (all optional: older reports lack some). */
export interface EntityContentDiag {
  aabbFallbackParts?: Array<{ part: string; count: number; reason?: string }>;
  unresolvedParts?: string[];
  substitutedParts?: Array<{ part: string; alias: string }>;
  defaultFaces?: number;
  faceTextures?: { printed: number; art: number; default: number; atlas?: [number, number] } | null;
  orphans?: { placements?: number; floatingParts?: number; worstClearanceLdu?: number } | null;
  grainPlan?: { requestedMicrocellLdu?: number; requested?: number; placementsAtGrain?: Record<string, number> } | null;
}

/** A build report as the sweep writes it: only what the content section reads. */
export interface BuildReportContent {
  label?: string;
  warnings?: string[];
  entities?: Record<string, EntityContentDiag>;
}

/** One pack's content row. */
export interface PackContentRow {
  stem: string;
  label: string;
  entities: number;
  /** Placements drawn as their bounding box (`aabbFallbackParts`: no geometry, or over the part cuboid cap). */
  boxedPlacements: number;
  /** Distinct parts drawn as boxes. */
  boxedParts: string[];
  /** Distinct parts no library resolved. */
  unresolvedParts: string[];
  /** Distinct parts drawn as an alias (`substitutedParts`): a near mould, an older revision, a plain head. */
  substitutedParts: number;
  /** Of those, how many are heads (a print drawn as another print or as the plain mould changes the face). */
  headSubstitutions: number;
  /** Heads drawn with their own face: an LDraw print or face art. */
  realFaces: number;
  /** Heads drawn with a default face (the textured default plus the plain heads' cuboid face). */
  defaultFaces: number;
  /** Parts floating more than a stud clear of the model (`orphans.floatingParts`, summed over entities). */
  floatingParts: number;
  /** Build warnings about loose / floating source parts. */
  looseWarnings: number;
  /** Share of placements shipped coarser than the requested grain, null when no entity has a grain plan. */
  coarsenedShare: number | null;
}

const HEAD_PART = /^(?:bl_)?(?:3626|28621|92198|92240|28649)(?:[a-z]|$)/i;
const LOOSE_WARNING = /do not touch the rest of the model|float more than a stud|loose in the SOURCE/i;

/**
 * Share of placements shipped away from the requested grain: placements at grains other than the requested one,
 * over all planned placements. The same measure the sweep prints as `coarsened N%`.
 */
export function coarsenedShareOf(entities: Record<string, EntityContentDiag>): number | null {
  let planned = 0, coarsened = 0;
  for (const diag of Object.values(entities)) {
    const plan = diag.grainPlan;
    if (!plan) continue;
    const at = plan.placementsAtGrain ?? {};
    const total = Object.values(at).reduce((s, n) => s + n, 0);
    planned += total;
    coarsened += total - (at[String(plan.requested ?? plan.requestedMicrocellLdu)] ?? 0);
  }
  return planned ? +(coarsened / planned).toFixed(4) : null;
}

/** One pack's row from its build report. */
export function packContent(stem: string, report: BuildReportContent): PackContentRow {
  const entities = report.entities ?? {};
  const boxed = new Set<string>(), unresolved = new Set<string>(), substituted = new Map<string, string>();
  let boxedPlacements = 0, realFaces = 0, defaultFaces = 0, floatingParts = 0;
  for (const d of Object.values(entities)) {
    for (const a of d.aabbFallbackParts ?? []) { boxed.add(a.part); boxedPlacements += a.count; }
    for (const p of d.unresolvedParts ?? []) unresolved.add(p);
    for (const s of d.substitutedParts ?? []) substituted.set(s.part, s.alias);
    defaultFaces += d.defaultFaces ?? 0;
    if (d.faceTextures) { realFaces += d.faceTextures.printed + d.faceTextures.art; defaultFaces += d.faceTextures.default; }
    floatingParts += d.orphans?.floatingParts ?? 0;
  }
  return {
    stem, label: report.label ?? stem, entities: Object.keys(entities).length,
    boxedPlacements, boxedParts: [...boxed].sort(), unresolvedParts: [...unresolved].sort(),
    substitutedParts: substituted.size, headSubstitutions: [...substituted.keys()].filter(p => HEAD_PART.test(p)).length,
    realFaces, defaultFaces, floatingParts,
    looseWarnings: (report.warnings ?? []).filter(w => LOOSE_WARNING.test(w)).length,
    coarsenedShare: coarsenedShareOf(entities),
  };
}

/** Totals over the rows. */
export interface ContentTotals {
  packs: number;
  boxedPlacements: number;
  packsWithBoxes: number;
  unresolvedParts: number;
  substitutedParts: number;
  headSubstitutions: number;
  realFaces: number;
  defaultFaces: number;
  floatingParts: number;
  packsWithLooseWarnings: number;
  /** Packs with more than a tenth of their placements coarsened. */
  packsCoarsened: number;
}

export function contentTotals(rows: readonly PackContentRow[]): ContentTotals {
  const sum = (f: (r: PackContentRow) => number): number => rows.reduce((s, r) => s + f(r), 0);
  return {
    packs: rows.length,
    boxedPlacements: sum(r => r.boxedPlacements),
    packsWithBoxes: rows.filter(r => r.boxedPlacements > 0).length,
    unresolvedParts: new Set(rows.flatMap(r => r.unresolvedParts)).size,
    substitutedParts: sum(r => r.substitutedParts),
    headSubstitutions: sum(r => r.headSubstitutions),
    realFaces: sum(r => r.realFaces),
    defaultFaces: sum(r => r.defaultFaces),
    floatingParts: sum(r => r.floatingParts),
    packsWithLooseWarnings: rows.filter(r => r.looseWarnings > 0).length,
    packsCoarsened: rows.filter(r => (r.coarsenedShare ?? 0) > 0.1).length,
  };
}

/** The measures the section ranks packs by, worst first; a pack scoring 0 is never listed. */
const WORST: ReadonlyArray<[string, (r: PackContentRow) => number, (r: PackContentRow) => string]> = [
  ['boxed placements', r => r.boxedPlacements, r => `${r.boxedPlacements} (${r.boxedParts.join(', ')})`],
  ['unresolved parts', r => r.unresolvedParts.length, r => r.unresolvedParts.join(', ')],
  ['substituted parts', r => r.substitutedParts, r => `${r.substitutedParts} (${r.headSubstitutions} heads)`],
  ['default faces', r => r.defaultFaces, r => `${r.defaultFaces} default, ${r.realFaces} real`],
  ['floating parts', r => r.floatingParts, r => `${r.floatingParts}`],
  ['coarsened share', r => r.coarsenedShare ?? 0, r => `${(100 * (r.coarsenedShare ?? 0)).toFixed(0)} %`],
];

/** The gate report's content section (markdown). */
export function contentSection(rows: readonly PackContentRow[], worst = 5): string {
  const t = contentTotals(rows);
  const heads = t.realFaces + t.defaultFaces;
  const lines = [
    '## content: reported, not judged',
    '',
    `${t.packs} packs. Boxed placements ${t.boxedPlacements} in ${t.packsWithBoxes} packs; unresolved parts ${t.unresolvedParts}; `
      + `substituted parts ${t.substitutedParts} (${t.headSubstitutions} heads); real face ${t.realFaces} of ${heads} heads`
      + `${heads ? ` (${(100 * t.realFaces / heads).toFixed(0)} %)` : ''}; floating parts ${t.floatingParts}, loose-part warnings in `
      + `${t.packsWithLooseWarnings} packs; ${t.packsCoarsened} packs with more than 10 % of placements coarsened.`,
    '',
    '### worst packs',
    '',
  ];
  for (const [name, score, show] of WORST) {
    const top = rows.filter(r => score(r) > 0).sort((a, b) => score(b) - score(a)).slice(0, worst);
    lines.push(`- ${name}: ${top.length ? top.map(r => `${r.stem} ${show(r)}`).join('; ') : 'none'}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Every build report in a sweep directory (`<stem>.json` beside `<stem>.mcaddon`; not the gate's own files). */
export function readBuildReports(dir: string): Array<{ stem: string; report: BuildReportContent }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ stem: string; report: BuildReportContent }> = [];
  for (const f of readdirSync(dir).sort()) {
    const stem = f.replace(/\.json$/, '');
    if (stem === f || !existsSync(`${dir}/${stem}.mcaddon`)) continue;
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    try { out.push({ stem, report: JSON.parse(text.slice(text.indexOf('{'))) as BuildReportContent }); } catch { /* not a build report */ }
  }
  return out;
}
