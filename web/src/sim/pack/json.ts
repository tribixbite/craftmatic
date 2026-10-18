/**
 * JSON as Bedrock reads it: the parsed value AND the source text of every
 * number. `JSON.parse` forgets whether `0` was written `0` or `0.0`, but
 * Bedrock does not: a `float` actor property whose default is the integer
 * literal `0` is rejected ("'default' value does not match the specified type
 * 'float'") and the entity loses its whole property component (CLAUDE.md,
 * `bedrockFloat()`). The pack validator needs the literal to say so.
 */

/** A parsed document and the literal of each number, by JSON pointer (`/a/0/b`). */
export interface JsonWithLiterals {
  value: unknown;
  /** The source text of the number at a pointer, or undefined. */
  numberLiterals: Map<string, string>;
}

/** Parse strict JSON, keeping each number's literal text. Throws a SyntaxError on bad input, as `JSON.parse` does. */
export function parseJsonWithLiterals(text: string): JsonWithLiterals {
  const literals = new Map<string, string>();
  let i = 0;
  const ws = (): void => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  const fail = (what: string): never => { throw new SyntaxError(`JSON: ${what} at ${i}`); };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    if (i >= text.length) fail('unterminated string');
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (path: string): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; const out: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws(); if (text[i] !== '"') fail('expected a key');
        const k = str(); ws();
        if (text[i] !== ':') fail('expected :');
        i++;
        out[k] = value(`${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`);
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return out; }
        fail('expected , or }');
      }
    }
    if (c === '[') {
      i++; const out: unknown[] = [];
      ws();
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value(`${path}/${out.length}`));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return out; }
        fail('expected , or ]');
      }
    }
    if (c === '"') return str();
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (m) { i += m[0].length; literals.set(path, m[0]); return Number(m[0]); }
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    return fail('unexpected character');
  };
  const out = value('');
  ws();
  if (i !== text.length) fail('trailing characters');
  return { value: out, numberLiterals: literals };
}

/** Whether a number literal is written as an integer (no `.` and no exponent): what Bedrock refuses for a float. */
export const isIntegerLiteral = (literal: string | undefined): boolean => literal !== undefined && !/[.eE]/.test(literal);
