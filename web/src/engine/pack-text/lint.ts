/**
 * Forbidden-terms lint for player-facing and listing text (BIZ-55, X-05).
 *
 * A pack that ships to a marketplace must not show a player LEGO marks, set numbers, "minifig", licensed
 * themes, ride-brand names, dev stamps or `craftmatic` ids. This module finds them in plain text (`lintText`)
 * and in the player-facing surfaces of a built pack (`lintPackFiles`): manifests, `.lang` values, README /
 * text files and the prose string literals of scripts. Exemptions are explicit, one per entry, each with a reason.
 */
import { MOJANG_DISCLAIMER } from './notices.js';

/** Where a string is shown; some rules (set numbers, a leading "Minecraft") depend on it. */
export type Surface = 'name' | 'prose' | 'credits';

export interface PackFile {
  /** Path inside the pack set, forward slashes (e.g. `bp/manifest.json`). */
  name: string;
  data: Uint8Array | string;
}

export interface Finding {
  ruleId: string;
  /** The offending text. */
  match: string;
  /** The line (1-based) within the linted text / file. */
  line: number;
  surface: Surface;
  /** The full line the match sits on (exemptions are tested against it). */
  context: string;
  message: string;
  /** Set by `lintPackFiles`. */
  file?: string;
}

/** An explicit, reasoned waiver. It removes findings of `rule` (or every rule with `'*'`) whose line matches `pattern`. */
export interface Exemption {
  id: string;
  rule: string;
  pattern: RegExp | string;
  /** Why this text is allowed; a blank reason is refused. */
  reason: string;
}

export interface LintOptions {
  surface?: Surface;
  exemptions?: readonly Exemption[];
  /** Also flag any `craftmatic` in file paths and non-text files (entity/block ids), for release profiles. */
  checkIds?: boolean;
}

interface Rule {
  id: string;
  re: RegExp;
  message: string;
  /** Restrict to some surfaces; default every surface except credits-exempt rules below. */
  only?: readonly Surface[];
  /** Surfaces on which the rule does not apply. */
  skip?: readonly Surface[];
}

const LICENSED = [
  'harry potter', 'hogwarts', 'gringotts', 'diagon alley', 'star wars', 'x-wing', 'millennium falcon', 'jedi',
  'marvel', 'avengers', 'batman', 'spider-man', 'disney', 'pixar', 'mickey mouse', 'pokemon', 'nintendo', 'mario',
  'jurassic', 'ferrari', 'lamborghini', 'mclaren', 'porsche', 'mercedes', 'bmw', 'bugatti', 'koenigsegg',
  'aston martin', 'chevrolet', 'volkswagen', 'toyota', 'audi', 'ford',
];
const RIDE_BRANDS = ['space mountain', 'seven dwarfs', 'speed racer', 'six flags', 'big thunder', 'splash mountain', 'disneyland'];
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (list: readonly string[]): RegExp => new RegExp(`\\b(?:${list.map(esc).join('|')})\\b`, 'gi');

