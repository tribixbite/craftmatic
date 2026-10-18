/**
 * The slice of Molang a block permutation's `condition` uses:
 * `q.block_state('name') == value` joined by `&&` / `||` / `!`, comparisons,
 * parentheses, numbers, strings and booleans. Compiled once per condition to a
 * closure over the state map; anything else is a parse error the block
 * registry reports (and the permutation never matches), never a guess.
 */

import type { BlockStates } from './block-types.js';

type Value = number | string | boolean;
/** A compiled condition: the block's states → the expression's value. */
export type Condition = (states: BlockStates) => Value;

interface Token { kind: 'num' | 'str' | 'id' | 'op' | 'lp' | 'rp' | 'comma'; text: string }

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ kind: 'lp', text: c }); i++; continue; }
    if (c === ')') { out.push({ kind: 'rp', text: c }); i++; continue; }
    if (c === ',') { out.push({ kind: 'comma', text: c }); i++; continue; }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error(`molang: unterminated string in ${src}`);
      out.push({ kind: 'str', text: src.slice(i + 1, end) }); i = end + 1; continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ kind: 'num', text: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][\w.]*/.exec(src.slice(i));
    if (id) { out.push({ kind: 'id', text: id[0] }); i += id[0].length; continue; }
    const op = /^(==|!=|<=|>=|&&|\|\||[<>!+\-*/])/.exec(src.slice(i));
    if (op) { out.push({ kind: 'op', text: op[0] }); i += op[0].length; continue; }
    throw new Error(`molang: unexpected '${c}' in ${src}`);
  }
  return out;
}

/** Compile a permutation condition. Throws on anything outside the supported slice. */
export function compileCondition(src: string): Condition {
  const t = tokenize(src);
  let i = 0;
  const peek = (): Token | undefined => t[i];
  const take = (): Token => { const k = t[i++]; if (!k) throw new Error(`molang: unexpected end of ${src}`); return k; };
  const isOp = (text: string): boolean => peek()?.kind === 'op' && peek()!.text === text;
  const primary = (): Condition => {
    const k = take();
    if (k.kind === 'num') { const v = Number(k.text); return () => v; }
    if (k.kind === 'str') return () => k.text;
    if (k.kind === 'lp') { const e = or(); if (take().kind !== 'rp') throw new Error(`molang: missing ) in ${src}`); return e; }
    if (k.kind === 'op' && k.text === '!') { const e = primary(); return s => !e(s); }
    if (k.kind === 'op' && k.text === '-') { const e = primary(); return s => -Number(e(s)); }
    if (k.kind === 'id') {
      const name = k.text.toLowerCase();
      if (name === 'true') return () => true;
      if (name === 'false') return () => false;
      if (name === 'q.block_state' || name === 'query.block_state') {
        if (take().kind !== 'lp') throw new Error(`molang: expected ( after ${k.text}`);
        const arg = take();
        if (arg.kind !== 'str') throw new Error(`molang: block_state takes a string in ${src}`);
        if (take().kind !== 'rp') throw new Error(`molang: missing ) in ${src}`);
        return s => { const v = s[arg.text]; return v === undefined ? 0 : v; };
      }
      throw new Error(`molang: unsupported identifier ${k.text} in ${src}`);
    }
    throw new Error(`molang: unexpected ${k.text} in ${src}`);
  };
  const eq = (a: Value, b: Value): boolean => (typeof a === 'boolean' || typeof b === 'boolean') ? Boolean(a) === Boolean(b) : a == b; // eslint-disable-line eqeqeq
  const compare = (): Condition => {
    let left = primary();
    while (peek()?.kind === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(peek()!.text)) {
      const op = take().text, l = left, r = primary();
      left = op === '==' ? s => eq(l(s), r(s)) : op === '!=' ? s => !eq(l(s), r(s))
        : op === '<' ? s => Number(l(s)) < Number(r(s)) : op === '>' ? s => Number(l(s)) > Number(r(s))
        : op === '<=' ? s => Number(l(s)) <= Number(r(s)) : s => Number(l(s)) >= Number(r(s));
    }
    return left;
  };
  const and = (): Condition => {
    let left = compare();
    while (isOp('&&')) { take(); const l = left, r = compare(); left = s => Boolean(l(s)) && Boolean(r(s)); }
    return left;
  };
  const or = (): Condition => {
    let left = and();
    while (isOp('||')) { take(); const l = left, r = and(); left = s => Boolean(l(s)) || Boolean(r(s)); }
    return left;
  };
  const out = or();
  if (i !== t.length) throw new Error(`molang: trailing tokens in ${src}`);
  return out;
}
