/**
 * The inventory is data, so its shape is tested: every entry point exists on
 * disk, every flag an operation declares is spelled somewhere in the script it
 * names (the "never invent a flag" rule, mechanically), every `{opt}` token
 * has its option, every regex compiles.
 *
 *   bunx vitest run --root tools/console
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPERATIONS, STALE, GROUPS, CLEGO_ROOT } from './inventory.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const roots = { craftmatic: REPO, clego: CLEGO_ROOT };

describe('inventory shape', () => {
  it('has unique operation ids and option keys', () => {
    const ids = OPERATIONS.map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of OPERATIONS) {
      const keys = op.options.map(o => o.key);
      expect(new Set(keys).size, op.id).toBe(keys.length);
    }
  });

  it('every {opt} token names a declared option, and every non-env option is referenced', () => {
    for (const op of OPERATIONS) {
      const keys = new Set(op.options.map(o => o.key));
      const referenced = new Set<string>();
      for (const t of op.args) if (typeof t === 'object' && 'opt' in t) { expect(keys.has(t.opt), `${op.id}: {opt:${t.opt}}`).toBe(true); referenced.add(t.opt); }
      for (const o of op.options) if (o.render !== 'env') expect(referenced.has(o.key), `${op.id}: option ${o.key} never rendered`).toBe(true);
    }
  });

  it('per-item operations take exactly one {item}; one-process ones never do', () => {
    for (const op of OPERATIONS) {
      const itemTokens = op.args.filter(t => typeof t === 'object' && 'item' in t).length;
      const itemsTokens = op.args.filter(t => typeof t === 'object' && ('items' in t || 'itemsFile' in t)).length;
      if (op.batch === 'per-item' && op.input !== 'none') expect(itemTokens, op.id).toBe(1);
      if (op.batch === 'one-process') expect(itemTokens, op.id).toBe(0);
      if (op.input === 'none') expect(itemTokens + itemsTokens, op.id).toBe(0);
    }
  });

  it('every entry point exists on disk', () => {
    for (const op of OPERATIONS) expect(existsSync(resolve(roots[op.cwd], op.entry)), `${op.id}: ${op.entry}`).toBe(true);
  });

  it('every declared flag is spelled in the script it belongs to (no invented flags)', () => {
    for (const op of OPERATIONS) {
      const src = readFileSync(resolve(roots[op.cwd], op.entry), 'utf8');
      for (const o of op.options) {
        if (o.render === 'positional' || o.render === 'env') continue;
        // `--flag` spelled out, or read through the `flag('name')` helper the bun scripts share.
        const spelled = src.includes(`--${o.flag}`) || src.includes(`flag('${o.flag}')`) || src.includes(`flag("${o.flag}")`);
        expect(spelled, `${op.id}: --${o.flag} not found in ${op.entry}`).toBe(true);
      }
      for (const t of op.args) if (typeof t === 'string' && t.startsWith('--')) expect(src.includes(t), `${op.id}: literal ${t} not found in ${op.entry}`).toBe(true);
      // An env option is read by the script itself, or by a tool it invokes (adb honours ANDROID_SERIAL).
      for (const o of op.options) if (o.render === 'env') expect(src.includes(o.flag) || (o.flag === 'ANDROID_SERIAL' && src.includes('adb ')), `${op.id}: env ${o.flag} not read by ${op.entry}`).toBe(true);
    }
  });

  it('enum defaults are members, regexes compile, columns have paths', () => {
    for (const op of OPERATIONS) {
      for (const o of op.options) if (o.type === 'enum' && o.default !== undefined) expect(o.values, op.id).toContain(String(o.default));
      if (op.parse.kind === 'regex-lines') {
        expect(() => new RegExp(op.parse.kind === 'regex-lines' ? op.parse.pattern : '', 'gm')).not.toThrow();
        for (const g of op.parse.groups) expect(op.parse.pattern.includes(`(?<${g}>`), `${op.id}: group ${g}`).toBe(true);
      }
      for (const c of op.columns) expect(c.path.length, `${op.id}: column ${c.key}`).toBeGreaterThan(0);
      expect(GROUPS).toContain(op.group);
    }
  });

  it('a danger dry-run option is a boolean that defaults to on', () => {
    for (const op of OPERATIONS) {
      if (!op.danger?.dryRunOption) continue;
      const o = op.options.find(x => x.key === op.danger!.dryRunOption);
      expect(o?.type, op.id).toBe('boolean');
      expect(o?.default, op.id).toBe(true);
    }
  });

  it('lists the stale families with a reason each', () => {
    expect(STALE.length).toBeGreaterThan(5);
    for (const s of STALE) { expect(s.pattern.length).toBeGreaterThan(3); expect(s.why.length).toBeGreaterThan(10); }
  });
});