/** The rule table. Order is the report order. */
export const RULES: readonly Rule[] = [
  { id: 'lego-mark', re: /\b(?:legos?|legoland|duplo|bionicle|ninjago|brickheadz|bricklink|technic|studio)\b/gi, message: 'a trademark or tool name' },
  { id: 'minifig', re: /\bmini-?fig(?:ure)?s?\b/gi, message: 'say "figure"' },
  // A name is judged on any 4-6 digit run; prose only on the dashed set-number shape or 5-6 digits (years stay legal).
  { id: 'set-number', re: /\b\d{4,6}(?:-\d)?\b/g, message: 'a set number in a name', only: ['name'] },
  { id: 'set-number', re: /\b(?:\d{4,6}-\d|\d{5,6})\b/g, message: 'a set number', only: ['prose'] },
  { id: 'licensed-theme', re: words(LICENSED), message: 'a licensed theme or brand name' },
  { id: 'ride-brand', re: words(RIDE_BRANDS), message: 'a ride-brand name' },
  {
    id: 'dev-stamp',
    re: new RegExp([
      String.raw`\(\d{4}-\d{2}-\d{2} [0-9a-f]{6,12}(?:\+dirty)?\)`, // pipelineStampText: "(date commit[+dirty])"
      String.raw`\((?:unstamped|hash [0-9a-f]{12})\)`,
      String.raw`\bpipeline (?:unstamped|[0-9a-f]{8,})`,           // provenanceSentence
      String.raw`\+dirty\b`,
      String.raw`\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b`, // a bare hash with digits and letters
    ].join('|'), 'g'),
    message: 'a developer build stamp',
  },
  { id: 'craftmatic', re: /craftmatic/gi, message: 'the working name must not reach players', skip: ['credits'] },
  // "Minecraft" leads a name, or sits somewhere other than after for/in/on/to/with/official/and: not a secondary position.
  { id: 'minecraft', re: /\bminecraft\b/gi, message: 'Minecraft only in a secondary or disclaimer position' },
];

const SECONDARY_BEFORE = /(?:\b(?:for|in|on|to|with|and|official)|["'(]?\bnot an official)\s+$/i;

/** Validates exemptions; a blank reason is a programming error. */
function checkExemptions(list: readonly Exemption[]): void {
  for (const e of list) {
    if (!e.reason.trim()) throw new Error(`exemption "${e.id}" needs a reason`);
  }
}

const exempt = (f: Finding, list: readonly Exemption[]): boolean =>
  list.some(e => (e.rule === '*' || e.rule === f.ruleId)
    && (typeof e.pattern === 'string' ? f.context.includes(e.pattern) : new RegExp(e.pattern.source, e.pattern.flags.replace('g', '')).test(f.context)));

/** The built-in waiver: the Mojang disclaimer line is the one place "Minecraft" must appear in full capitals. */
export const DISCLAIMER_EXEMPTION: Exemption = {
  id: 'mojang-disclaimer', rule: 'minecraft', pattern: MOJANG_DISCLAIMER,
  reason: 'the verbatim Mojang disclaimer is required on every pack and listing',
};

/** Lint one piece of text. `line` numbers count from 1 within `text`. */
export function lintText(text: string, opts: LintOptions = {}): Finding[] {
  const surface = opts.surface ?? 'prose';
  const exemptions = [DISCLAIMER_EXEMPTION, ...(opts.exemptions ?? [])];
  checkExemptions(exemptions);
  const out: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((context, i) => {
    for (const rule of RULES) {
      if (rule.only && !rule.only.includes(surface)) continue;
      if (rule.skip?.includes(surface)) continue;
      for (const m of context.matchAll(new RegExp(rule.re.source, rule.re.flags))) {
        if (rule.id === 'minecraft' && !isLeadingMinecraft(context, m.index ?? 0, surface)) continue;
        const f: Finding = { ruleId: rule.id, match: m[0], line: i + 1, surface, context, message: `${rule.message}: "${m[0]}"` };
        if (!exempt(f, exemptions)) out.push(f);
      }
    }
  });
  return out;
}

/** True when this "Minecraft" is not in a secondary position. */
function isLeadingMinecraft(line: string, at: number, surface: Surface): boolean {
  const before = line.slice(0, at);
  if (surface === 'name' && !before.trim()) return true;
  if (!before.trim()) return true; // first word of a line / sentence
  if (/[.!?]\s+$/.test(before)) return true; // starts a sentence
  return !SECONDARY_BEFORE.test(before);
}

const decode = (d: Uint8Array | string): string => (typeof d === 'string' ? d : new TextDecoder().decode(d));
const isCredits = (name: string): boolean => /(?:^|\/)credits[^/]*\.(?:txt|md)$/i.test(name);

/**
 * String literals of a script, skipping comments. Template literals keep their text with each `${...}` collapsed
 * to `${}`. TODO: a backtick inside a `${...}` expression is not understood; no emitted script does that today.
 */
export function extractStringLiterals(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const start = line;
      let text = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { text += src[i + 1] ?? ''; if (src[i + 1] === '\n') line++; i += 2; continue; }
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          let depth = 1; i += 2;
          while (i < src.length && depth) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; if (src[i] === '\n') line++; i++; }
          text += '${}'; continue;
        }
        if (src[i] === '\n') { if (c !== '`') break; line++; }
        text += src[i]; i++;
      }
      i++;
      out.push({ text, line: start });
      continue;
    }
    i++;
  }
  return out;
}

