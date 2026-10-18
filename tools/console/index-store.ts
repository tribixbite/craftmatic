/**
 * The model index (`web/public/lego-models-index.json`, schema 2) flattened to
 * one row per model entry, plus the filter the selection panel applies.
 *
 * Filtering is pure and synchronous so it can be unit-tested and so the SAME
 * filter object that produced a selection can be stored with a run and replayed.
 */
import { readFileSync } from 'node:fs';
import type { IndexFilter, IndexRow, SelectionItem } from './types.ts';
import { CORPUS_ROOT } from './inventory.ts';

interface RawModel {
  src: string; path: string; tier: number; steps: number; n: number; hash?: string;
  asm?: 'verified' | 'defective'; sev?: number; defects?: string[]; variant?: string; conv?: number; lineage?: string;
}
interface RawSet { name: string; year: string | number; parts: number; models: RawModel[] }
export interface RawIndex { generated: string; schema: number; sets: Record<string, RawSet> }

/** Flatten the raw index into rows (the set number is repeated per entry). */
export function flattenIndex(raw: RawIndex): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const [set, entry] of Object.entries(raw.sets)) {
    entry.models.forEach((m, rank) => {
      rows.push({
        set,
        name: entry.name,
        year: Number(entry.year) || 0,
        parts: Number(entry.parts) || 0,
        src: m.src,
        path: m.path,
        tier: m.tier,
        steps: m.steps,
        n: m.n,
        hash: m.hash ?? '',
        asm: m.asm ?? 'unverified',
        sev: typeof m.sev === 'number' ? m.sev : 0,
        defects: m.defects ?? [],
        variant: m.variant ?? null,
        conv: m.conv === 1,
        rank,
      });
    });
  }
  return rows;
}

export function loadIndex(path: string): { rows: IndexRow[]; generated: string } {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as RawIndex;
  return { rows: flattenIndex(raw), generated: raw.generated };
}

/** Parse "71043, 10294 710" into tokens; a token without a full match is a prefix. */
export const parseSetTokens = (s: string | undefined): string[] =>
  (s ?? '').split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);

const num = (v: number | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Apply a filter. Every clause is AND-ed; an unset clause matches everything. */
export function applyFilter(rows: readonly IndexRow[], f: IndexFilter): IndexRow[] {
  const setTokens = parseSetTokens(f.sets);
  const name = f.name?.trim().toLowerCase();
  const text = f.text?.trim().toLowerCase();
  const defect = f.hasDefect?.trim().toLowerCase();
  const srcSet = f.src && f.src.length ? new Set(f.src) : null;
  const yearMin = num(f.yearMin), yearMax = num(f.yearMax);
  const partsMin = num(f.partsMin), partsMax = num(f.partsMax);
  const sevMin = num(f.sevMin), sevMax = num(f.sevMax);
  const out: IndexRow[] = [];
  for (const r of rows) {
    if (f.primaryOnly && r.rank !== 0) continue;
    if (setTokens.length && !setTokens.some(t => r.set === t || (t.length < r.set.length && r.set.startsWith(t)))) continue;
    if (name && !r.name.toLowerCase().includes(name)) continue;
    if (yearMin !== undefined && r.year < yearMin) continue;
    if (yearMax !== undefined && r.year > yearMax) continue;
    if (partsMin !== undefined && r.parts < partsMin) continue;
    if (partsMax !== undefined && r.parts > partsMax) continue;
    if (srcSet && !srcSet.has(r.src)) continue;
    if (f.asm && f.asm !== 'any' && r.asm !== f.asm) continue;
    if (sevMin !== undefined && r.sev < sevMin) continue;
    if (sevMax !== undefined && r.sev > sevMax) continue;
    if (f.tier && f.tier !== 'any' && r.tier !== f.tier) continue;
    if (defect && !r.defects.some(d => d.toLowerCase().includes(defect))) continue;
    if (text) {
      const hay = `${r.set} ${r.name} ${r.path} ${r.src} ${r.variant ?? ''} ${r.defects.join(' ')}`.toLowerCase();
      if (!hay.includes(text)) continue;
    }
    out.push(r);
    if (f.limit && out.length >= f.limit) break;
  }
  return out;
}

/** Distinct `src` classes with counts, for the filter UI. */
export function srcClasses(rows: readonly IndexRow[]): { src: string; n: number }[] {
  const c = new Map<string, number>();
  for (const r of rows) c.set(r.src, (c.get(r.src) ?? 0) + 1);
  return [...c].map(([src, n]) => ({ src, n })).sort((a, b) => b.n - a.n);
}

/** Absolute path of an index entry in the local corpus. */
export const corpusPath = (indexPath: string): string => `${CORPUS_ROOT}/${indexPath}`;

/** An index row as a selection item (what every operation consumes). */
export const rowToItem = (r: IndexRow): SelectionItem => ({
  id: r.rank === 0 ? r.set : `${r.set}#${r.rank}`,
  set: r.set,
  indexPath: r.path,
  model: corpusPath(r.path),
  label: `${r.set} ${r.name} (${r.src})`,
});

/**
 * Resolve the items a CSV or text listing names against the index: a row with
 * a `path` column is that entry; a row with only a set number is the set's
 * primary pick; a token that looks like a file path is used as-is.
 */
export function resolveItems(
  rows: readonly IndexRow[],
  records: readonly Record<string, string>[],
): { items: SelectionItem[]; unresolved: string[] } {
  const byPath = new Map(rows.map(r => [r.path.toLowerCase(), r]));
  const primaryBySet = new Map<string, IndexRow>();
  for (const r of rows) if (r.rank === 0) primaryBySet.set(r.set, r);
  const items: SelectionItem[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    const pathCol = rec['path'] ?? rec['file'] ?? rec['model'] ?? '';
    const setCol = rec['set'] ?? rec['set_num'] ?? rec['setNum'] ?? rec['setnum'] ?? '';
    const packCol = rec['pack'] ?? '';
    let item: SelectionItem | null = null;
    if (packCol) item = { id: packCol.replace(/^.*[\\/]/, ''), pack: packCol, label: packCol };
    else if (pathCol) {
      const hit = byPath.get(pathCol.replace(/\\/g, '/').toLowerCase());
      if (hit) item = rowToItem(hit);
      else if (/[\\/]/.test(pathCol) || /\.(io|ldr|mpd|lxf|mcaddon|schem)$/i.test(pathCol)) {
        const abs = /^[A-Za-z]:[\\/]|^\//.test(pathCol) ? pathCol : corpusPath(pathCol);
        item = { id: pathCol.replace(/^.*[\\/]/, ''), model: abs, label: pathCol, ...(setCol ? { set: setCol.replace(/-\d+$/, '') } : {}) };
      }
    }
    if (!item && setCol) {
      const set = setCol.trim().replace(/-\d+$/, '');
      const hit = primaryBySet.get(set);
      item = hit ? rowToItem(hit) : { id: set, set, label: set };
    }
    if (!item) { unresolved.push(JSON.stringify(rec)); continue; }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return { items, unresolved };
}
