/**
 * Reading a pack script's embedded configuration: a generated runtime carries
 * its data as `const CONFIG = {...};` in front of its code. The walk preview,
 * the CLIs and the simulator's adapters all read it with this one scanner.
 */

/**
 * Take the first balanced `{...}` JSON object that follows `marker` in a
 * script — the pack's `const CONFIG = ` literal. A JSON-aware scan (strings
 * and escapes respected) because the collider runs use every character from
 * `(` upward, braces included.
 */
export function extractJsonAfter(source: string, marker: string): unknown {
  const at = source.indexOf(marker);
  if (at < 0) return undefined;
  const start = source.indexOf('{', at + marker.length);
  if (start < 0) return undefined;
  let depth = 0, inString = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return JSON.parse(source.slice(start, i + 1));
    }
  }
  return undefined;
}
