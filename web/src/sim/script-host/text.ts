/**
 * Text as the game shows it: a `RawMessage` / string / array flattened to the
 * line a player reads (translation keys shown as their key), and the form
 * renderer's deletion of a bare `%` (quirk `form-deletes-percent`).
 */

/** Flatten a Script API message (`string | RawMessage | (string | RawMessage)[]`) to its text. */
export function messageText(m: unknown): string {
  if (m === undefined || m === null) return '';
  if (typeof m === 'string') return m;
  if (typeof m === 'number' || typeof m === 'boolean') return String(m);
  if (Array.isArray(m)) return m.map(messageText).join('');
  const r = m as { text?: string; rawtext?: unknown[]; translate?: string; with?: unknown };
  if (typeof r.text === 'string') return r.text;
  if (Array.isArray(r.rawtext)) return r.rawtext.map(messageText).join('');
  if (typeof r.translate === 'string') return `{${r.translate}}`;
  return String(m);
}

/** Minecraft's `§` formatting codes removed (what the line reads as, not how it is coloured). */
export const plainText = (s: string): string => s.replace(/§./g, '');

/** What the form renderer DRAWS for a string: a bare `%` is deleted (quirk `form-deletes-percent`). */
export const formRendered = (s: string): string => s.replace(/%/g, '');
