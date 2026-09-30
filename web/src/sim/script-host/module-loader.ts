/**
 * Loads a behaviour pack's scripts the way the game does: the manifest's
 * entry module, its imports in order (each module evaluated once), ALL in one
 * context - so two runtimes that write the same action bar, or read each
 * other's entities, meet exactly as on the device.
 *
 * The scripts are ES modules; they are evaluated as functions after a small,
 * exact rewrite of their `import` / `export` statements (the generated packs
 * use the named, namespace, default and side-effect forms, one statement per
 * line). Each module gets `//# sourceURL=pack://<pack>/<path>` so every stack
 * trace names the script - how the timeline attributes a call to its source.
 *
 * Globals a script sees are the real ones EXCEPT `Math` (a seeded `random`),
 * `Date` (the engine's clock) and `console` (captured to the timeline): the
 * same pack run twice gives the same trace.
 */

import type { Pack } from '../pack/pack.js';
import { packText } from '../pack/pack.js';

/** What a module sees besides its own code. */
export interface ModuleGlobals {
  /** A built-in module (`@minecraft/server`), or undefined when the game has no such module. */
  builtin(name: string): Record<string, unknown> | undefined;
  Math: Math;
  Date: DateConstructor;
  console: Pick<Console, 'log' | 'warn' | 'error' | 'info' | 'debug'>;
  /** A module threw while evaluating (the game logs it; the other modules still load). */
  onError(path: string, error: unknown): void;
}

interface Rewritten { body: string; imports: Array<{ from: string; bind?: string; kind: 'named' | 'namespace' | 'default' | 'side' }> }

const IMPORT_RE = /^\s*import\s+(?:(\*\s+as\s+(\w+))|(\{[^}]*\})|(\w+)(?:\s*,\s*(\{[^}]*\}))?)?\s*(?:from\s*)?["']([^"']+)["']\s*;?\s*$/;

/** Rewrite a module's import/export statements into plain function-body code. */
export function rewriteModule(source: string): Rewritten {
  const imports: Rewritten['imports'] = [];
  const exported: string[] = [];
  const lines = source.split('\n').map(line => {
    const m = IMPORT_RE.exec(line);
    if (m && /^\s*import\b/.test(line)) {
      const from = m[6]!;
      if (m[2]) { imports.push({ from, bind: `const ${m[2]} = __import(${JSON.stringify(from)});`, kind: 'namespace' }); return ''; }
      if (m[3] || m[5]) {
        const names = (m[3] ?? m[5])!.replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean).map(s => s.replace(/\s+as\s+/, ': '));
        imports.push({ from, bind: `const { ${names.join(', ')} } = __import(${JSON.stringify(from)});`, kind: 'named' });
      }
      if (m[4]) imports.push({ from, bind: `const ${m[4]} = __import(${JSON.stringify(from)}).default;`, kind: 'default' });
      if (!m[3] && !m[4] && !m[2]) imports.push({ from, kind: 'side' });
      return '';
    }
    const decl = /^(\s*)export\s+(default\s+)?((?:async\s+)?function\*?\s+(\w+)|(?:const|let|var|class)\s+(\w+))/.exec(line);
    if (decl) { const name = decl[4] ?? decl[5]!; exported.push(decl[2] ? `default:${name}` : name); return line.replace(/export\s+(default\s+)?/, ''); }
    // `export default <expression>` (a module whose default export is a value, `export default {};`): the value is
    // the module's `default`, evaluated where the statement stands (an expression may run on over later lines).
    const defaultExpr = /^(\s*)export\s+default\s+(?!(?:async\s+)?function\b|class\b)/.exec(line);
    if (defaultExpr) return line.replace(/export\s+default\s+/, '__exports["default"] = ');
    const list = /^\s*export\s*\{([^}]*)\}\s*;?\s*$/.exec(line);
    if (list) {
      for (const part of list[1]!.split(',').map(s => s.trim()).filter(Boolean)) {
        const [local, as] = part.split(/\s+as\s+/);
        exported.push(as ? `${as}:${local}` : local!);
      }
      return '';
    }
    return line;
  });
  const exportLines = exported.map(e => { const [name, local] = e.includes(':') ? e.split(':') : [e, e]; return `__exports[${JSON.stringify(name)}] = ${local};`; });
  const binds = imports.map(i => i.kind === 'side' ? `__import(${JSON.stringify(i.from)});` : i.bind!).join('\n');
  return { body: `${binds}\n${lines.join('\n')}\n${exportLines.join('\n')}`, imports };
}

/** Resolve a relative import against the importing module's path. */
function resolvePath(from: string, spec: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}

/** Loads the scripts of one behaviour pack into one shared context. */
export class ModuleLoader {
  private readonly cache = new Map<string, Record<string, unknown>>();
  /** Modules in the order they finished evaluating. */
  readonly evaluated: string[] = [];

  constructor(private readonly pack: Pack, private readonly globals: ModuleGlobals) {}

  /** Evaluate the pack's entry module (and, through it, every module it imports). */
  loadEntry(): void {
    if (!this.pack.scriptEntry) return;
    this.load(this.pack.scriptEntry);
  }

  /** Evaluate one module (once) and return its exports. */
  load(path: string): Record<string, unknown> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const exports: Record<string, unknown> = {};
    this.cache.set(path, exports);
    const source = packText(this.pack, path);
    if (source === undefined) { this.globals.onError(path, new Error(`module ${path} not found in the pack`)); return exports; }
    const { body } = rewriteModule(source);
    const g = this.globals;
    const importer = (spec: string): Record<string, unknown> => {
      if (spec.startsWith('.')) return this.load(resolvePath(path, spec));
      const b = g.builtin(spec);
      if (!b) throw new Error(`Cannot find module '${spec}'`);
      return b;
    };
    const url = `pack://${this.pack.folder || 'pack'}/${path}`;
    try {
      const fn = new Function('__import', '__exports', 'Math', 'Date', 'console', `${body}\n//# sourceURL=${url}`) as (i: typeof importer, e: Record<string, unknown>, m: Math, d: DateConstructor, c: ModuleGlobals['console']) => void;
      fn(importer, exports, g.Math, g.Date, g.console);
    } catch (e) { g.onError(path, e); }
    this.evaluated.push(path);
    return exports;
  }
}

/** A seeded `Math`: the real one with a deterministic `random` (mulberry32). */
export function seededMath(seed: number): Math {
  let a = seed >>> 0;
  const random = (): number => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const m = Object.create(Math) as Math;
  Object.defineProperty(m, 'random', { value: random });
  return m;
}

/** A `Date` whose `now()` (and `new Date()`) is the engine's clock. */
export function engineDate(nowMs: () => number): DateConstructor {
  const Real = Date;
  const D = function (this: unknown, ...args: unknown[]): Date | string {
    if (!(this instanceof D)) return new Real(nowMs()).toString();
    return args.length ? new (Real as unknown as new (...a: unknown[]) => Date)(...args) : new Real(nowMs());
  } as unknown as DateConstructor;
  Object.setPrototypeOf(D, Real);
  (D as unknown as { prototype: Date }).prototype = Real.prototype;
  Object.defineProperty(D, 'now', { value: () => nowMs() });
  return D;
}
