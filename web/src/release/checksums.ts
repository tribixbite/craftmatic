/**
 * SHA256SUMS in GNU coreutils format (D-08, BIZ-56): `<64 hex>  <name>` per line, two spaces (text mode), sorted by
 * name, LF endings, so `sha256sum -c SHA256SUMS` accepts it unchanged. Pure: callers hand in the bytes.
 */
import { createHash } from 'node:crypto';

/** Lowercase hex sha256 of `data`. */
export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

/** One file of a release: its path relative to the release folder (forward slashes) and its bytes. */
export interface SumInput { name: string; data: Uint8Array }

/** A parsed SHA256SUMS line. */
export interface SumEntry { sha256: string; name: string }

/** Names a `sha256sum -c` line can carry unescaped: no backslash, no newline, no leading `*` (binary marker). */
const SAFE_NAME = /^[^\\\n*][^\\\n]*$/;

/** The text of a SHA256SUMS file for `files`, sorted by name (byte order, locale independent). */
export function sha256sumsText(files: readonly SumInput[]): string {
  const names = new Set<string>();
  const lines = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(f => {
    if (!SAFE_NAME.test(f.name)) throw new RangeError(`cannot list ${JSON.stringify(f.name)} in SHA256SUMS: backslash, newline or leading * in a name`);
    if (names.has(f.name)) throw new RangeError(`duplicate name in SHA256SUMS: ${f.name}`);
    names.add(f.name);
    return `${sha256Hex(f.data)}  ${f.name}`;
  });
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** Parse a SHA256SUMS text; throws on a line that is not `<64 hex>  <name>`. */
export function parseSha256sums(text: string): SumEntry[] {
  return text.split('\n').filter(l => l !== '').map(line => {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) throw new RangeError(`not a SHA256SUMS line: ${JSON.stringify(line)}`);
    return { sha256: m[1]!, name: m[2]! };
  });
}

/** Names whose bytes disagree with the sums, or that are listed and missing (empty = every file verifies). */
export function verifySums(entries: readonly SumEntry[], read: (name: string) => Uint8Array | undefined): string[] {
  return entries.flatMap(e => {
    const data = read(e.name);
    if (!data) return [`${e.name}: missing`];
    return sha256Hex(data) === e.sha256 ? [] : [`${e.name}: sha256 differs`];
  });
}
