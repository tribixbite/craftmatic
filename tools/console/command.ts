/**
 * Turn an inventory entry + a selection + option values into the real argv.
 *
 * Pure: no spawning, no filesystem. Listing files that a one-process batch
 * needs (`{itemsFile}`) are returned as `files` for the runner to write. The
 * `display` string is the command as an operator would type it, so the UI
 * teaches the CLI instead of hiding it.
 */
import type { ArgToken, Operation, OperationOption, SelectionItem } from './types.ts';

export type OptionValues = Record<string, string | number | boolean | undefined>;

export interface BuiltCommand {
  program: string;
  argv: string[];          // argv[0] is the program
  env: Record<string, string>;
  files: { path: string; content: string }[];
  display: string;
  /** Paths under the run dir the command was told to write to. */
  runDirPaths: string[];
}

export interface BuildContext {
  /** Absolute run directory, forward slashes. */
  runDir: string;
}

const PROGRAM: Record<Operation['runtime'], string> = { bun: 'bun', node: 'node', python: 'python', bash: 'bash' };

/** Where an operation runs from. */
export const cwdFor = (op: Operation, roots: { craftmatic: string; clego: string }): string => roots[op.cwd];

/** The argument a single item contributes for this operation's input kind. */
export function itemArg(op: Operation, item: SelectionItem): string | null {
  switch (op.input) {
    case 'model': return item.model ?? item.pack ?? null;
    case 'pack': return item.pack ?? (item.model && /\.mcaddon$/i.test(item.model) ? item.model : null);
    case 'set': {
      if (!item.set) return null;
      return op.setRevision && !/-\d+$/.test(item.set) ? `${item.set}-1` : item.set;
    }
    case 'index-path': return item.indexPath ?? null;
    case 'none': return null;
  }
}