/** The player-visible text units of one file: [text, surface, first line]. */
function surfacesOf(f: PackFile): { text: string; surface: Surface; line: number }[] {
  const name = f.name.toLowerCase();
  const body = decode(f.data);
  if (name.endsWith('manifest.json')) {
    try {
      const m = JSON.parse(body) as { header?: { name?: string; description?: string }; modules?: { description?: string }[]; metadata?: { authors?: string[] } };
      const units: { text: string; surface: Surface; line: number }[] = [];
      if (m.header?.name) units.push({ text: m.header.name, surface: 'name', line: 1 });
      if (m.header?.description) units.push({ text: m.header.description, surface: 'prose', line: 1 });
      for (const mod of m.modules ?? []) if (mod.description) units.push({ text: mod.description, surface: 'prose', line: 1 });
      for (const a of m.metadata?.authors ?? []) units.push({ text: a, surface: 'prose', line: 1 });
      return units;
    } catch { return [{ text: body, surface: 'prose', line: 1 }]; }
  }
  if (name.endsWith('.lang')) {
    const units: { text: string; surface: Surface; line: number }[] = [];
    body.split('\n').forEach((raw, i) => {
      if (!raw.trim() || raw.trimStart().startsWith('#')) return;
      const eq = raw.indexOf('=');
      if (eq < 0) return;
      const key = raw.slice(0, eq);
      units.push({ text: raw.slice(eq + 1), surface: /\.name$|^pack\.name$/.test(key) ? 'name' : 'prose', line: i + 1 });
    });
    return units;
  }
  if (isCredits(f.name)) return [{ text: body, surface: 'credits', line: 1 }];
  if (/\.(?:txt|md)$/.test(name)) return [{ text: body, surface: 'prose', line: 1 }];
  if (name.endsWith('.js')) {
    // Only prose literals (a space and a letter) are player text; identifiers like 'tst:car' are not.
    return extractStringLiterals(body)
      .filter(l => /\s/.test(l.text.trim()) && /[a-z]/i.test(l.text))
      .map(l => ({ text: l.text, surface: 'prose' as Surface, line: l.line }));
  }
  return [];
}

/**
 * Lint the player-facing surfaces of a built pack. Findings carry `file`; `line` is the line within the file for
 * text, scripts and `.lang`, and 1 for manifest fields.
 */
export function lintPackFiles(files: readonly PackFile[], opts: LintOptions = {}): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    for (const unit of surfacesOf(f)) {
      for (const hit of lintText(unit.text, { ...opts, surface: unit.surface })) {
        out.push({ ...hit, file: f.name, line: unit.line + hit.line - 1 });
      }
    }
    if (opts.checkIds && !isCredits(f.name)) out.push(...idFindings(f));
  }
  return out;
}

/** `craftmatic` in a file path, or in any non-credits file the surface pass did not already cover. */
function idFindings(f: PackFile): Finding[] {
  const found: Finding[] = [];
  const consider = (text: string, label: string): void => {
    if (/craftmatic/i.test(text)) found.push({
      ruleId: 'craftmatic', match: 'craftmatic', line: 1, surface: 'prose', context: label, file: f.name,
      message: `a craftmatic id in ${label}`,
    });
  };
  consider(f.name, 'the file path');
  const covered = surfacesOf(f).length > 0;
  if (!covered && /\.(?:json|mcfunction|lang|js|txt|md)$/i.test(f.name)) consider(decode(f.data), 'the file body');
  return found;
}
