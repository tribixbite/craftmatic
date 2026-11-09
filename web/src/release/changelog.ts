/**
 * Curated changelog per product (D-06, BIZ-53; plan D section D-06).
 *
 * `release/changelogs/<product>.md` is the source of truth, in Keep-a-Changelog
 * form. There is deliberately NO commit extraction (business-review.md item 4):
 * a human writes what a player should know. This module parses the file, checks
 * it against the registry, and renders the notes for each channel:
 *  - `renderPackText`   in-pack `CHANGELOG.txt` (plain text, all releases);
 *  - `renderCurseForge` one release as plain lists (the editor's accepted Markdown
 *    subset is read at approval time, so this uses no Markdown at all);
 *  - `renderHtml`       the site (escaped, only `<a>`, `<strong>` and `<code>`).
 * Pure functions over strings: nothing here reads a file or the clock.
 */
import { compareSemVer, formatSemVer, parseSemVer } from './semver.js';

/** One `### Kind` block of a release. */
export interface ChangelogGroup { kind: string; items: string[] }

/** One `## [x.y.z] - date` section. */
export interface ChangelogRelease {
  version: string;
  /** `YYYY-MM-DD` as written; empty when the heading has none. */
  date: string;
  groups: ChangelogGroup[];
}

/** A parsed file: released sections in file order (newest first by convention) plus the unreleased one. */
export interface ChangelogDoc {
  unreleased: { groups: ChangelogGroup[] };
  releases: ChangelogRelease[];
}

const RELEASE_HEADING = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?\s*$/;
const KIND_HEADING = /^###\s+(.+?)\s*$/;
/** Keep-a-Changelog's six kinds; anything else is reported by `checkChangelog`. */
export const CHANGELOG_KINDS: readonly string[] = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

/**
 * Parse a Keep-a-Changelog file. Throws RangeError when a `## [..]` heading is
 * neither `Unreleased` nor a strict semantic version, so a typo cannot pass as a release.
 * List items may continue on indented lines; continuations are joined with a space.
 */
export function parseChangelog(text: string): ChangelogDoc {
  const doc: ChangelogDoc = { unreleased: { groups: [] }, releases: [] };
  let groups: ChangelogGroup[] | null = null;
  let group: ChangelogGroup | null = null;
  for (const line of text.split(/\r?\n/)) {
    const rel = RELEASE_HEADING.exec(line);
    if (rel) {
      group = null;
      if (rel[1]!.toLowerCase() === 'unreleased') { groups = doc.unreleased.groups; continue; }
      const version = formatSemVer(parseSemVer(rel[1]!)); // throws on a non-semver heading
      const release: ChangelogRelease = { version, date: rel[2] ?? '', groups: [] };
      doc.releases.push(release);
      groups = release.groups;
      continue;
    }
    if (/^##\s/.test(line)) { groups = null; group = null; continue; } // a heading we do not model
    if (!groups) continue; // preamble before the first section
    const kind = KIND_HEADING.exec(line);
    if (kind) { group = { kind: kind[1]!, items: [] }; groups.push(group); continue; }
    const item = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (item && group) { group.items.push(item[1]!); continue; }
    if (group && group.items.length > 0 && /^\s{2,}\S/.test(line)) group.items[group.items.length - 1] += ` ${line.trim()}`;
  }
  return doc;
}

/** True for a real calendar date written `YYYY-MM-DD`. */
function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Every problem with a changelog against the registry's released versions
 * (`major.minor.patch` strings). An empty list means the release may proceed.
 * Checks: each registry version has a section; each section is dated, non-empty,
 * unique, uses a known kind, and sections fall newest first. A section for a
 * version the registry does not hold yet is allowed (a release being prepared).
 */
export function checkChangelog(doc: ChangelogDoc, registryVersions: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [i, r] of doc.releases.entries()) {
    if (seen.has(r.version)) out.push(`version ${r.version} appears twice`);
    seen.add(r.version);
    if (!isIsoDate(r.date)) out.push(`version ${r.version}: date ${JSON.stringify(r.date)} is not a YYYY-MM-DD date`);
    if (r.groups.every(g => g.items.length === 0)) out.push(`version ${r.version} has no entries`);
    for (const g of r.groups) {
      if (!CHANGELOG_KINDS.includes(g.kind)) out.push(`version ${r.version}: unknown kind ${JSON.stringify(g.kind)}`);
    }
    const prev = doc.releases[i - 1];
    if (prev && prev.version !== r.version && compareSemVer(parseSemVer(prev.version), parseSemVer(r.version)) < 0) {
      out.push(`version ${r.version} is listed after ${prev.version}: sections must run newest first`);
    }
  }
  for (const v of registryVersions) {
    if (!seen.has(v)) out.push(`registry version ${v} has no curated changelog section`);
  }
  return out;
}

/** Strip inline Markdown to plain text: links keep their label, emphasis and code lose their marks. */
export function inlineToPlain(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/([*_`])(.+?)\1/g, '$2');
}

/** One release as plain lists: a kind line, then `- ` items. No Markdown reaches the editor. */
export function renderCurseForge(r: ChangelogRelease): string {
  const blocks = r.groups.filter(g => g.items.length > 0)
    .map(g => [g.kind, ...g.items.map(i => `- ${inlineToPlain(i)}`)].join('\n'));
  return `${blocks.join('\n\n')}\n`;
}

/** The in-pack `CHANGELOG.txt`: every released section, newest first, unreleased work excluded. */
export function renderPackText(doc: ChangelogDoc): string {
  const sections = doc.releases.map(r => `${r.version} (${r.date})\n\n${renderCurseForge(r)}`);
  return `Changelog\n\n${sections.join('\n')}`;
}

const escapeHtml = (s: string): string => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline Markdown to HTML. Escapes FIRST, so the only tags that can appear are the ones made here. */
function inlineToHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

/** The site's changelog fragment (no `<html>` wrapper): one `<section>` per released version. */
export function renderHtml(doc: ChangelogDoc): string {
  const sections = doc.releases.map(r => {
    const body = r.groups.filter(g => g.items.length > 0)
      .map(g => `<h3>${escapeHtml(g.kind)}</h3>\n<ul>\n${g.items.map(i => `<li>${inlineToHtml(i)}</li>`).join('\n')}\n</ul>`)
      .join('\n');
    return `<section>\n<h2>${r.version} <time datetime="${escapeHtml(r.date)}">${escapeHtml(r.date)}</time></h2>\n${body}\n</section>`;
  });
  return `${sections.join('\n')}\n`;
}