/** Why an item cannot feed this operation, or null when it can. */
export function itemProblem(op: Operation, item: SelectionItem): string | null {
  const arg = itemArg(op, item);
  if (op.input === 'none') return null;
  if (arg === null) return `item has no ${op.input} (source: ${item.label ?? item.id})`;
  if (op.input === 'model' && op.accepts) {
    const ext = (arg.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    if (!op.accepts.includes(ext)) return `.${ext || '?'} not accepted (script reads ${op.accepts.map(e => '.' + e).join(', ')})`;
  }
  return null;
}

/** True when an option that ignores the selection is switched on. */
export const selectionIgnored = (op: Operation, values: OptionValues): boolean =>
  op.options.some(o => o.ignoresSelection && isOn(o, values[o.key] ?? o.default));

const isOn = (o: OperationOption, v: unknown): boolean => o.type === 'boolean' ? v === true || v === 'true' : v !== undefined && v !== '' && v !== null;

/** Resolve an option's value (explicit, else default) with `{runDir}` substituted. */
function optionValue(o: OperationOption, values: OptionValues, ctx: BuildContext): string | boolean | undefined {
  const raw = values[o.key] !== undefined && values[o.key] !== '' ? values[o.key] : o.default;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (o.type === 'boolean') return raw === true || raw === 'true';
  return String(raw).replace(/\{runDir\}/g, ctx.runDir);
}

function renderOption(o: OperationOption, values: OptionValues, ctx: BuildContext, out: BuiltCommand): void {
  const v = optionValue(o, values, ctx);
  if (v === undefined || v === false) {
    if (o.required) throw new Error(`option "${o.key}" is required (${o.help})`);
    return;
  }
  const s = String(v);
  if (o.render !== 'env' && s.includes(ctx.runDir)) out.runDirPaths.push(s);
  switch (o.render) {
    case 'switch': if (v === true) out.argv.push(`--${o.flag}`); break;
    case 'eq': out.argv.push(`--${o.flag}=${s}`); break;
    case 'space': out.argv.push(`--${o.flag}`, s); break;
    case 'positional': out.argv.push(s); break;
    case 'env': out.env[o.flag] = s; break;
    case 'repeat': for (const part of s.split(';').map(p => p.trim()).filter(Boolean)) out.argv.push(`--${o.flag}=${part}`); break;
    case 'list': out.argv.push(`--${o.flag}`, ...s.split(/\s+/).filter(Boolean)); break;
  }
}

/**
 * Build the command for one job: `items` is one item in per-item mode, the
 * whole selection in one-process mode (possibly empty when an option ignores it).
 */
export function buildCommand(op: Operation, items: readonly SelectionItem[], values: OptionValues, ctx: BuildContext): BuiltCommand {
  const out: BuiltCommand = { program: PROGRAM[op.runtime], argv: [PROGRAM[op.runtime], op.entry], env: {}, files: [], display: '', runDirPaths: [] };
  const byKey = new Map(op.options.map(o => [o.key, o]));
  const args = items.map(i => itemArg(op, i)).filter((a): a is string => a !== null);
  for (const token of op.args as readonly ArgToken[]) {
    if (typeof token === 'string') { out.argv.push(token); continue; }
    if ('item' in token) {
      if (op.batch === 'per-item' && items.length !== 1) throw new Error(`${op.id}: per-item operation built with ${items.length} items`);
      const a = args[0];
      if (a === undefined) throw new Error(`${op.id}: the item has no ${op.input}`);
      out.argv.push(a);
      continue;
    }
    if ('items' in token) {
      if (token.items === 'args') out.argv.push(...args);
      else out.argv.push(args.join(','));
      continue;
    }
    if ('itemsFile' in token) {
      const path = `${ctx.runDir}/items.txt`;
      out.files.push({ path, content: args.join('\n') + (args.length ? '\n' : '') });
      out.argv.push(path);
      out.runDirPaths.push(path);
      continue;
    }
    if ('runDir' in token) {
      const p = `${ctx.runDir}/${token.runDir}`;
      out.argv.push(p);
      out.runDirPaths.push(p);
      continue;
    }
    const o = byKey.get(token.opt);
    if (!o) throw new Error(`${op.id}: args reference unknown option "${token.opt}"`);
    renderOption(o, values, ctx, out);
  }
  // Options with no token in `args` (env vars) still render.
  for (const o of op.options) if (o.render === 'env' && !op.args.some(t => typeof t === 'object' && 'opt' in t && t.opt === o.key)) renderOption(o, values, ctx, out);
  out.display = displayCommand(out);
  return out;
}

/** Quote for a human: double quotes when the arg has spaces or shell characters. */
export const shellQuote = (a: string): string => (/[\s"'&|<>()^;$`]/.test(a) || a === '' ? `"${a.replace(/"/g, '\\"')}"` : a);

export function displayCommand(c: Pick<BuiltCommand, 'argv' | 'env'>): string {
  const env = Object.entries(c.env).map(([k, v]) => `${k}=${shellQuote(v)} `).join('');
  return env + c.argv.map(shellQuote).join(' ');
}

/** Validate a whole request before any job is created. Returns a list of problems (empty = ok). */
export function validateRequest(op: Operation, items: readonly SelectionItem[], values: OptionValues, confirm?: string): string[] {
  const problems: string[] = [];
  if (op.input !== 'none' && items.length === 0 && !selectionIgnored(op, values)) problems.push('select at least one item for this operation');
  if (op.danger && confirm !== op.id) problems.push(`"${op.title}" is outward/destructive — confirm by sending its id (${op.id})`);
  for (const o of op.options) {
    const v = values[o.key];
    if (v === undefined || v === '') continue;
    if (o.type === 'enum' && o.values && !o.values.includes(String(v))) problems.push(`option "${o.key}" must be one of ${o.values.join('|')}`);
    if (o.type === 'number' && Number.isNaN(Number(v))) problems.push(`option "${o.key}" must be a number`);
  }
  for (const o of op.options) if (o.required && (values[o.key] === undefined || values[o.key] === '') && (o.default === undefined || o.default === '')) problems.push(`option "${o.key}" is required`);
  return problems;
}

/** Dot-path lookup used by result columns (`a.b.0.c`, `arr.length`). */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (part === 'length' && Array.isArray(cur)) return cur.length;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** The last JSON object printed on stdout (pretty-printed over many lines or one line). */
export function parseJsonLast(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    if (/^\s*[{[]/.test(line)) starts.push(offset);
    offset += line.length + 1;
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    const text = stdout.slice(starts[i]!).trim();
    // Try the whole tail first, then cut at the last closing brace.
    for (const candidate of [text, text.slice(0, Math.max(text.lastIndexOf('}'), text.lastIndexOf(']')) + 1)]) {
      try {
        const v = JSON.parse(candidate) as unknown;
        if (v && typeof v === 'object') return v as Record<string, unknown>;
      } catch { /* not this start */ }
    }
  }
  return null;
}

/** Every line matching the pattern → one row of named groups. */
export function parseRegexLines(stdout: string, pattern: string, groups: readonly string[]): Record<string, string>[] {
  const re = new RegExp(pattern, 'gm');
  const rows: Record<string, string>[] = [];
  for (const m of stdout.matchAll(re)) {
    const row: Record<string, string> = {};
    for (const g of groups) row[g] = m.groups?.[g] ?? '';
    rows.push(row);
  }
  return rows;
}
